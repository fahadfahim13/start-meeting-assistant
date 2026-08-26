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

// A second launch focuses the existing window instead of racing on state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  let mainWindow: Electron.BrowserWindow | null = null

  const sessions = new SessionManager({
    onStatus(status) {
      mainWindow?.webContents.send('session:state', status)
      updateTray(status)
    },
    onStopped(outputPath) {
      if (process.env['MEETFROGE_AUTOREC']) void verifyAndExit(outputPath)
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
