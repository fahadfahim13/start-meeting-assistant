import { app } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Structured logging with redaction (plan §10.5, SECURITY.md T9).
 *
 * Rules enforced HERE, not by discipline at call sites:
 * - user paths are redacted (userData, home) before anything is written
 * - `content()` marks meeting-derived text (transcript/OCR/LLM output); it is
 *   NEVER written to the file — only its length survives
 * - JSON lines, daily files, 7-day retention, local only
 */

const RETENTION_DAYS = 7

let logDir: string | null = null
let redactions: [string, string][] = []

function ensure(): string {
  if (logDir) return logDir
  logDir = path.join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  redactions = [
    [app.getPath('userData'), '<data>'],
    [app.getPath('home'), '<home>'],
  ]
  // retention sweep, best effort
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
    for (const f of readdirSync(logDir)) {
      const p = path.join(logDir, f)
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true })
    }
  } catch {
    /* sweep is best-effort */
  }
  return logDir
}

function redact(value: string): string {
  let out = value
  for (const [needle, replacement] of redactions) {
    out = out.split(needle).join(replacement)
  }
  return out
}

/** Wrap meeting-derived text: the log records only that it existed, and its size. */
export function content(text: string | null | undefined): { redactedContent: true; length: number } {
  return { redactedContent: true, length: text?.length ?? 0 }
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function write(level: Level, area: string, message: string, extra?: object): void {
  const dir = ensure()
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    area,
    msg: redact(message),
    ...(extra ? JSON.parse(redact(JSON.stringify(extra))) : {}),
  })
  const file = path.join(dir, `meetfroge-${new Date().toISOString().slice(0, 10)}.log`)
  try {
    appendFileSync(file, line + '\n')
  } catch {
    /* a failing log must never take the app down */
  }
  // Console mirrors for dev (M-004: invisible in prod anyway).
  if (level === 'error') console.error(`[${area}]`, message)
  else if (level === 'warn') console.warn(`[${area}]`, message)
  else console.log(`[${area}]`, message)
}

export const log = {
  debug: (area: string, message: string, extra?: object) => write('debug', area, message, extra),
  info: (area: string, message: string, extra?: object) => write('info', area, message, extra),
  warn: (area: string, message: string, extra?: object) => write('warn', area, message, extra),
  error: (area: string, message: string, extra?: object) => write('error', area, message, extra),
}
