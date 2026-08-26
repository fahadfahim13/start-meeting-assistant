import { app } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdirSync, statSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CaptureConfig, SessionStatus, ValidationResult } from '@shared/schemas/capture'
import { QUALITY_PROFILES } from '@shared/schemas/capture'
import { AppError } from '@shared/errors'
import { probeCapabilities } from '@main/platform/capability-probe'
import { resolveBinary } from '@main/platform/binaries'
import * as meetings from '@main/db/repositories/meetings'
import { buildCaptureArgs } from './ffmpeg-builder'
import { LoopbackBridge } from './loopback-bridge'
import { concatSegments, diskFreeBytes, probeDurationS } from './media-tools'

/**
 * Recording session lifecycle (Phase 2 shape).
 *
 * Segmented output: each meeting records into its own directory as 5-minute,
 * independently playable segments — a crash costs at most one segment.
 * Pause is segment-based (ffmpeg has no native pause): the current process is
 * stopped gracefully with 'q', and resume spawns a new process continuing the
 * segment numbering. Stop concatenates everything losslessly into one MKV.
 *
 * Principle 2 throughout: 'q' first, kill only on a 10 s timeout; segment
 * files are only deleted after the concatenated file verifiably exists.
 */

const STORAGE_FLOOR_BYTES = 5 * 1024 ** 3
const STOP_GRACE_MS = 10_000
// Test hook: MEETFROGE_SEGTIME shrinks segments so crash tests do not need to
// run for 5 minutes to produce multiple segments. Clamped, defaults to 300.
const SEGMENT_TIME_S = Math.min(3600, Math.max(5, parseInt(process.env['MEETFROGE_SEGTIME'] ?? '300', 10) || 300))
const DISK_GUARD_INTERVAL_MS = 10_000

export interface SessionEvents {
  onStatus(status: SessionStatus): void
  /** Fires after a clean stop with the finalized, concatenated file. */
  onStopped?(outputPath: string, meetingId: string): void
}

type Phase = 'recording' | 'paused' | 'finalizing'

interface RunProcess {
  ffmpeg: ChildProcessByStdio<Writable, null, Readable>
  bridge: LoopbackBridge | null
  stderrTail: string[]
}

interface ActiveSession {
  meetingId: string
  config: CaptureConfig
  segmentDir: string
  finalPath: string
  phase: Phase
  run: RunProcess | null
  nextSegmentNumber: number
  currentSegmentDbId: string | null
  startedAt: number
  /** Recording time accumulated across completed runs (excludes pauses). */
  accumulatedMs: number
  runStartedAt: number | null
  encoder: string
  totalPcmDrops: number
  totalPcmBackpressure: number
  statusTimer: ReturnType<typeof setInterval>
  diskTimer: ReturnType<typeof setInterval>
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

  // ---- validation ---------------------------------------------------------

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

    let free = 0
    try {
      free = await diskFreeBytes(this.recordingsDir())
    } catch {
      warnings.push('Could not determine free disk space.')
    }
    if (free > 0 && free < STORAGE_FLOOR_BYTES) {
      errors.push(`Less than ${Math.round(STORAGE_FLOOR_BYTES / 1024 ** 3)} GB free — free up space before recording.`)
    }

    return { ok: errors.length === 0, warnings, errors, estimatedBytesPerHour, diskFreeBytes: free }
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(config: CaptureConfig): Promise<string> {
    if (this.active) throw new AppError('CAPTURE_ALREADY_ACTIVE')
    const validation = await this.validate(config)
    if (!validation.ok) throw new AppError('CAPTURE_FFMPEG_SPAWN', validation.errors.join(' '))

    const meetingId = randomUUID()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const baseName = `${stamp}_${meetingId.slice(0, 8)}`
    const segmentDir = path.join(this.recordingsDir(), baseName)
    mkdirSync(segmentDir, { recursive: true })

    const caps = await probeCapabilities()
    const encoder = caps.workingEncoders[0] ?? 'none'

    meetings.createMeeting({
      id: meetingId,
      title: config.title,
      mediaPath: path.join('recordings', baseName), // relative; becomes the file on finalize
      captureProfile: {
        preset: config.preset,
        encoder,
        segmentTimeS: SEGMENT_TIME_S,
        // Provenance: the summary names the source it was built from.
        sourceLabel: config.screen
          ? config.screen.kind === 'window'
            ? config.screen.windowTitle ?? config.screen.label
            : (config.screen.label ?? `Screen ${(config.screen.displayIndex ?? 0) + 1}`)
          : config.camera
            ? 'Camera only'
            : 'Audio only',
      },
      hasScreen: config.screen !== null,
      hasCamera: config.camera !== null,
      hasMic: config.microphone !== null,
      hasSystemAudio: config.systemAudio,
    })

    const session: ActiveSession = {
      meetingId,
      config,
      segmentDir,
      finalPath: path.join(this.recordingsDir(), `${baseName}.mkv`),
      phase: 'recording',
      run: null,
      nextSegmentNumber: 0,
      currentSegmentDbId: null,
      startedAt: Date.now(),
      accumulatedMs: 0,
      runStartedAt: null,
      encoder,
      totalPcmDrops: 0,
      totalPcmBackpressure: 0,
      statusTimer: setInterval(() => this.events.onStatus(this.status()), 1000),
      diskTimer: setInterval(() => void this.diskGuard(), DISK_GUARD_INTERVAL_MS),
    }
    this.active = session
    this.lastError = null

    try {
      await this.spawnRun(session)
    } catch (e) {
      this.fail(String(e))
      throw e
    }

    this.events.onStatus(this.status())
    return meetingId
  }

  private async spawnRun(session: ActiveSession): Promise<void> {
    const caps = await probeCapabilities()

    let bridge: LoopbackBridge | null = null
    if (session.config.systemAudio) {
      bridge = new LoopbackBridge()
      await bridge.listen()
    }

    const built = buildCaptureArgs({
      config: session.config,
      capabilities: caps,
      output: {
        kind: 'segments',
        pattern: path.join(session.segmentDir, 'seg_%03d.mkv'),
        startNumber: session.nextSegmentNumber,
        segmentTimeS: SEGMENT_TIME_S,
      },
      pcmPipePath: bridge?.pipePath ?? null,
    })
    session.encoder = built.encoder

    const ffmpeg = spawn(resolveBinary('ffmpeg'), built.args, {
      shell: false, // invariant — argv arrays only (SECURITY.md T5)
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    const run: RunProcess = { ffmpeg, bridge, stderrTail: [] }
    session.run = run
    session.runStartedAt = Date.now()

    ffmpeg.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        run.stderrTail.push(line)
        if (run.stderrTail.length > 60) run.stderrTail.shift()
        // The segment muxer announces each new file — that is our segment ledger.
        const m = /Opening '(.+?seg_(\d+)\.mkv)' for writing/.exec(line)
        if (m) this.onSegmentOpened(session, m[1]!, parseInt(m[2]!, 10))
      }
    })

    ffmpeg.on('error', (e) => this.fail(`ffmpeg spawn error: ${e.message}`))
    ffmpeg.on('exit', (code) => {
      if (this.active === session && session.run === run && session.phase === 'recording' && code !== 0 && code !== null) {
        this.fail(`ffmpeg exited ${code}: ${run.stderrTail.slice(-5).join(' | ')}`)
      }
    })
  }

  private onSegmentOpened(session: ActiveSession, absPath: string, seq: number): void {
    // Finalize the previous segment row now that the muxer moved on.
    this.finalizeCurrentSegment(session)
    session.currentSegmentDbId = meetings.addSegment({
      meetingId: session.meetingId,
      seq,
      path: path.relative(app.getPath('userData'), absPath),
      startedAt: Date.now(),
    })
    session.nextSegmentNumber = seq + 1
  }

  private finalizeCurrentSegment(session: ActiveSession): void {
    if (!session.currentSegmentDbId) return
    const rows = meetings.segmentsFor(session.meetingId)
    const row = rows.find((r) => r.id === session.currentSegmentDbId)
    if (row) {
      const abs = path.join(app.getPath('userData'), row.path)
      let bytes = 0
      try {
        bytes = statSync(abs).size
      } catch {
        /* not yet flushed */
      }
      meetings.finalizeSegment(row.id, bytes, null)
    }
    session.currentSegmentDbId = null
  }

  /** Gracefully end the current ffmpeg run ('q' → trailer written). */
  private async endRun(session: ActiveSession): Promise<void> {
    const run = session.run
    if (!run) return
    run.bridge?.end()
    const stats = run.bridge?.getStats()
    if (stats) {
      session.totalPcmDrops += stats.drops
      session.totalPcmBackpressure += stats.backpressure
    }

    const exited = new Promise<number | null>((resolve) => run.ffmpeg.once('exit', resolve))
    try {
      run.ffmpeg.stdin.write('q\n')
    } catch {
      /* already dead */
    }
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), STOP_GRACE_MS))])
    if (code === null && run.ffmpeg.exitCode === null) {
      console.warn('[session] ffmpeg ignored q — killing (last resort)')
      run.ffmpeg.kill()
      await exited
    }
    run.bridge?.destroy()
    this.finalizeCurrentSegment(session)
    if (session.runStartedAt) session.accumulatedMs += Date.now() - session.runStartedAt
    session.runStartedAt = null
    session.run = null
  }

  async pause(): Promise<SessionStatus> {
    const session = this.active
    if (!session || session.phase !== 'recording') throw new AppError('CAPTURE_NOT_ACTIVE')
    session.phase = 'paused'
    await this.endRun(session)
    meetings.setMeetingState(session.meetingId, 'paused')
    this.events.onStatus(this.status())
    return this.status()
  }

  async resume(): Promise<SessionStatus> {
    const session = this.active
    if (!session || session.phase !== 'paused') throw new AppError('CAPTURE_NOT_ACTIVE', 'no paused session')
    session.phase = 'recording'
    await this.spawnRun(session)
    meetings.setMeetingState(session.meetingId, 'recording')
    this.events.onStatus(this.status())
    return this.status()
  }

  async stop(): Promise<SessionStatus> {
    const session = this.active
    if (!session) throw new AppError('CAPTURE_NOT_ACTIVE')

    clearInterval(session.statusTimer)
    clearInterval(session.diskTimer)
    session.phase = 'finalizing'
    meetings.setMeetingState(session.meetingId, 'finalizing')
    this.events.onStatus(this.status())

    await this.endRun(session)

    try {
      const segFiles = readdirSync(session.segmentDir)
        .filter((f) => /^seg_\d+\.mkv$/.test(f))
        .sort()
        .map((f) => path.join(session.segmentDir, f))
      if (segFiles.length === 0) throw new Error('no segments were written')

      await concatSegments(segFiles, session.finalPath)
      const durationS = await probeDurationS(session.finalPath)
      if (durationS === null) throw new Error('concatenated file is not playable')

      meetings.finalizeMeeting(
        session.meetingId,
        path.relative(app.getPath('userData'), session.finalPath),
        statSync(session.finalPath).size,
        Math.round(durationS * 1000),
      )
      // Only after the final file verifiably exists do the segments go.
      rmSync(session.segmentDir, { recursive: true, force: true })
    } catch (e) {
      // Segments stay on disk; recovery can pick them up.
      meetings.setMeetingState(session.meetingId, 'failed')
      this.fail(`finalize failed: ${String(e)} — segments kept in ${path.basename(session.segmentDir)}`)
      return this.status()
    }

    const status = this.status()
    this.active = null
    this.events.onStatus(this.status())
    this.events.onStopped?.(session.finalPath, session.meetingId)
    return { ...status, state: 'idle' }
  }

  // ---- guards & plumbing --------------------------------------------------

  private async diskGuard(): Promise<void> {
    const session = this.active
    if (!session || session.phase !== 'recording') return
    try {
      const free = await diskFreeBytes(this.recordingsDir())
      if (free < STORAGE_FLOOR_BYTES) {
        console.warn('[session] disk floor reached — auto-stopping to protect the recording')
        this.lastError = 'Recording stopped automatically: disk space fell below the safety floor.'
        await this.stop()
      }
    } catch {
      /* transient statfs failure — next tick */
    }
  }

  pushPcm(frame: Buffer): void {
    this.active?.run?.bridge?.push(frame)
  }

  status(): SessionStatus {
    const s = this.active
    let bytesWritten = 0
    if (s) {
      try {
        for (const f of readdirSync(s.segmentDir)) {
          bytesWritten += statSync(path.join(s.segmentDir, f)).size
        }
      } catch {
        /* dir may already be cleaned up */
      }
      if (existsSync(s.finalPath)) {
        try {
          bytesWritten = statSync(s.finalPath).size
        } catch {
          /* ignore */
        }
      }
    }
    const runStats = s?.run?.bridge?.getStats()
    const elapsedMs = s
      ? s.accumulatedMs + (s.runStartedAt ? Date.now() - s.runStartedAt : 0)
      : 0
    return {
      state: s ? (s.phase === 'finalizing' ? 'finalizing' : s.phase) : this.lastError ? 'failed' : 'idle',
      meetingId: s?.meetingId ?? null,
      elapsedMs,
      bytesWritten,
      pcmDrops: (s?.totalPcmDrops ?? 0) + (runStats?.drops ?? 0),
      pcmBackpressure: (s?.totalPcmBackpressure ?? 0) + (runStats?.backpressure ?? 0),
      encoderInUse: s?.encoder ?? null,
      error: this.lastError,
    }
  }

  private fail(message: string): void {
    console.error('[session]', message)
    this.lastError = message
    const session = this.active
    if (session) {
      clearInterval(session.statusTimer)
      clearInterval(session.diskTimer)
      session.run?.bridge?.destroy()
      try {
        meetings.setMeetingState(session.meetingId, 'failed')
      } catch {
        /* db may be unavailable */
      }
      this.active = null
    }
    this.events.onStatus(this.status())
  }

  async dispose(): Promise<void> {
    if (this.active) {
      try {
        await this.stop()
      } catch {
        this.active?.run?.ffmpeg.kill()
      }
    }
  }
}
