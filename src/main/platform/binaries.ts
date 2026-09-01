import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { log } from '@main/log'

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
      log.warn('binaries', 'dev fallback: resolving from PATH', { name })
    }
    return exe // PATH lookup — dev only
  }

  throw new AppError('SYSTEM_BINARY_MISSING', `${exe} not found at ${bundled}`)
}

/** Non-executable files we ship beside the binaries. */
export type ResourceName = 'pip-mask-16x9.png'

/**
 * Same rule as resolveBinary, for data assets: the path comes from app
 * resources and nowhere else. There is no dev PATH fallback — an asset either
 * ships with the app or it does not exist, and a caller that silently records
 * without it would be worse than one that says so.
 */
export function resolveResource(name: ResourceName): string {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', name)
    : path.join(app.getAppPath(), 'resources', 'assets', name)

  if (!existsSync(file)) {
    throw new AppError('SYSTEM_BINARY_MISSING', `${name} not found at ${file}`)
  }
  return file
}
