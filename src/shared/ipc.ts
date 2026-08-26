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
  'session:pause': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
  'session:resume': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
  'session:stop': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
  'session:status': {
    request: z.object({}),
    response: SessionStatusSchema,
  },
  'meetings:list': {
    request: z.object({ limit: z.number().int().min(1).max(200) }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          startedAt: z.number(),
          durationMs: z.number().nullable(),
          state: z.string(),
          bytes: z.number().nullable(),
          jobs: z.array(z.object({ stage: z.string(), state: z.string(), progress: z.number() })),
        }),
      ),
    }),
  },
  'meetings:process': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({ enqueued: z.boolean() }),
  },
  'transcript:get': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({
      segments: z.array(
        z.object({
          id: z.string(),
          startMs: z.number(),
          endMs: z.number(),
          speaker: z.string().nullable(),
          speakerId: z.string().nullable(),
          certain: z.boolean(),
          track: z.string(),
          text: z.string(),
        }),
      ),
    }),
  },
  'transcript:search': {
    request: z.object({ query: z.string().min(1).max(200) }),
    response: z.object({
      hits: z.array(
        z.object({ meetingId: z.string(), segmentId: z.string(), text: z.string(), startMs: z.number() }),
      ),
    }),
  },
  'transcript:export': {
    // The renderer names a FORMAT, never a path — main opens a save dialog.
    request: z.object({
      meetingId: z.string().uuid(),
      format: z.enum(['txt', 'srt', 'vtt', 'json', 'md']),
    }),
    response: z.object({ saved: z.boolean(), fileName: z.string().nullable() }),
  },
  'jobs:retry': {
    request: z.object({ jobId: z.string().uuid() }),
    response: z.object({ ok: z.boolean() }),
  },
  'keyframes:get': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({
      keyframes: z.array(
        z.object({
          id: z.string(),
          timestampMs: z.number(),
          url: z.string().max(500),
          ocrText: z.string().nullable(),
          caption: z.string().nullable(),
          sceneType: z.string().nullable(),
        }),
      ),
    }),
  },
  'summary:get': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({
      summary: z
        .object({
          title: z.string(),
          tldr: z.string(),
          summary: z.string(),
          key_points: z.array(z.string()),
          decisions: z.array(z.object({ text: z.string(), t: z.number().optional() })),
          topics: z.array(z.string()),
          open_questions: z.array(z.string()),
          degraded: z.boolean(),
        })
        .nullable(),
      actionItems: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          assignee: z.string().nullable(),
          sourceMs: z.number().nullable(),
          done: z.boolean(),
        }),
      ),
    }),
  },
  'summary:regenerate': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({ enqueued: z.boolean() }),
  },
  'actionitem:toggle': {
    request: z.object({ actionItemId: z.string().uuid(), done: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
  },
  'speakers:rename': {
    request: z.object({ speakerId: z.string().uuid(), displayName: z.string().min(1).max(80) }),
    response: z.object({ ok: z.boolean() }),
  },
} as const

export type InvokeChannel = keyof typeof INVOKE_CHANNELS

/** Renderer -> main fire-and-forget channels (the real-time PCM path). */
export const SEND_CHANNELS = ['loopback:frame'] as const
export type SendChannel = (typeof SEND_CHANNELS)[number]

/** Main -> renderer event channels. */
export const EVENT_CHANNELS = ['session:state', 'loopback:stats', 'jobs:update'] as const
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
  onJobsUpdate(cb: (job: unknown) => void): () => void
}
