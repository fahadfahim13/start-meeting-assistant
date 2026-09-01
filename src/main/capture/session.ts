import { desktopCapturer, screen as electronScreen } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdirSync, statSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CaptureConfig, SessionStatus, ValidationResult } from '@shared/schemas/capture'
import { QUALITY_PROFILES } from '@shared/schemas/capture'
import type { QualityPreset } from '@shared/schemas/capture'
import { AppError } from '@shared/errors'
import { probeCapabilities } from '@main/platform/capability-probe'
import { resolveBinary, resolveResource } from '@main/platform/binaries'
import * as meetings from '@main/db/repositories/meetings'
import { classifyLevel, describeLevel } from '@shared/audio-levels'
import { getSettings } from '@main/db/repositories/settings'
import {
  currentRootKind,
  recordingsRoot,
  relativizeMedia,
  resolveMedia,
  rootAvailable,
} from '@main/platform/storage'
import { log } from '@main/log'
import { buildCaptureArgs, MIC_FILTER, SYSTEM_FILTER } from './ffmpeg-builder'
import { pipGeometry, type PipGeometry } from './pip'
import { LoopbackBridge } from './loopback-bridge'
import { concatSegments, diskFreeBytes, measureTrackLevels, probeDurationS } from './media-tools'

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
/** ffmpeg reads one command per line from stdin. */
const NEWLINE = String.fromCharCode(10)

/**
 * Rough screen bitrate per preset, from measurement rather than a nominal
 * number — quality-based encoding has no target bitrate to quote.
 *
 * Measured on REF-01: a full `high` recording (1080p30 screen + camera + two
 * audio tracks) came out at 0.26 GB/h, against 3.40 GB/h for the old fixed
 * 6000k bitrate. These figures deliberately sit ABOVE what was observed, since
 * the number feeds a disk-space pre-flight and over-estimating is the safe
 * direction.
 *
 * It is only ever an estimate: with quality-based encoding the size follows how
 * much the screen actually moves, which is the entire reason it is smaller. A
 * static slide deck costs a fraction of a shared video call.
 */
const QP_MEASURED_KBPS: Record<QualityPreset, number> = {
  efficient: 120,
  balanced: 250,
  high: 450,
  archival: 2000,
}
/** 3 x 10 s: long enough to ride out a transient statfs, short enough to salvage. */
const DISK_PROBE_FAILURES_BEFORE_STOP = 3
/**
 * How early an ffmpeg death still counts as "the camera-overlay filter graph
 * did not build". A bad graph fails before the first frame; anything later is
 * a different problem and must not be blamed on the overlay.
 */
const PIP_FALLBACK_WINDOW_MS = 5000

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
  /**
   * ffmpeg's last words, kept after `run` is torn down. Without this the
   * finalize catch had nothing to log but "finalize failed" — which is how two
   * dead recordings produced a log file containing one line (M-022).
   */
  lastStderrTail: string[]
  /** Which tracks are currently muted; survives the pause/resume respawn. */
  muted: { mic: boolean; system: boolean }
  /**
   * The camera overlay this recording was started with, or null for none.
   *
   * Read from settings ONCE, at start(), and never again — every respawn
   * (pause/resume) reuses this. A setting changed mid-recording must not be
   * able to change what later segments contain, or the file would no longer
   * match the geometry recorded in capture_profile (M-031).
   */
  pip: { geometry: PipGeometry; maskPath: string } | null
  /** Set once if the overlay had to be abandoned, so it is not retried forever. */
  pipDegraded: boolean
  totalPcmDrops: number
  totalPcmBackpressure: number
  statusTimer: ReturnType<typeof setInterval>
  diskTimer: ReturnType<typeof setInterval>
}

export class SessionManager {
  private active: ActiveSession | null = null
  private lastError: string | null = null
  /** Findings about the most recently finished recording (M-023). */
  private lastWarnings: string[] = []
  /** Consecutive failed disk probes; see diskGuard(). */
  private diskProbeFailures = 0

  constructor(private events: SessionEvents) {}

  /** Where new recordings go — the configured folder, or the default. */
  recordingsDir(): string {
    return recordingsRoot()
  }

  /**
   * Physical height of the surface being captured, for sizing the overlay.
   *
   * desktopCapturer screen ids are `screen:<display id>:0`, so the display can
   * be recovered exactly rather than by position in a list — the ordering caveat
   * on `displayIndex` (R-06) does not apply here. Electron reports DIP, ddagrab
   * captures physical pixels, hence the scaleFactor.
   *
   * Returns null for a window capture: a window's size is not knowable here and
   * a guess dressed up as a measurement is worse than an honest default (the
   * caller records which of the two it used).
   */
  private captureHeightPx(config: CaptureConfig): number | null {
    if (!config.screen || config.screen.kind !== 'screen') return null
    try {
      const displayId = config.screen.sourceId.split(':')[1]
      const displays = electronScreen.getAllDisplays()
      const match = displays.find((d) => String(d.id) === displayId)
      const target = match ?? electronScreen.getPrimaryDisplay()
      const height = Math.round(target.size.height * (target.scaleFactor || 1))
      return height > 0 ? height : null
    } catch {
      return null
    }
  }

  /**
   * The overlay this recording will use, resolved once. Null when the user has
   * it off, when there is nothing to composite onto or with, or when the mask
   * asset is missing — in every one of those cases the recording proceeds
   * exactly as it did before the feature existed (Principle 3).
   */
  private resolvePip(config: CaptureConfig): { geometry: PipGeometry; maskPath: string } | null {
    if (!config.screen || !config.camera) return null
    const settings = getSettings()
    const geometry = pipGeometry({
      position: settings.cameraOverlay,
      sizePct: settings.cameraOverlaySizePct,
      screenHeightPx: this.captureHeightPx(config),
    })
    if (!geometry) return null
    try {
      return { geometry, maskPath: resolveResource('pip-mask-16x9.png') }
    } catch (e) {
      log.warn('capture', 'camera overlay disabled: mask asset missing', { error: String(e) })
      return null
    }
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

    // A recordings folder that has gone away (unplugged drive, disconnected
    // share) is a blocking ERROR, not a warning: starting a recording into a
    // dead path loses it, and the recording is sacred (Principle 2).
    const root = rootAvailable()
    if (!root.ok) {
      errors.push(
        `The recordings folder is not writable right now: ${root.path}. Choose another folder in Settings, or reconnect the drive.`,
      )
    }

    const profile = QUALITY_PROFILES[config.preset]
    // With quality-based rate control there is no bitrate to add up, so the
    // estimate comes from measurement instead: REF-01, real screen capture,
    // video only. It is an estimate and the UI says so — actual size depends on
    // how much the screen moves, which is the whole point of using QP.
    const screenK = config.screen ? QP_MEASURED_KBPS[config.preset] : 0
    const cameraK = config.camera ? Math.round(screenK * 0.35) : 0
    // A camera burned into the screen track means that corner is never static,
    // and quality-based encoding spends bits exactly where things move.
    // Measured on REF-01, 20 s of 1080p15 with a moving source in the box:
    // 3.86 MB without the overlay, 4.73 MB with it — +23% on the screen track.
    const overlayK = this.resolvePip(config) ? Math.round(screenK * 0.23) : 0
    const audioK = profile.audioBitrateK * ((config.microphone ? 1 : 0) + (config.systemAudio ? 1 : 0))
    const estimatedBytesPerHour = Math.round(((screenK + cameraK + overlayK + audioK) * 1000 * 3600) / 8)

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

  /**
   * Re-resolve a window source immediately before recording (M-021).
   *
   * The title was captured when the picker enumerated sources, possibly minutes
   * ago, but gdigrab matches `title=` EXACTLY and has no HWND selector. A tab
   * switch, a save, an unread-count badge, a loading spinner in the title — and
   * the window ffmpeg is told to find no longer exists. The desktopCapturer id
   * (`window:<HWND>:<n>`) is stable across all of that, so it is the key and
   * the title is refreshed from it.
   */
  private async resolveWindowSource(config: CaptureConfig): Promise<CaptureConfig> {
    const screen = config.screen
    if (!screen || screen.kind !== 'window') return config

    const sources = await desktopCapturer.getSources({
      types: ['window'],
      // Small but non-zero: an empty thumbnail is how a minimised window
      // announces itself, and that is worth knowing before we record it.
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    })
    const match = sources.find((s) => s.id === screen.sourceId)
    if (!match) {
      throw new AppError(
        'DEVICE_NOT_FOUND',
        `The window "${screen.label ?? screen.windowTitle ?? 'you selected'}" is no longer open. Pick it again.`,
      )
    }

    if (match.thumbnail.isEmpty()) {
      // Not fatal: the chain now pads up to the encoder floor, so this records
      // successfully — it just records almost nothing useful. Say so rather
      // than hand back a black rectangle without comment.
      this.lastWarnings.push(
        'The selected window looks minimised. Restore it before recording, or the capture will be a blank strip.',
      )
    }

    if (match.name === screen.windowTitle) return config
    // Deliberately not logging either title: window titles carry document and
    // conversation names.
    log.info('capture', 'window title changed since selection — re-resolved from source id')
    return { ...config, screen: { ...screen, windowTitle: match.name } }
  }

  async start(config: CaptureConfig): Promise<string> {
    if (this.active) throw new AppError('CAPTURE_ALREADY_ACTIVE')
    const validation = await this.validate(config)
    if (!validation.ok) throw new AppError('CAPTURE_FFMPEG_SPAWN', validation.errors.join(' '))

    this.lastWarnings = []
    config = await this.resolveWindowSource(config)

    const meetingId = randomUUID()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const baseName = `${stamp}_${meetingId.slice(0, 8)}`
    const segmentDir = path.join(this.recordingsDir(), baseName)
    mkdirSync(segmentDir, { recursive: true })

    const caps = await probeCapabilities()
    const encoder = caps.workingEncoders[0] ?? 'none'
    // Resolved once, here, and carried on the session from now on (M-031).
    const pip = this.resolvePip(config)

    meetings.createMeeting({
      id: meetingId,
      title: config.title,
      mediaPath: relativizeMedia(segmentDir).relative, // becomes the file on finalize
      mediaRoot: currentRootKind(),
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
        // What was burned into v:0, in the pixels it was burned at. The visual
        // pipeline reads this to mask the region back out before scene
        // detection, so it must describe the file rather than the setting.
        cameraOverlay: pip?.geometry ?? null,
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
      // Segments stay .mkv regardless; only the finished file takes this
      // extension. A half-written MP4 is unplayable — its index lives at the
      // end — which is exactly the case crash recovery exists for.
      finalPath: path.join(this.recordingsDir(), `${baseName}.${getSettings().outputFormat}`),
      phase: 'recording',
      run: null,
      nextSegmentNumber: 0,
      currentSegmentDbId: null,
      startedAt: Date.now(),
      accumulatedMs: 0,
      runStartedAt: null,
      encoder,
      lastStderrTail: [],
      muted: { mic: false, system: false },
      pip,
      pipDegraded: false,
      totalPcmDrops: 0,
      totalPcmBackpressure: 0,
      statusTimer: setInterval(() => this.events.onStatus(this.status()), 1000),
      diskTimer: setInterval(() => void this.diskGuard(), DISK_GUARD_INTERVAL_MS),
    }
    this.active = session
    this.lastError = null
    this.diskProbeFailures = 0
    // NB: lastWarnings is cleared at the TOP of start(), not here —
    // resolveWindowSource() may already have added one.

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
      // Carried back in so resuming does not silently un-mute a track.
      muted: session.muted,
      // From the session snapshot, never from settings — see ActiveSession.pip.
      pip: session.pip,
    })
    session.encoder = built.encoder

    const ffmpeg = spawn(resolveBinary('ffmpeg'), built.args, {
      shell: false, // invariant — argv arrays only (SECURITY.md T5)
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    log.info('capture', 'ffmpeg spawned', {
      meetingId: session.meetingId,
      encoder: built.encoder,
      layout: built.trackLayout,
      segmentFrom: session.nextSegmentNumber,
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

    ffmpeg.on('error', (e) => {
      log.error('capture', 'ffmpeg failed to spawn', {
        meetingId: session.meetingId,
        encoder: built.encoder,
        error: e.message,
      })
      this.fail(`ffmpeg spawn error: ${e.message}`)
    })
    ffmpeg.on('exit', (code) => {
      if (this.active === session && session.run === run && session.phase === 'recording' && code !== 0 && code !== null) {
        // Degrade, never break (Principle 3). A filter graph either builds or
        // it does not, so an early death with the overlay on is worth one retry
        // without it — and that retry is SAFE only because the overlay does not
        // change the stream count, so the segments either side of it still
        // concatenate (M-011). A failure an hour in is not the graph; it falls
        // through to the normal failure path.
        const ranMs = session.runStartedAt ? Date.now() - session.runStartedAt : 0
        if (session.pip && !session.pipDegraded && ranMs < PIP_FALLBACK_WINDOW_MS) {
          log.warn('capture', 'camera overlay failed — retrying without it', {
            meetingId: session.meetingId,
            code,
            ranMs,
            stderrTail: run.stderrTail.slice(-10),
          })
          session.pip = null
          session.pipDegraded = true
          run.bridge?.destroy()
          session.lastStderrTail = run.stderrTail.slice(-20)
          this.finalizeCurrentSegment(session)
          session.accumulatedMs += ranMs
          session.runStartedAt = null
          session.run = null
          this.lastWarnings.push(
            'The camera could not be placed on the screen — it was recorded as its own separate track instead. The recording itself is fine.',
          )
          void this.spawnRun(session).catch((e) => this.fail(String(e)))
          return
        }
        // The stderr tail is the whole diagnosis. `frame= 0 ... Conversion
        // failed!` is what a rejected video chain looks like (M-021), and
        // before this it went nowhere at all (M-022).
        log.error('capture', 'ffmpeg exited mid-recording', {
          meetingId: session.meetingId,
          code,
          encoder: built.encoder,
          layout: built.trackLayout,
          stderrTail: run.stderrTail.slice(-15),
        })
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
      // Relative to whichever root this recording is being written under, so
      // a custom folder outside userData does not produce a '..' path that the
      // containment guard would (correctly) refuse.
      path: relativizeMedia(absPath).relative,
      startedAt: Date.now(),
    })
    session.nextSegmentNumber = seq + 1
  }

  private finalizeCurrentSegment(session: ActiveSession): void {
    if (!session.currentSegmentDbId) return
    const rows = meetings.segmentsFor(session.meetingId)
    const row = rows.find((r) => r.id === session.currentSegmentDbId)
    if (row) {
      const abs = resolveMedia({ media_root: currentRootKind(), media_path: row.path })
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
      log.warn('capture', 'ffmpeg ignored q — killing (last resort)', {
        meetingId: session.meetingId,
        stderrTail: run.stderrTail.slice(-5),
      })
      run.ffmpeg.kill()
      await exited
    }
    run.bridge?.destroy()
    session.lastStderrTail = run.stderrTail.slice(-20)
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

      await concatSegments(segFiles, session.finalPath, getSettings().outputFormat)
      const durationS = await probeDurationS(session.finalPath)
      if (durationS === null) throw new Error('concatenated file is not playable')

      const bytes = statSync(session.finalPath).size
      meetings.finalizeMeeting(
        session.meetingId,
        relativizeMedia(session.finalPath).relative,
        bytes,
        Math.round(durationS * 1000),
      )
      // Only after the final file verifiably exists do the segments go.
      rmSync(session.segmentDir, { recursive: true, force: true })

      await this.checkAudioLevels(session)

      // A success line is what makes the NEXT failure readable: without a
      // known-good baseline in the log there is nothing to compare against.
      log.info('capture', 'session finalized', {
        meetingId: session.meetingId,
        encoder: session.encoder,
        durationMs: Math.round(durationS * 1000),
        bytes,
        segments: segFiles.length,
        pcmDrops: session.totalPcmDrops,
        warnings: this.lastWarnings.length,
      })
    } catch (e) {
      // Segments stay on disk; recovery can pick them up.
      meetings.setMeetingState(session.meetingId, 'failed')
      log.error('capture', 'finalize failed', {
        meetingId: session.meetingId,
        error: String(e).slice(0, 500),
        segmentDir: path.basename(session.segmentDir),
        stderrTail: session.lastStderrTail.slice(-10),
      })
      this.fail(`finalize failed: ${String(e)} — segments kept in ${path.basename(session.segmentDir)}`)
      return this.status()
    }

    const status = this.status()
    this.active = null
    this.events.onStatus(this.status())
    this.events.onStopped?.(session.finalPath, session.meetingId)
    return { ...status, state: 'idle' }
  }

  /**
   * Measure the finished recording's audio and turn silence into a sentence
   * (M-023). This is the moment the user is still present and still remembers
   * what they did; an hour later, staring at an empty transcript, they cannot
   * reconstruct that their headphones moved the loopback endpoint.
   *
   * Never throws. A measurement failure must not downgrade a good recording.
   */
  /**
   * Mute or unmute a track WHILE recording.
   *
   * ffmpeg's interactive mode accepts a filter command on stdin — the same
   * channel that carries 'q' for a graceful stop. Verified on REF-01:
   * `cvolume@mic -1 volume 0` takes a live track from -21 dB to -91 dB with no
   * respawn. The `c` must not be followed by a space; with one, ffmpeg replies
   * "at least 3 arguments were expected, only 0 given".
   *
   * The track is never removed, only silenced: every segment has to carry the
   * same streams or the lossless concat cannot join them (M-011).
   */
  setMuted(track: 'mic' | 'system', muted: boolean): SessionStatus {
    const session = this.active
    if (!session) throw new AppError('CAPTURE_NOT_ACTIVE')
    const present = track === 'mic' ? session.config.microphone !== null : session.config.systemAudio
    if (!present) {
      throw new AppError('DEVICE_NOT_FOUND', `this recording has no ${track} track to mute`)
    }

    session.muted[track] = muted
    const filter = track === 'mic' ? MIC_FILTER : SYSTEM_FILTER
    const run = session.run
    if (run && !run.ffmpeg.killed) {
      try {
        run.ffmpeg.stdin.write(`cvolume@${filter} -1 volume ${muted ? 0 : 1}` + NEWLINE)
      } catch (e) {
        // Recording continues regardless — a failed mute must not end a session.
        log.warn('capture', 'mute command could not be delivered', {
          meetingId: session.meetingId,
          track,
          error: String(e).slice(0, 200),
        })
      }
    }
    log.info('capture', 'track mute changed', { meetingId: session.meetingId, track, muted })
    this.events.onStatus(this.status())
    return this.status()
  }

  private async checkAudioLevels(session: ActiveSession): Promise<void> {
    const tracks: ('mic' | 'system')[] = []
    if (session.config.microphone) tracks.push('mic')
    if (session.config.systemAudio) tracks.push('system')
    if (tracks.length === 0) return

    try {
      const levels = await measureTrackLevels(session.finalPath, tracks.length)
      levels.forEach((measured, i) => {
        const track = tracks[i]
        if (!track) return
        const level = classifyLevel(measured)
        if (level === 'ok') return
        const message = describeLevel(level, track)
        if (message) this.lastWarnings.push(message)
        log.warn('capture', 'audio track carries no usable signal', {
          meetingId: session.meetingId,
          track,
          // NOT `level` — that is the log envelope's own field.
          audioLevel: level,
          meanVolumeDb: measured.meanVolumeDb,
          maxVolumeDb: measured.maxVolumeDb,
        })
      })
    } catch (e) {
      log.warn('capture', 'audio level measurement failed', { error: String(e).slice(0, 200) })
    }
  }

  // ---- guards & plumbing --------------------------------------------------

  private async diskGuard(): Promise<void> {
    const session = this.active
    if (!session || session.phase !== 'recording') return
    try {
      const free = await diskFreeBytes(this.recordingsDir())
      this.diskProbeFailures = 0
      if (free < STORAGE_FLOOR_BYTES) {
        log.warn('capture', 'disk floor reached — auto-stopping to protect the recording', {
          meetingId: session.meetingId,
          freeBytes: free,
          floorBytes: STORAGE_FLOOR_BYTES,
        })
        this.lastError = 'Recording stopped automatically: disk space fell below the safety floor.'
        await this.stop()
      }
    } catch (e) {
      // A single statfs failure is genuinely transient and must stay harmless.
      // A RUN of them is not: it is a removable drive pulled or a network share
      // dropped, and every further second of recording is being written into
      // nothing. Salvage what exists rather than discovering it at stop
      // (Principle 2 — the recording is sacred).
      this.diskProbeFailures++
      if (this.diskProbeFailures >= DISK_PROBE_FAILURES_BEFORE_STOP) {
        log.error('capture', 'recordings folder unreachable — auto-stopping to salvage the recording', {
          meetingId: session.meetingId,
          consecutiveFailures: this.diskProbeFailures,
          error: String(e).slice(0, 200),
        })
        this.lastError =
          'Recording stopped automatically: the recordings folder became unreachable. What was captured up to that point has been saved.'
        this.diskProbeFailures = 0
        await this.stop()
      }
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
      mutedMic: s?.muted.mic ?? false,
      mutedSystem: s?.muted.system ?? false,
      error: this.lastError,
      warnings: [...this.lastWarnings],
    }
  }

  private fail(message: string): void {
    log.error('capture', 'session failed', {
      meetingId: this.active?.meetingId ?? null,
      encoder: this.active?.encoder ?? null,
      detail: message.slice(0, 800),
    })
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
