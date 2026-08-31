import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { resolveBinary } from '@main/platform/binaries'
import { log } from '@main/log'

/**
 * llama-server lifecycle (plan §8.5.1). One server at a time — the machine is
 * memory-bandwidth-bound (B-009/B-010) and models are GBs of RAM.
 *
 * Security: binds 127.0.0.1 on an ephemeral port with a per-session random
 * API key. Idle unload after 5 minutes returns the RAM.
 */

const IDLE_UNLOAD_MS = 5 * 60_000
const STARTUP_TIMEOUT_MS = 120_000

export interface ServerConfig {
  modelPath: string
  mmprojPath?: string
  contextSize?: number
}

interface Running {
  key: string // modelPath + mmproj — identifies what is loaded
  port: number
  apiKey: string
  child: ChildProcess
}

let running: Running | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Requests currently awaiting a reply.
 *
 * The idle unloader fires 5 minutes after the LAST touch, but `touchIdle()` is
 * called when a request STARTS and a completion may run for up to 10 minutes
 * (the fetch timeout). A long summarize call could therefore have its own
 * server killed out from under it and fail with a fetch error that looked like
 * a model problem. The window is real on a 15 W laptop, where a big reduce pass
 * is exactly the call that takes longest.
 */
let inFlight = 0

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (typeof address === 'object' && address) {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('no port')))
      }
    })
  })
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    // Re-arm rather than unload while a request is still outstanding.
    if (inFlight > 0) {
      touchIdle()
      return
    }
    log.info('llm', 'idle - unloading model')
    void stopLlm()
  }, IDLE_UNLOAD_MS)
}

export async function ensureLlm(config: ServerConfig): Promise<{ port: number; apiKey: string }> {
  const key = `${config.modelPath}|${config.mmprojPath ?? ''}`
  if (running && running.key === key && running.child.exitCode === null) {
    touchIdle()
    return { port: running.port, apiKey: running.apiKey }
  }
  await stopLlm()

  const port = await freePort()
  const apiKey = randomBytes(16).toString('hex')
  const args = [
    '-m', config.modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--api-key', apiKey,
    '-c', String(config.contextSize ?? 8192),
    '-ngl', process.env['MEETFROGE_DISABLE_VULKAN'] === '1' ? '0' : '99', // CPU-path test hook
    '--no-webui',
  ]
  if (config.mmprojPath) args.push('--mmproj', config.mmprojPath)

  const child = spawn(resolveBinary('llama-server'), args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // A bounded ring, written to the log ONLY when the server fails. Discarding
  // stderr entirely meant "did not become healthy in time" carried no
  // diagnosis at all; keeping it always would risk model text reaching a log.
  // llama-server's own startup lines are load/config diagnostics, not prompts.
  const stderrTail: string[] = []
  child.stderr?.on('data', (d: Buffer) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue
      stderrTail.push(line.slice(0, 300))
      if (stderrTail.length > 40) stderrTail.shift()
    }
  })
  child.on('exit', (code) => {
    if (running?.child === child && code !== 0 && code !== null) {
      log.error('llm', 'server exited', { code, stderrTail: stderrTail.slice(-15) })
      running = null
    }
  })

  running = { key, port, apiKey, child }

  // Wait for /health.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) {
      log.error('llm', 'server exited during startup', {
        code: child.exitCode,
        stderrTail: stderrTail.slice(-15),
      })
      throw new Error(`llama-server exited ${child.exitCode} during startup`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      log.error('llm', 'server did not become healthy in time', {
        timeoutMs: STARTUP_TIMEOUT_MS,
        stderrTail: stderrTail.slice(-15),
      })
      await stopLlm()
      throw new Error('llama-server did not become healthy in time')
    }
    await new Promise((r) => setTimeout(r, 750))
  }

  touchIdle()
  return { port, apiKey }
}

export interface ChatMessage {
  role: 'system' | 'user'
  content:
    | string
    | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
}

export async function chat(input: {
  server: { port: number; apiKey: string }
  messages: ChatMessage[]
  maxTokens: number
  temperature?: number
  /** llama-server grammar-constrained output (json_schema) — guarantees shape. */
  responseFormat?: object
}): Promise<string> {
  touchIdle()
  inFlight++
  try {
    return await doChat(input)
  } finally {
    inFlight--
    // Restart the clock from the END of the request, not the start.
    touchIdle()
  }
}

async function doChat(input: {
  server: { port: number; apiKey: string }
  messages: ChatMessage[]
  maxTokens: number
  temperature?: number
  responseFormat?: object
}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${input.server.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.server.apiKey}`,
    },
    body: JSON.stringify({
      messages: input.messages,
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!res.ok) {
    // Deliberately NOT the response body. An error thrown here is caught by the
    // queue, written into jobs.error_detail, and now also written to the log
    // file — and a llama-server error body can echo the prompt, which is
    // meeting content. "Transcript text, OCR text and LLM output are never
    // written to logs" (CLAUDE.md) has no exception for error paths.
    const body = await res.text().catch(() => '')
    throw new Error(`llm http ${res.status} (${body.length} chars of body withheld)`)
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
  }
  const content = body.choices?.[0]?.message?.content ?? ''
  if (content.length === 0) {
    // An empty reply is an upstream failure, not a valid answer (M-018).
    throw new Error(`llm returned empty content (finish_reason=${body.choices?.[0]?.finish_reason ?? 'unknown'})`)
  }
  return content
}

export async function stopLlm(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const r = running
  running = null
  if (r && r.child.exitCode === null) {
    r.child.kill()
    await new Promise((resolve) => r.child.once('exit', resolve))
  }
}
