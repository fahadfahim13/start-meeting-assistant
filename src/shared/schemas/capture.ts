import { z } from 'zod'

export const QualityPresetSchema = z.enum(['efficient', 'balanced', 'high', 'archival'])
export type QualityPreset = z.infer<typeof QualityPresetSchema>

/** Concrete encode parameters a preset resolves to. */
export interface QualityProfile {
  screenMaxHeight: number
  screenFps: number
  /**
   * Quantizer, not bitrate. Lower is better quality and a bigger file; the
   * scale is h264's QP (roughly 18 = visually lossless, 40 = poor).
   *
   * Measured on REF-01, 8 s of real screen capture, video only:
   *   CBR 6000k @30fps -> 2.45 GB/h      QP 26 @30fps -> 0.53 GB/h
   *   CBR 3000k @15fps -> 1.31 GB/h      QP 30 @15fps -> 0.25 GB/h
   *                                      QP 34 @10fps -> 0.13 GB/h
   * A meeting screen is nearly static, so a fixed bitrate spends megabits per
   * second on frames that did not change. Quality-based rate control spends
   * what the content needs — 4.6x smaller at the SAME framerate and quality.
   */
  screenQp: number
  cameraEnabledDefault: boolean
  cameraFps: number
  cameraQp: number
  audioBitrateK: number
}

export const QUALITY_PROFILES: Record<QualityPreset, QualityProfile> = {
  efficient: {
    screenMaxHeight: 720,
    screenFps: 10,
    screenQp: 34,
    cameraEnabledDefault: false,
    cameraFps: 10,
    cameraQp: 32,
    audioBitrateK: 48,
  },
  balanced: {
    screenMaxHeight: 1080,
    screenFps: 15,
    screenQp: 30,
    cameraEnabledDefault: true,
    cameraFps: 15,
    cameraQp: 28,
    audioBitrateK: 64,
  },
  high: {
    screenMaxHeight: 1080,
    screenFps: 30,
    screenQp: 26,
    cameraEnabledDefault: true,
    cameraFps: 30,
    cameraQp: 25,
    audioBitrateK: 96,
  },
  archival: {
    screenMaxHeight: 4320,
    screenFps: 30,
    screenQp: 20,
    cameraEnabledDefault: true,
    cameraFps: 30,
    cameraQp: 20,
    audioBitrateK: 128,
  },
}

const deviceString = z.string().min(1).max(256)

// The renderer never sends filesystem paths — it sends this config; the main process
// resolves every path itself. See SECURITY.md T4.
export const CaptureConfigSchema = z.object({
  title: z.string().min(1).max(200),
  preset: QualityPresetSchema,
  screen: z
    .object({
      sourceId: deviceString,
      kind: z.enum(['screen', 'window']),
      displayIndex: z.number().int().min(0).max(15).nullable(),
      /** gdigrab needs the window title; screens do not use it. */
      windowTitle: z.string().max(512).nullable(),
      /** Human-readable source name — recorded into capture_profile so the
       *  summary can say what it came from. */
      label: z.string().max(256).nullable(),
    })
    .nullable(),
  camera: z.object({ dshowName: deviceString }).nullable(),
  microphone: z.object({ dshowName: deviceString }).nullable(),
  systemAudio: z.boolean(),
})
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>

export const SessionStateSchema = z.enum([
  'idle',
  'validating',
  'recording',
  'paused',
  'finalizing',
  'failed',
])
export type SessionState = z.infer<typeof SessionStateSchema>

export const SessionStatusSchema = z.object({
  state: SessionStateSchema,
  meetingId: z.string().nullable(),
  elapsedMs: z.number().int().min(0),
  bytesWritten: z.number().int().min(0),
  /** From the loopback ring: frames discarded because the ring was full. Must surface. */
  pcmDrops: z.number().int().min(0),
  pcmBackpressure: z.number().int().min(0),
  encoderInUse: z.string().max(32).nullable(),
  /** Live mute state. Muting silences a track; it never removes it (M-011). */
  mutedMic: z.boolean(),
  mutedSystem: z.boolean(),
  error: z.string().max(2000).nullable(),
  /**
   * Non-fatal findings about the recording that just finished — chiefly a track
   * that captured silence (M-020/M-023). The recording is fine and saved; the
   * user needs to know BEFORE they close the app and lose the context, because
   * the alternative is discovering an empty transcript an hour later with no
   * explanation. Principle 5.
   */
  warnings: z.array(z.string().max(500)).max(5),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20),
  errors: z.array(z.string().max(500)).max(20),
  estimatedBytesPerHour: z.number().int().min(0),
  diskFreeBytes: z.number().int().min(0),
})
export type ValidationResult = z.infer<typeof ValidationResultSchema>
