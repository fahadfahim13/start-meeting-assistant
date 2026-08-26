import type { CaptureConfig, QualityProfile } from '@shared/schemas/capture'
import { QUALITY_PROFILES } from '@shared/schemas/capture'
import type { Capabilities, EncoderId } from '@shared/schemas/devices'
import { AppError } from '@shared/errors'

/**
 * Builds the ffmpeg argv for a recording session.
 *
 * Never a command string — always an argv array consumed with shell:false
 * (SECURITY.md T5). Device names arrive schema-length-limited and are passed
 * as discrete elements.
 *
 * Track layout (ADR-007 — mic and system audio are NEVER mixed):
 *   v:0 screen   v:1 camera(optional)   a:0 mic   a:1 system
 *
 * PCM transport: spike 2 proved the loopback bridge over stdin (B-006), but a
 * bounded -t recording needs no stop command. Interactive stop does: ffmpeg's
 * graceful shutdown is the 'q' command on stdin, and stdin cannot carry both.
 * So system audio comes in over a named pipe (\\.\pipe\..., current-user DACL)
 * and stdin is reserved for control. Same bytes, same format, different fd.
 */

export interface BuildInput {
  config: CaptureConfig
  capabilities: Capabilities
  /**
   * Where the encoded output goes — resolved by main, never renderer-supplied.
   * `single`: one file (spikes, tests). `segments`: crash-safe chunked output —
   * each segment is independently playable (`reset_timestamps 1`, so the concat
   * demuxer can stack them without double-offsetting).
   */
  output:
    | { kind: 'single'; path: string }
    | { kind: 'segments'; pattern: string; startNumber: number; segmentTimeS: number }
  /** Named pipe path carrying s16le 48k stereo PCM; null when systemAudio is off. */
  pcmPipePath: string | null
}

export interface BuiltCommand {
  args: string[]
  encoder: EncoderId
  /** Indices for diagnostics/tests. */
  trackLayout: { screen: boolean; camera: boolean; mic: boolean; system: boolean }
}

/** The chain each encoder needs between ddagrab and itself (MISTAKES.md M-001). */
function screenFilter(encoder: EncoderId, displayIndex: number, fps: number): string {
  const src = `ddagrab=${displayIndex}:framerate=${fps}`
  switch (encoder) {
    case 'h264_amf':
      // AMF consumes d3d11 NV12 surfaces; the explicit conversion is mandatory.
      return `${src},hwdownload,format=bgra,format=nv12,hwupload[vscreen]`
    case 'h264_nvenc':
    case 'h264_qsv':
      return `${src},hwdownload,format=bgra,format=nv12[vscreen]`
    case 'libx264':
    case 'libx264_ultrafast':
      return `${src},hwdownload,format=bgra[vscreen]`
  }
}

function encoderArgs(encoder: EncoderId, bitrateK: number): string[] {
  switch (encoder) {
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-b:v', `${bitrateK}k`]
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', `${bitrateK}k`]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-b:v', `${bitrateK}k`]
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateK}k`]
    case 'libx264_ultrafast':
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${bitrateK}k`]
  }
}

export function pickEncoder(caps: Capabilities): EncoderId {
  const first = caps.workingEncoders[0]
  if (!first) throw new AppError('CAPTURE_ENCODER_FAILED', 'capability probe found no working encoder')
  return first
}

export function buildCaptureArgs(input: BuildInput): BuiltCommand {
  const { config, capabilities, output, pcmPipePath } = input
  const profile: QualityProfile = QUALITY_PROFILES[config.preset]
  const encoder = pickEncoder(capabilities)

  const args: string[] = ['-hide_banner', '-loglevel', 'info', '-y']

  // ddagrab requires the d3d11 device before any input is opened.
  const usesDdagrab = config.screen !== null && config.screen.kind === 'screen' && capabilities.ddagrabWorks
  if (usesDdagrab) args.push('-init_hw_device', 'd3d11va')

  // ---- inputs (indices tracked as we go) ----------------------------------
  let inputIndex = 0
  let micInput = -1
  let systemInput = -1
  let cameraInput = -1
  let windowInput = -1

  // NOTE on alignment: each input's t=0 is its own open moment, so the mic
  // and system tracks carry a relative offset measured at ~120-230 ms on
  // REF-01 (mic lags, direction stable; sync harness). A wallclock-timestamp
  // experiment to unify the clocks BROKE the recording outright (M-010) and
  // was reverted. Correction is a Phase 2 item; the offset is documented in
  // docs/risks.md R-11.
  if (config.microphone) {
    args.push(
      '-f', 'dshow',
      '-thread_queue_size', '4096',
      '-audio_buffer_size', '50',
      '-i', `audio=${config.microphone.dshowName}`,
    )
    micInput = inputIndex++
  }

  if (config.systemAudio && pcmPipePath) {
    args.push(
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-thread_queue_size', '4096',
      '-i', pcmPipePath,
    )
    systemInput = inputIndex++
  }

  if (config.camera) {
    args.push(
      '-f', 'dshow',
      '-thread_queue_size', '1024',
      '-rtbufsize', '64M',
      '-i', `video=${config.camera.dshowName}`,
    )
    cameraInput = inputIndex++
  }

  // Window capture is a plain gdigrab input rather than a lavfi source.
  if (config.screen && config.screen.kind === 'window') {
    if (!config.screen.windowTitle) {
      throw new AppError('DEVICE_NOT_FOUND', 'window capture requested without a window title')
    }
    args.push(
      '-f', 'gdigrab',
      '-framerate', String(profile.screenFps),
      '-i', `title=${config.screen.windowTitle}`,
    )
    windowInput = inputIndex++
  }

  // ---- filters ------------------------------------------------------------
  const filters: string[] = []
  let screenLabel: string | null = null

  if (config.screen) {
    if (config.screen.kind === 'screen') {
      if (!usesDdagrab) {
        if (!capabilities.gdigrabWorks) {
          throw new AppError('CAPTURE_ENCODER_FAILED', 'neither ddagrab nor gdigrab is available')
        }
        // gdigrab desktop fallback comes in as its own input instead.
        args.push('-f', 'gdigrab', '-framerate', String(profile.screenFps), '-i', 'desktop')
        windowInput = inputIndex++
        screenLabel = `${windowInput}:v`
      } else {
        filters.push(screenFilter(encoder, config.screen.displayIndex ?? 0, profile.screenFps))
        screenLabel = 'vscreen'
      }
    } else {
      screenLabel = `${windowInput}:v`
    }
  }

  if (cameraInput >= 0) {
    // Same M-001 rule as the screen chain, second instance (see M-007): the
    // camera frames must arrive in the encoder's input format. Hardware
    // encoders take system-memory NV12; libx264 wants yuv420p.
    const camFormat = encoder === 'libx264' || encoder === 'libx264_ultrafast' ? 'yuv420p' : 'nv12'
    filters.push(
      `[${cameraInput}:v]fps=${profile.cameraFps},scale=-2:480,format=${camFormat}[vcam]`,
    )
  }

  if (filters.length) args.push('-filter_complex', filters.join(';'))

  // ---- mapping + encoding -------------------------------------------------
  const layout = {
    screen: screenLabel !== null,
    camera: cameraInput >= 0,
    mic: micInput >= 0,
    system: systemInput >= 0,
  }

  if (screenLabel) {
    args.push('-map', screenLabel.includes(':') ? screenLabel : `[${screenLabel}]`)
  }
  if (cameraInput >= 0) args.push('-map', '[vcam]')

  if (screenLabel || cameraInput >= 0) {
    args.push(...encoderArgs(encoder, profile.screenBitrateK))
  }

  if (micInput >= 0) args.push('-map', `${micInput}:a`)
  if (systemInput >= 0) args.push('-map', `${systemInput}:a`)
  if (micInput >= 0 || systemInput >= 0) {
    args.push('-c:a', 'libopus', '-b:a', `${profile.audioBitrateK}k`)
  }

  // Self-describing track titles (ffprobe output stays readable — B-006).
  let v = 0
  if (screenLabel) args.push(`-metadata:s:v:${v++}`, 'title=Screen')
  if (cameraInput >= 0) args.push(`-metadata:s:v:${v}`, 'title=Camera')
  let a = 0
  if (micInput >= 0) args.push(`-metadata:s:a:${a++}`, 'title=Microphone')
  if (systemInput >= 0) args.push(`-metadata:s:a:${a}`, 'title=System Audio')

  if (output.kind === 'single') {
    args.push(output.path)
  } else {
    args.push(
      '-f', 'segment',
      '-segment_format', 'matroska',
      '-segment_time', String(output.segmentTimeS),
      '-reset_timestamps', '1',
      '-segment_start_number', String(output.startNumber),
      output.pattern,
    )
  }

  return { args, encoder, trackLayout: layout }
}
