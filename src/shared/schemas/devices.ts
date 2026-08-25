import { z } from 'zod'

// Device names come from the OS and are attacker-influenceable (a malicious virtual
// device can call itself anything), so every string that will later become an ffmpeg
// argv element is length-limited here at the schema boundary.
const deviceString = z.string().min(1).max(256)

export const CameraDeviceSchema = z.object({
  /** WebRTC deviceId — unstable across some driver updates, so label is kept too. */
  deviceId: deviceString,
  label: deviceString,
  /** DirectShow name ffmpeg needs; resolved by the reconciliation table, null if unmatched. */
  dshowName: deviceString.nullable(),
  isVirtual: z.boolean(),
})
export type CameraDevice = z.infer<typeof CameraDeviceSchema>

export const MicrophoneDeviceSchema = z.object({
  deviceId: deviceString,
  label: deviceString,
  dshowName: deviceString.nullable(),
})
export type MicrophoneDevice = z.infer<typeof MicrophoneDeviceSchema>

export const ScreenSourceSchema = z.object({
  /** Electron desktopCapturer id, e.g. "screen:0:0" or "window:123:0". */
  id: deviceString,
  name: deviceString,
  kind: z.enum(['screen', 'window']),
  /** Monitor index for ddagrab output selection; null for windows. */
  displayIndex: z.number().int().min(0).max(15).nullable(),
  width: z.number().int().positive().max(16384).nullable(),
  height: z.number().int().positive().max(16384).nullable(),
  /** data: URL thumbnail for the picker grid. */
  thumbnailDataUrl: z.string().max(2_000_000).nullable(),
})
export type ScreenSource = z.infer<typeof ScreenSourceSchema>

export const DeviceInventorySchema = z.object({
  cameras: z.array(CameraDeviceSchema).max(32),
  microphones: z.array(MicrophoneDeviceSchema).max(32),
  screens: z.array(ScreenSourceSchema).max(64),
})
export type DeviceInventory = z.infer<typeof DeviceInventorySchema>

export const EncoderIdSchema = z.enum([
  'h264_amf',
  'h264_nvenc',
  'h264_qsv',
  'libx264',
  'libx264_ultrafast',
])
export type EncoderId = z.infer<typeof EncoderIdSchema>

export const CapabilitiesSchema = z.object({
  /** Encoders that passed a REAL 1-second probe encode, best first. Never trust -encoders. */
  workingEncoders: z.array(EncoderIdSchema),
  ddagrabWorks: z.boolean(),
  gdigrabWorks: z.boolean(),
  ffmpegVersion: z.string().max(64).nullable(),
  probedAt: z.number().int(),
  /** How long the full probe took — used to decide whether to cache aggressively. */
  probeDurationMs: z.number().int(),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>
