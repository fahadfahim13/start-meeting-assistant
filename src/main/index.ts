import { app, ipcMain } from 'electron'
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createMainWindow, hardenSession } from './window'
import { handle } from './ipc/gateway'
import { enumerateDevices } from './capture/devices'
import { probeCapabilities } from './platform/capability-probe'
import { SessionManager } from './capture/session'
import { recoverInterrupted, type RecoveryReport } from './capture/recovery'
import { getDb, closeDb } from './db'
import { initTray, updateTray, destroyTray } from './tray'
import { createPipeline, PROCESSING_STAGES } from './pipeline'
import { renderTranscript } from './pipeline/export'
import * as meetingsRepo from './db/repositories/meetings'
import * as transcriptsRepo from './db/repositories/transcripts'

// A second launch focuses the existing window instead of racing on state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  let mainWindow: Electron.BrowserWindow | null = null

  const pipeline = createPipeline({
    onJobUpdate(job) {
      mainWindow?.webContents.send('jobs:update', job)
    },
  })

  const sessions = new SessionManager({
    onStatus(status) {
      mainWindow?.webContents.send('session:state', status)
      updateTray(status)
    },
    onStopped(outputPath, meetingId) {
      // Auto-process on stop (default on). E2E harnesses take over the verdict:
      // AUTOPROCESS runs the full pipeline and dumps the transcript; plain
      // AUTOREC verifies the recording only.
      if (process.env['MEETFROGE_AUTOREC']) {
        if (process.env['MEETFROGE_AUTOPROCESS'] === '1') void processAndExit(meetingId)
        else void verifyAndExit(outputPath)
        return
      }
      pipeline.enqueue(meetingId, PROCESSING_STAGES)
    },
  })

  // ---- IPC (allowlisted + validated by the gateway) ------------------------
  handle('devices:enumerate', (payload) => enumerateDevices(payload))
  handle('devices:probeCapabilities', ({ force }) => probeCapabilities(force))
  handle('session:validate', (config) => sessions.validate(config))
  handle('session:start', async (config) => ({ meetingId: await sessions.start(config) }))
  handle('session:pause', () => sessions.pause())
  handle('session:resume', () => sessions.resume())
  handle('session:stop', () => sessions.stop())
  handle('session:status', async () => sessions.status())

  handle('meetings:list', async ({ limit }) => {
    const rows = getDb()
      .prepare(`SELECT * FROM meetings WHERE state IN ('ready','recovered','failed') ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as unknown as meetingsRepo.MeetingRow[]
    return {
      items: rows.map((m) => ({
        id: m.id,
        title: m.title,
        startedAt: m.started_at,
        durationMs: m.duration_ms,
        state: m.state,
        bytes: m.media_bytes,
        jobs: pipeline.jobsFor(m.id).map((j) => ({ stage: j.stage, state: j.state, progress: j.progress })),
      })),
    }
  })

  handle('meetings:process', async ({ meetingId }) => {
    const meeting = meetingsRepo.getMeeting(meetingId)
    if (!meeting) return { enqueued: false }
    pipeline.enqueue(meetingId, PROCESSING_STAGES)
    return { enqueued: true }
  })

  handle('transcript:get', async ({ meetingId }) => ({
    segments: transcriptsRepo.transcriptFor(meetingId).map((r) => ({
      id: r.id,
      startMs: r.start_ms,
      endMs: r.end_ms,
      speaker: r.speaker_label ?? null,
      speakerId: r.speaker_id,
      certain: r.speaker_certain === 1,
      track: r.track,
      text: r.text,
    })),
  }))

  handle('transcript:search', async ({ query }) => ({
    hits: transcriptsRepo.searchTranscripts(query).map((h) => ({
      meetingId: h.meeting_id,
      segmentId: h.segment_id,
      text: h.text,
      startMs: h.start_ms,
    })),
  }))

  handle('transcript:export', async ({ meetingId, format }) => {
    const meeting = meetingsRepo.getMeeting(meetingId)
    if (!meeting) return { saved: false, fileName: null }
    const rows = transcriptsRepo.transcriptFor(meetingId)
    const content = renderTranscript(format, rows, meeting.title)

    const { dialog } = await import('electron')
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${meeting.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (canceled || !filePath) return { saved: false, fileName: null }
    writeFileSync(filePath, content, 'utf8')
    return { saved: true, fileName: path.basename(filePath) }
  })

  handle('jobs:retry', async ({ jobId }) => {
    pipeline.retry(jobId)
    return { ok: true }
  })

  handle('speakers:rename', async ({ speakerId, displayName }) => {
    transcriptsRepo.renameSpeaker(speakerId, displayName)
    return { ok: true }
  })

  // Real-time PCM path: fire-and-forget, length-checked, only while recording.
  ipcMain.on('loopback:frame', (_event, buffer: ArrayBuffer) => {
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.byteLength <= 192_000) {
      sessions.pushPcm(Buffer.from(buffer))
    }
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  let recoveryReports: RecoveryReport[] = []

  app.whenReady().then(async () => {
    hardenSession()

    // DB up + crash recovery BEFORE anything can start a new session.
    try {
      getDb()
      recoveryReports = await recoverInterrupted()
      // Jobs a crash left 'running' go back to 'pending'; then resume work.
      pipeline.resetInterrupted()
      void pipeline.pump()
    } catch (e) {
      console.error('[db] startup failed:', e)
    }

    mainWindow = createMainWindow()
    initTray(mainWindow)

    // Probe in the background after first paint; results are cached.
    void probeCapabilities().then((caps) => {
      console.log(
        `[probe] encoders: ${caps.workingEncoders.join(', ') || 'NONE'} ` +
          `(ddagrab=${caps.ddagrabWorks} gdigrab=${caps.gdigrabWorks}, ${caps.probeDurationMs}ms)`,
      )
    })

    // Smoke mode (M-004: Electron has no stdout on Windows — assert on files
    // and exit codes). Boots, probes, writes a status file, quits.
    if (process.env['MEETFROGE_SMOKE'] === '1') {
      void runSmoke()
    }
  })

  app.on('window-all-closed', () => {
    void sessions.dispose().then(() => {
      destroyTray()
      closeDb()
      app.quit()
    })
  })

  app.on('before-quit', () => {
    void sessions.dispose()
  })

  /**
   * E2E verdict for MEETFROGE_AUTOREC runs: ffprobe the finalized file and
   * write out/e2e.json (M-004 — files and exit codes, never stdout).
   */
  async function verifyAndExit(outputPath: string): Promise<void> {
    const { execFile } = await import('node:child_process')
    const { resolveBinary } = await import('./platform/binaries')

    const probe = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        execFile(resolveBinary('ffprobe'), args, { timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (_e, stdout) =>
          resolve(stdout ?? ''),
        )
      })

    const streamsRaw = await probe(['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', outputPath])
    const lastPts = async (spec: string): Promise<number | null> => {
      const out = await probe(['-v', 'error', '-select_streams', spec, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', outputPath])
      const lines = out.trim().split(/\r?\n/).filter(Boolean)
      const last = lines[lines.length - 1]
      if (!last) return null
      const v = parseFloat(last.replace(/,\s*$/, ''))
      return Number.isFinite(v) ? +v.toFixed(3) : null
    }

    let parsed: { streams?: { codec_type?: string; codec_name?: string }[]; format?: { duration?: string } } = {}
    try {
      parsed = JSON.parse(streamsRaw)
    } catch {
      /* leave empty */
    }
    const audio = (parsed.streams ?? []).filter((s) => s.codec_type === 'audio')
    const video = (parsed.streams ?? []).filter((s) => s.codec_type === 'video')
    const micEnd = audio.length > 0 ? await lastPts('a:0') : null
    const sysEnd = audio.length > 1 ? await lastPts('a:1') : null

    const result = {
      e2e: true,
      date: new Date().toISOString(),
      file: path.basename(outputPath),
      bytes: (() => {
        try {
          return statSync(outputPath).size
        } catch {
          return 0
        }
      })(),
      durationS: parsed.format?.duration ? +parseFloat(parsed.format.duration).toFixed(3) : null,
      videoTracks: video.length,
      audioTracks: audio.length,
      micLastPts: micEnd,
      systemLastPts: sysEnd,
      micVsSystemMs: micEnd != null && sysEnd != null ? Math.round(Math.abs(micEnd - sysEnd) * 1000) : null,
      ok: video.length >= 1 && audio.length >= 1 && (parsed.format?.duration ? parseFloat(parsed.format.duration) > 1 : false),
    }

    const outDir = path.join(app.getAppPath(), 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'e2e.json'), JSON.stringify(result, null, 2))
    app.exit(result.ok ? 0 : 1)
  }

  /** Transcription E2E: run the pipeline on the finished meeting, dump results. */
  async function processAndExit(meetingId: string): Promise<void> {
    pipeline.enqueue(meetingId, PROCESSING_STAGES)
    const terminal = new Set(['done', 'failed', 'cancelled', 'skipped'])
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      const jobs = pipeline.jobsFor(meetingId)
      if (jobs.length > 0 && jobs.every((j) => terminal.has(j.state))) break
    }
    const jobs = pipeline.jobsFor(meetingId)
    const segments = transcriptsRepo.transcriptFor(meetingId)
    const result = {
      transcribeE2e: true,
      date: new Date().toISOString(),
      meetingId,
      jobs: jobs.map((j) => ({ stage: j.stage, state: j.state, error: j.error_detail })),
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        track: s.track,
        speaker: s.speaker_label,
        startMs: s.start_ms,
        text: s.text,
      })),
      ok: jobs.every((j) => j.state === 'done' || j.state === 'skipped') && segments.length > 0,
    }
    const outDir = path.join(app.getAppPath(), 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'transcribe-e2e.json'), JSON.stringify(result, null, 2))
    app.exit(result.ok ? 0 : 1)
  }

  async function runSmoke(): Promise<void> {
    const outDir = path.join(app.getAppPath(), 'out')
    const result: Record<string, unknown> = {
      smoke: true,
      date: new Date().toISOString(),
      electron: process.versions.electron,
    }
    try {
      const caps = await probeCapabilities()
      result['capabilities'] = caps
      const devices = await enumerateDevices({ webrtcCameras: [], webrtcMicrophones: [] })
      result['screens'] = devices.screens.map((s) => ({ id: s.id, kind: s.kind, name: s.name.slice(0, 40) }))
      result['recovery'] = recoveryReports
      result['ok'] = caps.workingEncoders.length > 0
    } catch (e) {
      result['ok'] = false
      result['error'] = String(e)
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify(result, null, 2))
    app.exit(result['ok'] ? 0 : 1)
  }
}
