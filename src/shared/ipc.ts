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
  'devices:screenPreview': {
    request: z.object({ sourceId: z.string().min(1).max(256) }),
    response: z.object({
      thumbnailDataUrl: z.string().max(4_000_000).nullable(),
      /**
       * Why there is no image. "The window you picked was closed" and "the
       * window you picked is minimised" are different problems with different
       * fixes; a bare null told the user neither and rendered a blank panel.
       */
      status: z.enum(['ok', 'not-found', 'empty']),
    }),
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
  // Mute a track DURING a recording. The track stays in the file and receives
  // silence — removing it would change the stream layout between segments and
  // break the lossless concat (M-011).
  'session:setMute': {
    request: z.object({ track: z.enum(['mic', 'system']), muted: z.boolean() }),
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
          sourceLabel: z.string().nullable(),
          tags: z.array(z.string()),
          /**
           * `id` is what makes `jobs:retry` reachable at all: the channel wants
           * a job id and no job id had ever crossed IPC, so the retry handler
           * had zero callers. A job id is a database key, never a path — the
           * "no renderer-supplied path" invariant is untouched.
           *
           * errorCode/errorDetail carry SKIP reasons as well as failures. A
           * skip with no reason is indistinguishable from "still queued".
           */
          jobs: z.array(
            z.object({
              id: z.string(),
              stage: z.string(),
              state: z.string(),
              progress: z.number(),
              errorCode: z.string().max(64).nullable(),
              errorDetail: z.string().max(1000).nullable(),
              attempts: z.number(),
              maxAttempts: z.number(),
            }),
          ),
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
          /** True once the user has corrected this line by hand. */
          edited: z.boolean(),
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
  // R-07 names "transcript is editable" as the mitigation for code-switched
  // Bengali-English, which whisper garbles at language switch points. It was
  // not editable until now; a misheard word was permanent and carried into the
  // summary and the Q&A report.
  'transcript:edit': {
    request: z.object({ segmentId: z.string().uuid(), text: z.string().min(1).max(5000) }),
    response: z.object({ ok: z.boolean() }),
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
  // ---- Q&A report -------------------------------------------------------
  // Generated on demand, not as part of automatic processing: the user asked
  // for a button, and a report nobody opened is minutes of inference wasted.
  'summary:export': {
    request: z.object({ meetingId: z.string().uuid(), format: z.enum(['md', 'txt', 'json']) }),
    response: z.object({ saved: z.boolean(), fileName: z.string().nullable() }),
  },
  'meetings:setNotes': {
    request: z.object({ meetingId: z.string().uuid(), notes: z.string().max(20_000) }),
    response: z.object({ ok: z.boolean() }),
  },
  'meetings:getNotes': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({ notes: z.string() }),
  },
  // Flag a moment WHILE recording, when you know it matters — rather than
  // hunting for it in an hour of transcript afterwards.
  'session:marker': {
    request: z.object({ label: z.string().max(200).nullable() }),
    response: z.object({ atMs: z.number().int().min(0), total: z.number().int().min(0) }),
  },
  'markers:get': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({
      markers: z.array(
        z.object({ id: z.string(), atMs: z.number().int(), label: z.string().nullable() }),
      ),
    }),
  },
  'markers:delete': {
    request: z.object({ markerId: z.string().uuid() }),
    response: z.object({ ok: z.boolean() }),
  },
  'qa:get': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({
      report: z
        .object({
          pairs: z.array(
            z.object({
              q: z.string().max(300),
              a: z.string().max(1200),
              /** Snapped to a real transcript segment, or null — never a guess. */
              t: z.number().int().min(0).nullable(),
            }),
          ),
          degraded: z.boolean(),
          generatedAt: z.number(),
        })
        .nullable(),
    }),
  },
  'qa:regenerate': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({ enqueued: z.boolean() }),
  },
  'qa:export': {
    // The renderer names a FORMAT, never a path — main owns the save dialog.
    request: z.object({ meetingId: z.string().uuid(), format: z.enum(['md', 'txt', 'json']) }),
    response: z.object({ saved: z.boolean(), fileName: z.string().nullable() }),
  },
  'actionitem:toggle': {
    request: z.object({ actionItemId: z.string().uuid(), done: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
  },
  // The renderer asks main to OPEN A PICKER; it never sends a path.
  //
  // The invariant is directional: "no renderer-supplied filesystem path ever
  // crosses IPC" is about REQUESTS. Returning a path in a response is already
  // established practice (settings:get returns modelsDir/recordingsDir). So
  // there is deliberately no `recordingsDir` field on settings:set — main owns
  // the dialog, validates the result, and writes the setting itself. ADR-016.
  'settings:chooseRecordingsFolder': {
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      path: z.string().max(500).nullable(),
      reason: z.string().max(300).nullable(),
    }),
  },
  'settings:resetRecordingsFolder': {
    request: z.object({}),
    response: z.object({ ok: z.boolean(), path: z.string().max(500) }),
  },
  'settings:get': {
    request: z.object({}),
    response: z.object({
      defaultPreset: z.enum(['efficient', 'balanced', 'high', 'archival']),
      language: z.enum(['en', 'bn', 'auto']),
      autoProcess: z.boolean(),
      keyframeSensitivity: z.enum(['sensitive', 'balanced', 'sparse']),
      modelsDir: z.string(),
      recordingsDir: z.string(),
      /** False when the user has chosen a folder of their own. */
      recordingsDirIsDefault: z.boolean(),
      /** The folder exists and is writable right now (write-probed). */
      recordingsDirWritable: z.boolean(),
      writeSidecarFiles: z.boolean(),
      outputFormat: z.enum(['mkv', 'mp4']),
      models: z.array(
        z.object({
          id: z.string(),
          file: z.string(),
          status: z.enum(['ok', 'missing', 'corrupt']),
          purpose: z.string(),
          tier: z.enum(['required', 'recommended']),
          bytes: z.number(),
        }),
      ),
      vulkan: z.boolean(),
    }),
  },
  'settings:set': {
    request: z.object({
      defaultPreset: z.enum(['efficient', 'balanced', 'high', 'archival']).optional(),
      language: z.enum(['en', 'bn', 'auto']).optional(),
      autoProcess: z.boolean().optional(),
      keyframeSensitivity: z.enum(['sensitive', 'balanced', 'sparse']).optional(),
      writeSidecarFiles: z.boolean().optional(),
      outputFormat: z.enum(['mkv', 'mp4']).optional(),
      // NOTE: `recordingsDir` is deliberately absent. A filesystem path may
      // leave main in a RESPONSE but must never enter in a REQUEST — the folder
      // is set only by settings:chooseRecordingsFolder, which owns the dialog
      // and validates the result itself. See ADR-016 before "completing" this.
    }),
    response: z.object({ ok: z.boolean() }),
  },
  'meetings:delete': {
    request: z.object({ meetingId: z.string().uuid() }),
    response: z.object({ ok: z.boolean(), freedBytes: z.number() }),
  },
  'meetings:setTags': {
    request: z.object({ meetingId: z.string().uuid(), tags: z.array(z.string().min(1).max(40)).max(12) }),
    response: z.object({ ok: z.boolean() }),
  },
  'search:all': {
    request: z.object({ query: z.string().min(1).max(200) }),
    response: z.object({
      hits: z.array(
        z.object({
          meetingId: z.string(),
          meetingTitle: z.string(),
          kind: z.enum(['speech', 'screen']),
          text: z.string(),
          startMs: z.number(),
        }),
      ),
    }),
  },
  'models:download': {
    request: z.object({ modelId: z.string().max(64) }),
    response: z.object({ started: z.boolean() }),
  },
  'models:cancel': {
    request: z.object({ modelId: z.string().max(64) }),
    response: z.object({ ok: z.boolean() }),
  },
  /** Names used before, so a recurring colleague is typed once, not per meeting. */
  'speakers:known': {
    request: z.object({}),
    response: z.object({ names: z.array(z.string().max(80)).max(50) }),
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
export const EVENT_CHANNELS = ['session:state', 'loopback:stats', 'jobs:update', 'models:progress'] as const
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

/**
 * Shape of the `jobs:update` push event (the raw job row, snake_case).
 *
 * Events arrive as `unknown` by design — the invoke gateway validates request
 * and response, but a push has no such gate, so the consumer validates. Used by
 * the Library to patch one job in place instead of re-querying every meeting on
 * every whisper progress tick.
 */
export const JobUpdateSchema = z.object({
  id: z.string(),
  meeting_id: z.string(),
  stage: z.string(),
  state: z.string(),
  progress: z.number(),
  attempts: z.number(),
  error_code: z.string().nullable(),
})
export type JobUpdate = z.infer<typeof JobUpdateSchema>

/** The exact surface preload exposes as window.meetfroge. */
export interface MeetFrogeApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeRequest<C>): Promise<IpcResult<InvokeResponse<C>>>
  /** Transferable-friendly PCM push; only accepted while a session is active. */
  sendPcmFrame(buffer: ArrayBuffer): void
  onSessionState(cb: (status: unknown) => void): () => void
  onLoopbackStats(cb: (stats: unknown) => void): () => void
  onJobsUpdate(cb: (job: unknown) => void): () => void
  onModelsProgress(cb: (p: unknown) => void): () => void
}
