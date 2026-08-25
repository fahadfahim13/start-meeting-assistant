import { ipcMain } from 'electron'
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeRequest, type InvokeResponse, type IpcResult } from '@shared/ipc'
import { AppError } from '@shared/errors'

/**
 * The only door between the sandboxed renderer and the privileged main process.
 *
 * - Frozen allowlist: only channels in INVOKE_CHANNELS can be registered or called.
 * - zod validation in BOTH directions: a malformed request never reaches a
 *   handler; a malformed response never reaches the renderer.
 * - Errors are values with stable codes (IpcResult), never thrown strings.
 */

type Handler<C extends InvokeChannel> = (payload: InvokeRequest<C>) => Promise<InvokeResponse<C>>

const registered = new Set<string>()

export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  if (!(channel in INVOKE_CHANNELS)) {
    throw new Error(`refusing to register unknown IPC channel: ${channel}`)
  }
  if (registered.has(channel)) {
    throw new Error(`IPC channel registered twice: ${channel}`)
  }
  registered.add(channel)

  const { request: requestSchema, response: responseSchema } = INVOKE_CHANNELS[channel]

  ipcMain.handle(channel, async (_event, rawPayload): Promise<IpcResult<InvokeResponse<C>>> => {
    const parsed = requestSchema.safeParse(rawPayload)
    if (!parsed.success) {
      console.warn(`[ipc] ${channel}: invalid payload`, parsed.error.issues.slice(0, 3))
      return { ok: false, error: { code: 'IPC_INVALID_PAYLOAD', message: 'Request failed validation' } }
    }

    try {
      const result = await handler(parsed.data as InvokeRequest<C>)
      const validated = responseSchema.safeParse(result)
      if (!validated.success) {
        // A handler producing an out-of-contract response is a bug in main,
        // not in the caller — fail loudly rather than shipping bad data.
        console.error(`[ipc] ${channel}: handler response failed validation`, validated.error.issues.slice(0, 3))
        return { ok: false, error: { code: 'IPC_INTERNAL', message: 'Internal response validation failed' } }
      }
      return { ok: true, data: validated.data as InvokeResponse<C> }
    } catch (e) {
      if (e instanceof AppError) {
        return { ok: false, error: { code: e.code, message: e.message } }
      }
      console.error(`[ipc] ${channel}:`, e)
      return { ok: false, error: { code: 'IPC_INTERNAL', message: 'Internal error' } }
    }
  })
}
