import { app } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CaptureConfig, SessionStatus, ValidationResult } from '@shared/schemas/capture'
import { QUALITY_PROFILES } from '@shared/schemas/capture'
import { AppError } from '@shared/errors'
import { probeCapabilities } from '@main/platform/capability-probe'
import { resolveBinary } from '@main/platform/binaries'
import { buildCaptureArgs } from './ffmpeg-builder'
import { LoopbackBridge } from './loopback-bridge'

/**
 * Recording session lifecycle. Phase 1 scope: validate → start → stop, one
 * session at a time, single-file output. Segmentation, pause/resume and crash
 * recovery land in Phase 2 on top of this.
 *
 * Principle 2: the recording is sacred. ffmpeg is stopped with the 'q' command
 * on stdin (graceful — MKV trailer is written), never a kill, except as a
 * last-resort timeout.
 */

const STORAGE_FLOOR_BYTES = 5 * 1024 ** 3 // hard floor: refuse to start below this
const STOP_GRACE_MS = 10_000

export interface SessionEvents {
  onStatus(status: SessionStatus): void
  /** Fires after a clean stop with the finalized file. */
  onStopped?(outputPath: string, meetingId: string): void
}

interface ActiveSession {
  meetingId: string
  config: CaptureConfig
  outputPath: string
  ffmpeg: ChildProcessByStdio<Writable, null, Readable>
  bridge: LoopbackBridge | null
  startedAt: number
  encoder: string
  stderrTail: string[]
  statusTimer: ReturnType<typeof setInterval>
}

export class SessionManager {
  private active: ActiveSession | null = null
  private lastError: string | null = null

  constructor(private events: SessionEvents) {}

  recordingsDir(): string {
    const dir = path.join(app.getPath('userData'), 'recordings')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async validate(config: CaptureConfig): Promise<ValidationResult> {
    const warnings: string[] = []
    const errors: string[] = []

    const caps = await probeCapabilities()
    if (caps.workingEncoders.length === 0) errors.push('No working video encoder found on this machine.')
    const first = caps.workingEncoders[0]
    if (first && first.startsWith('libx264')) {
      warnings.push('Hardware encoding unavailable — recording will use more CPU (software x264).')
    }
    if (!config.screen && !config.camera) errors.push('Select at least one video source (screen or camera).')
    if (!config.microphone && !config.systemAudio) warnings.push('No audio source selected — the recording will be silent.')
    if (config.screen?.kind === 'window') warnings.push('Minimizing the captured window will freeze its capture.')

    const profile = QUALITY_PROFILES[config.preset]
    const videoK = profile.screenBitrateK + (config.camera ? profile.cameraBitrateK : 0)
    const audioK = profile.audioBitrateK * ((config.microphone ? 1 : 0) + (config.systemAudio ? 1 : 0))
    const estimatedBytesPerHour = Math.round(((videoK + audioK) * 1000 * 3600) / 8)

    let diskFreeBytes = 0
    try {
      const { bavail, bsize } = await import('node:fs/promises').then((fs) => fs.statfs(this.recordingsDir()))
      diskFreeBytes = Number(bavail) * Number(bsize)
    } catch {
      warnings.push('Could not determine free disk space.')
    }
    if (diskFreeBytes > 0 && diskFreeBytes < STORAGE_FLOOR_BYTES) {
      errors.push(`Less than ${Math.round(STORAGE_FLOOR_BYTES / 1024 ** 3)} GB free — free up space before recording.`)
    }

    return { ok: errors.length === 0, warnings, errors, estimatedBytesPerHour, diskFreeBytes }
  }

  async start(config: CaptureConfig): Promise<string> {
    if (this.active) throw new AppError('CAPTURE_ALREADY_ACTIVE')
    const validation = await this.validate(config)
    if (!validation.ok) {
      throw new AppError('CAPTURE_FFMPEG_SPAWN', validation.errors.join(' '))
    }

    const meetingId = randomUUID()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outputPath = path.join(this.recordingsDir(), `${stamp}_${meetingId.slice(0, 8)}.mkv`)

    const caps = await probeCapabilities()
    let bridge: LoopbackBridge | null = null
    if (config.systemAudio) {
      bridge = new LoopbackBridge()
      await bridge.listen()
    }

    const built = buildCaptureArgs({
      config,
      capabilities: caps,
      outputPath,
      pcmPipePath: bridge?.pipePath ?? null,
    })

    console.log('[session] ffmpeg', built.args.map((a) => (a.includes(app.getPath('userData')) ? '<out>' : a)).join(' '))

    const ffmpeg = spawn(resolveBinary('ffmpeg'), built.args, {
      // argv array + no shell — invariant (SECURITY.md T5).
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    const session: ActiveSession = {
      meetingId,
      config,
      outputPath,
      ffmpeg,
      bridge,
      startedAt: Date.now(),
      encoder: built.encoder,
      stderrTail: [],
      statusTimer: setInterval(() => this.events.onStatus(this.status()), 1000),
    }
    this.active = session
    this.lastError = null

    ffmpeg.stderr.on('data', (d: Buffer) => {
      const lines = d.toString().split(/\r?\n/).filter((l) => l.trim())
      session.stderrTail.push(...lines)
      if (session.stderrTail.length > 60) session.stderrTail.splice(0, session.stderrTail.length - 60)
    })

    ffmpeg.on('error', (e) => this.fail(`ffmpeg spawn error: ${e.message}`))
    ffmpeg.on('exit', (code) => {
      if (this.active === session && code !== 0 && code !== null) {
        // Unexpected mid-recording exit. The file up to this point is still on
        // disk; surface the last stderr lines as the diagnosis.
        this.fail(`ffmpeg exited ${code}: ${session.stderrTail.slice(-5).join(' | ')}`)
      }
    })

    this.events.onStatus(this.status())
    return meetingId
  }

  /** Renderer PCM frames land here via the gateway. */
  pushPcm(frame: Buffer): void {
    this.active?.bridge?.push(frame)
  }

  async stop(): Promise<SessionStatus> {
    const session = this.active
    if (!session) throw new AppError('CAPTURE_NOT_ACTIVE')

    clearInterval(session.statusTimer)

    // 1. EOF the PCM stream so ffmpeg's pipe input ends cleanly.
    session.bridge?.end()

    // 2. Graceful stop: 'q' on stdin → ffmpeg finalizes the MKV trailer.
    const exited = new Promise<number | null>((resolve) => session.ffmpeg.once('exit', resolve))
    try {
      session.ffmpeg.stdin.write('q\n')
    } catch {
      /* stdin may already be closed if ffmpeg died */
    }

    const code = await Promise.race([
      exited,
      new Promise<null>((r) => setTimeout(() => r(null), STOP_GRACE_MS)),
    ])
    if (code === null && session.ffmpeg.exitCode === null) {
      console.warn('[session] ffmpeg ignored q for 10s — killing (last resort)')
      session.ffmpeg.kill()
      await exited
    }

    session.bridge?.destroy()
    const status = this.status()
    this.active = null
    this.events.onStatus(this.status())
    this.events.onStopped?.(session.outputPath, session.meetingId)
    return { ...status, state: 'idle' }
  }

  private fail(message: string): void {
    console.error('[session]', message)
    this.lastError = message
    const session = this.active
    if (session) {
      clearInterval(session.statusTimer)
      session.bridge?.destroy()
      this.active = null
    }
    this.events.onStatus(this.status())
  }

  status(): SessionStatus {
    const s = this.active
    let bytesWritten = 0
    if (s) {
      try {
        bytesWritten = statSync(s.outputPath).size
      } catch {
        /* file not created yet in the first moments */
      }
    }
    const bridgeStats = s?.bridge?.getStats()
    return {
      state: s ? 'recording' : this.lastError ? 'failed' : 'idle',
      meetingId: s?.meetingId ?? null,
      elapsedMs: s ? Date.now() - s.startedAt : 0,
      bytesWritten,
      pcmDrops: bridgeStats?.drops ?? 0,
      pcmBackpressure: bridgeStats?.backpressure ?? 0,
      encoderInUse: s?.encoder ?? null,
      error: this.lastError,
    }
  }

  /** App-quit safety: never leave an orphaned ffmpeg. */
  async dispose(): Promise<void> {
    if (this.active) {
      try {
        await this.stop()
      } catch {
        this.active?.ffmpeg.kill()
      }
    }
  }
}
