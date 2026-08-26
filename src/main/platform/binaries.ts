import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/**
 * The single place binary paths come from (invariant: nothing else may decide
 * where a subprocess binary lives — a poisoned PATH must not be able to
 * substitute one in production).
 *
 * Packaged: resources/bin/<name>.exe, hash-verified at first run (Phase 8/10).
 * Dev: resources/bin/ at the repo root if present, otherwise fall back to PATH
 * with a warning — acceptable only because dev machines are trusted.
 */
const DEV_WARNED = new Set<string>()

export type BinaryName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'llama-server'

export function resolveBinary(name: BinaryName): string {
  const exe = `${name}.exe`

  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', exe)
    : path.join(app.getAppPath(), 'resources', 'bin', exe)

  if (existsSync(bundled)) return bundled

  if (!app.isPackaged) {
    if (!DEV_WARNED.has(name)) {
      DEV_WARNED.add(name)
      console.warn(`[binaries] dev fallback: resolving "${name}" from PATH (bundle it in resources/bin for production behaviour)`)
    }
    return exe // PATH lookup — dev only
  }

  throw new AppError('SYSTEM_BINARY_MISSING', `${exe} not found at ${bundled}`)
}
