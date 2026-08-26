import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { resolveBinary } from '@main/platform/binaries'

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
    console.log('[llm] idle — unloading model')
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
    '-ngl', '99', // Vulkan offload when available; harmless without
    '--no-webui',
  ]
  if (config.mmprojPath) args.push('--mmproj', config.mmprojPath)

  const child = spawn(resolveBinary('llama-server'), args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', () => {
    /* llama-server logs are noisy; health is checked via HTTP */
  })
  child.on('exit', (code) => {
    if (running?.child === child && code !== 0 && code !== null) {
      console.error(`[llm] server exited ${code}`)
      running = null
    }
  })

  running = { key, port, apiKey, child }

  // Wait for /health.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) throw new Error(`llama-server exited ${child.exitCode} during startup`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
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
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return body.choices?.[0]?.message?.content ?? ''
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
