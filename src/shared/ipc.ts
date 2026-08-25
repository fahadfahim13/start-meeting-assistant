import { z } from 'zod'
import { CapabilitiesSchema, DeviceInventorySchema } from './schemas/devices'
import {
  CaptureConfigSchema,
  SessionStatusSchema,
  ValidationResultSchema,
} from './schemas/capture'

/**
 * The IPC contract. Frozen allowlist: a channel not in this map does not exist.
 * Every payload is validated against these schemas in BOTH directions — by the
 * gateway in main, and (response-side) nothing is assumed by the renderer either.
 *
 * Rules enforced by construction here (see SECURITY.md):
 * - no channel accepts a filesystem path
 * - no channel accepts SQL, a command, a module name, or a function name
 */
export const INVOKE_CHANNELS = {
  'devices:enumerate': {
    request: z.object({
      /** WebRTC-side labels, passed so main can reconcile them with dshow names. */
      webrtcCameras: z.array(z.object({ deviceId: z.string().max(256), label: z.string().max(256) })).max(32),
      webrtcMicrophones: z.array(z.object({ deviceId: z.string().max(256), label: z.string().max(256) })).max(32),
    }),
    response: DeviceInventorySchema,
  },
  'devices:probeCapabilities': {
    request: z.object({ force: z.boolean() }),
    response: CapabilitiesSchema,
  },
  'session:validate': {
    request: CaptureConfigSchema,
    response: ValidationResultSchema,
  },
  'session:start': {
    request: CaptureConfigSchema,
    response: z.object({ meetingId: z.string() }),
  },
  'session:stop': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
  'session:status': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
} as const

export type InvokeChannel = keyof typeof INVOKE_CHANNELS

/** Renderer -> main fire-and-forget channels (the real-time PCM path). */
export const SEND_CHANNELS = ['loopback:frame'] as const
export type SendChannel = (typeof SEND_CHANNELS)[number]

/** Main -> renderer event channels. */
export const EVENT_CHANNELS = ['session:state', 'loopback:stats'] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]

/**
 * Every invoke returns this envelope. Errors are values with stable codes,
 * not thrown strings, so the UI renders them deliberately.
 */
export interface IpcOk<T> {
  ok: true
  data: T
}
export interface IpcErr {
  ok: false
  error: { code: string; message: string }
}
export type IpcResult<T> = IpcOk<T> | IpcErr

export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof INVOKE_CHANNELS)[C]['request']>
export type InvokeResponse<C extends InvokeChannel> = z.infer<(typeof INVOKE_CHANNELS)[C]['response']>

/** The exact surface preload exposes as window.meetfroge. */
export interface MeetFrogeApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeRequest<C>): Promise<IpcResult<InvokeResponse<C>>>
  /** Transferable-friendly PCM push; only accepted while a session is active. */
  sendPcmFrame(buffer: ArrayBuffer): void
  onSessionState(cb: (status: unknown) => void): () => void
  onLoopbackStats(cb: (stats: unknown) => void): () => void
}
