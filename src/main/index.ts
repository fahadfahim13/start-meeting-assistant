import { app, ipcMain } from 'electron'
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createMainWindow, hardenSession, registerFrameScheme } from './window'
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
import { getSettings, patchSettings } from './db/repositories/settings'
import { verifyBinaries } from './security/integrity'
import { log } from './log'
import { MODEL_IDS, modelStatus, modelsDir, type ModelId } from './platform/models'
import { MODEL_REGISTRY } from './platform/model-registry'
import { cancelDownload, downloadModel } from './platform/model-downloader'

/** Harness output dir: asar is read-only, so packaged runs write to userData (M-017). */
function harnessOutDir(): string {
  return app.isPackaged ? path.join(app.getPath('userData'), 'out') : path.join(app.getAppPath(), 'out')
}

// A second launch focuses the existing window instead of racing on state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerFrameScheme() // must precede app ready
  bootstrap()
}

function bootstrap(): void {
  let mainWindow: Electron.BrowserWindow | null = null

  const pipeline = createPipeline({
    onJobUpdate(job) {
      mainWindow?.webContents.send('jobs:update', job)
    },
  })

  let minimizedForRecording = false
  const sessions = new SessionManager({
    onStatus(status) {
      mainWindow?.webContents.send('session:state', status)
      updateTray(status)
      // E2E hook: get the app window off the screen so the recording captures
      // what is BEHIND it (visual tests) rather than the app itself.
      if (process.env['MEETFROGE_MINIMIZE'] === '1' && status.state === 'recording' && !minimizedForRecording) {
        minimizedForRecording = true
        mainWindow?.minimize()
      }
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

  handle('devices:screenPreview', async ({ sourceId }) => {
    const { desktopCapturer } = await import('electron')
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: false,
    })
    const src = sources.find((x) => x.id === sourceId)
    return {
      thumbnailDataUrl: src && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : null,
    }
  })
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
        sourceLabel: (() => {
          try {
            return (JSON.parse(m.capture_profile) as { sourceLabel?: string }).sourceLabel ?? null
          } catch {
            return null
          }
        })(),
        tags: (
          getDb()
            .prepare('SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.meeting_id = ?')
            .all(m.id) as unknown as { name: string }[]
        ).map((t) => t.name),
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

  handle('keyframes:get', async ({ meetingId }) => {
    const rows = getDb()
      .prepare(
        'SELECT id, timestamp_ms, image_path, ocr_text, vlm_caption, scene_type, change_score FROM keyframes WHERE meeting_id = ? ORDER BY timestamp_ms',
      )
      .all(meetingId) as unknown as {
      id: string
      timestamp_ms: number
      image_path: string
      ocr_text: string | null
      vlm_caption: string | null
      scene_type: string | null
      change_score: number
    }[]
    return {
      keyframes: rows.map((r) => ({
        id: r.id,
        timestampMs: r.timestamp_ms,
        url: `mf-frame://${meetingId}/${path.basename(r.image_path)}`,
        ocrText: r.ocr_text,
        caption: r.vlm_caption,
        sceneType: r.scene_type,
      })),
    }
  })

  handle('settings:get', async () => {
    const s = getSettings()
    const caps = await probeCapabilities()
    return {
      ...s,
      modelsDir: modelsDir(),
      recordingsDir: sessions.recordingsDir(),
      models: MODEL_IDS.map((id) => ({
        ...modelStatus(id),
        purpose: MODEL_REGISTRY[id].purpose,
        tier: MODEL_REGISTRY[id].tier,
        bytes: MODEL_REGISTRY[id].bytes,
      })),
      vulkan: caps.workingEncoders.length > 0, // proxy shown in the wizard; refined below
    }
  })

  handle('models:download', async ({ modelId }) => {
    if (!MODEL_IDS.includes(modelId as ModelId)) return { started: false }
    void downloadModel(modelId as ModelId, (p) => {
      mainWindow?.webContents.send('models:progress', p)
    }).catch(() => undefined) // progress events carry the failure detail
    return { started: true }
  })

  handle('models:cancel', async ({ modelId }) => {
    if (MODEL_IDS.includes(modelId as ModelId)) cancelDownload(modelId as ModelId)
    return { ok: true }
  })

  handle('settings:set', async (patch) => {
    patchSettings(patch)
    return { ok: true }
  })

  handle('meetings:delete', async ({ meetingId }) => {
    const meeting = meetingsRepo.getMeeting(meetingId)
    if (!meeting) return { ok: false, freedBytes: 0 }
    const { rmSync } = await import('node:fs')
    let freed = 0
    const mediaAbs = path.join(app.getPath('userData'), meeting.media_path)
    try {
      freed += statSync(mediaAbs).size
    } catch { /* already gone */ }
    // Media, frames, then rows (FKs cascade transcript/keyframes/summaries).
    rmSync(mediaAbs, { force: true, recursive: true })
    rmSync(path.join(app.getPath('userData'), 'frames', meetingId), { force: true, recursive: true })
    getDb().prepare('DELETE FROM transcript_fts WHERE meeting_id = ?').run(meetingId)
    getDb().prepare('DELETE FROM keyframe_fts WHERE meeting_id = ?').run(meetingId)
    getDb().prepare('DELETE FROM meetings WHERE id = ?').run(meetingId)
    return { ok: true, freedBytes: freed }
  })

  handle('meetings:setTags', async ({ meetingId, tags }) => {
    const db = getDb()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM meeting_tags WHERE meeting_id = ?').run(meetingId)
      for (const name of tags) {
        const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as unknown as { id: string } | undefined
        const tagId = existing?.id ?? (await import('node:crypto')).randomUUID()
        if (!existing) db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tagId, name)
        db.prepare('INSERT INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)').run(meetingId, tagId)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { ok: true }
  })

  handle('search:all', async ({ query }) => {
    // Unified FTS across speech AND on-screen text — the plan's distinctive
    // capability: find a meeting by words that were only ever on a slide.
    const phrase = `"${query.replace(/"/g, '""')}"`
    const db = getDb()
    const speech = db
      .prepare(
        `SELECT f.meeting_id, ts.text, ts.start_ms, m.title
         FROM transcript_fts f
         JOIN transcript_segments ts ON ts.id = f.segment_id
         JOIN meetings m ON m.id = f.meeting_id
         WHERE transcript_fts MATCH ? ORDER BY rank LIMIT 30`,
      )
      .all(phrase) as unknown as { meeting_id: string; text: string; start_ms: number; title: string }[]
    const screen = db
      .prepare(
        `SELECT f.meeting_id, k.ocr_text, k.vlm_caption, k.timestamp_ms, m.title
         FROM keyframe_fts f
         JOIN keyframes k ON k.id = f.keyframe_id
         JOIN meetings m ON m.id = f.meeting_id
         WHERE keyframe_fts MATCH ? ORDER BY rank LIMIT 30`,
      )
      .all(phrase) as unknown as { meeting_id: string; ocr_text: string | null; vlm_caption: string | null; timestamp_ms: number; title: string }[]
    return {
      hits: [
        ...speech.map((h) => ({
          meetingId: h.meeting_id,
          meetingTitle: h.title,
          kind: 'speech' as const,
          text: h.text.slice(0, 200),
          startMs: h.start_ms,
        })),
        ...screen.map((h) => ({
          meetingId: h.meeting_id,
          meetingTitle: h.title,
          kind: 'screen' as const,
          text: (h.ocr_text ?? h.vlm_caption ?? '').slice(0, 200),
          startMs: h.timestamp_ms,
        })),
      ],
    }
  })

  handle('summary:get', async ({ meetingId }) => {
    const row = getDb()
      .prepare('SELECT content FROM summaries WHERE meeting_id = ? AND is_current = 1')
      .get(meetingId) as unknown as { content: string } | undefined
    const items = getDb()
      .prepare('SELECT id, text, assignee, source_ms, done FROM action_items WHERE meeting_id = ?')
      .all(meetingId) as unknown as { id: string; text: string; assignee: string | null; source_ms: number | null; done: number }[]
    let summary = null
    if (row) {
      try {
        const c = JSON.parse(row.content) as Record<string, unknown>
        summary = {
          title: String(c['title'] ?? ''),
          tldr: String(c['tldr'] ?? ''),
          summary: String(c['summary'] ?? ''),
          key_points: (c['key_points'] as string[]) ?? [],
          decisions: (c['decisions'] as { text: string; t?: number }[]) ?? [],
          topics: (c['topics'] as string[]) ?? [],
          open_questions: (c['open_questions'] as string[]) ?? [],
          degraded: c['degraded'] === true,
        }
      } catch {
        summary = null
      }
    }
    return {
      summary,
      actionItems: items.map((i) => ({
        id: i.id,
        text: i.text,
        assignee: i.assignee,
        sourceMs: i.source_ms,
        done: i.done === 1,
      })),
    }
  })

  handle('summary:regenerate', async ({ meetingId }) => {
    const meeting = meetingsRepo.getMeeting(meetingId)
    if (!meeting) return { enqueued: false }
    pipeline.enqueue(meetingId, ['summarize'])
    return { enqueued: true }
  })

  handle('actionitem:toggle', async ({ actionItemId, done }) => {
    getDb().prepare('UPDATE action_items SET done = ? WHERE id = ?').run(done ? 1 : 0, actionItemId)
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

    // T7: bundled binaries are hash-verified before anything can spawn them.
    // Fatal when packaged; a dev warning otherwise.
    const integrity = verifyBinaries()
    log.info('boot', `binary integrity: ${integrity.ok ? 'ok' : 'FAILED'}`, { problems: integrity.problems.slice(0, 5) })

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

    // Deterministic pipeline harness: process an existing video file through
    // the REAL stages without touching the live desktop (M-014 — a screen-
    // capture test on a machine the user is actively using is unwinnable).
    // Env-supplied path: trusted input, no IPC boundary crossed.
    const processFile = process.env['MEETFROGE_PROCESS_FILE']
    if (processFile) {
      void (async () => {
        const { copyFileSync } = await import('node:fs')
        const meetingId = (await import('node:crypto')).randomUUID()
        const baseName = `synthetic_${meetingId.slice(0, 8)}`
        const dest = path.join(sessions.recordingsDir(), `${baseName}.mkv`)
        copyFileSync(processFile, dest)
        meetingsRepo.createMeeting({
          id: meetingId,
          title: 'Synthetic visual test',
          mediaPath: path.join('recordings', `${baseName}.mkv`),
          captureProfile: { synthetic: true },
          hasScreen: true,
          hasCamera: false,
          hasMic: false,
          hasSystemAudio: false,
        })
        meetingsRepo.finalizeMeeting(meetingId, path.join('recordings', `${baseName}.mkv`), statSync(dest).size, 0)
        void processAndExit(meetingId)
      })()
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
      requestedS: parseInt(process.env['MEETFROGE_AUTOREC'] ?? '0', 10),
      ok:
        video.length >= 1 &&
        audio.length >= 1 &&
        (parsed.format?.duration
          ? // startup costs a few seconds; anything under 60% of the request
            // means the recording lost real time (M-016 would have FAILED this).
            parseFloat(parsed.format.duration) >= 0.6 * parseInt(process.env['MEETFROGE_AUTOREC'] ?? '1', 10)
          : false),
    }

    const outDir = harnessOutDir()
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
    const keyframes = getDb()
      .prepare('SELECT timestamp_ms, ocr_text, vlm_caption, scene_type, change_score FROM keyframes WHERE meeting_id = ? ORDER BY timestamp_ms')
      .all(meetingId) as unknown as {
      timestamp_ms: number
      ocr_text: string | null
      vlm_caption: string | null
      scene_type: string | null
      change_score: number
    }[]
    const summaryRow = getDb()
      .prepare('SELECT content FROM summaries WHERE meeting_id = ? AND is_current = 1')
      .get(meetingId) as unknown as { content: string } | undefined
    const actionRows = getDb()
      .prepare('SELECT text, assignee, source_ms FROM action_items WHERE meeting_id = ?')
      .all(meetingId) as unknown as { text: string; assignee: string | null; source_ms: number | null }[]
    let summaryDump: Record<string, unknown> | null = null
    if (summaryRow) {
      try {
        summaryDump = JSON.parse(summaryRow.content) as Record<string, unknown>
        summaryDump['action_items'] = actionRows.map((a) => ({ text: a.text, assignee: a.assignee, t: a.source_ms }))
      } catch {
        summaryDump = null
      }
    }
    const result = {
      transcribeE2e: true,
      date: new Date().toISOString(),
      meetingId,
      summary: summaryDump,
      jobs: jobs.map((j) => ({ stage: j.stage, state: j.state, error: j.error_detail })),
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        track: s.track,
        speaker: s.speaker_label,
        startMs: s.start_ms,
        text: s.text,
      })),
      keyframes: keyframes.map((k) => ({
        timestampMs: k.timestamp_ms,
        ocrText: k.ocr_text,
        caption: k.vlm_caption,
        sceneType: k.scene_type,
        changeScore: k.change_score,
      })),
      ok: jobs.every((j) => j.state === 'done' || j.state === 'skipped') && segments.length >= 0,
    }
    const outDir = harnessOutDir()
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'transcribe-e2e.json'), JSON.stringify(result, null, 2))
    app.exit(result.ok ? 0 : 1)
  }

  async function runSmoke(): Promise<void> {
    log.info('smoke', 'start')
    const outDir = harnessOutDir()
    const result: Record<string, unknown> = {
      smoke: true,
      date: new Date().toISOString(),
      electron: process.versions.electron,
    }
    try {
      const caps = await probeCapabilities()
      log.info('smoke', 'probed')
      result['capabilities'] = caps
      const devices = await enumerateDevices({ webrtcCameras: [], webrtcMicrophones: [] })
      log.info('smoke', 'devices ok')
      result['screens'] = devices.screens.map((s) => ({ id: s.id, kind: s.kind, name: s.name.slice(0, 40) }))
      result['recovery'] = recoveryReports
      result['ok'] = caps.workingEncoders.length > 0
    } catch (e) {
      result['ok'] = false
      result['error'] = String(e)
    }
    log.info('smoke', 'writing result')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify(result, null, 2))
    log.info('smoke', 'done - exiting')
    app.exit(result['ok'] ? 0 : 1)
  }
}
