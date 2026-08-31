import { app } from 'electron'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getSettings } from '@main/db/repositories/settings'
import { diskFreeBytes } from '@main/capture/media-tools'
import { mediaAbsolute, type MediaRoot } from '@main/security/paths'
import { modelsDir } from './models'

/**
 * Where recordings live.
 *
 * By default that is `userData/recordings`. The user can point new recordings
 * at a folder of their own (Documents, another drive) — and crucially, meetings
 * already recorded do NOT move. Each meeting records which root it belongs to,
 * so changing the setting can never orphan an existing recording. "The
 * recording is sacred" (Principle 2) rules out a change that rewrites paths.
 *
 * `work/` and `frames/` deliberately stay under userData: they are internal
 * scratch, and `mf-frame://` resolves against that root.
 */

/** Free space required before a folder is accepted or a recording starts. */
const STORAGE_FLOOR_BYTES = 5 * 1024 ** 3

export function defaultRecordingsRoot(): string {
  return path.join(app.getPath('userData'), 'recordings')
}

/** The configured custom root, or null when the default is in use. */
export function customRecordingsRoot(): string | null {
  try {
    return getSettings().recordingsDir
  } catch {
    // Settings live in SQLite; if the DB is unavailable the default still works.
    return null
  }
}

/** Where a NEW recording should be written. Created on demand. */
export function recordingsRoot(): string {
  const dir = customRecordingsRoot() ?? defaultRecordingsRoot()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The value to store in `meetings.media_root` for a recording starting now.
 *
 * The ABSOLUTE folder when a custom one is configured, so the recording stays
 * resolvable even if the setting is later changed or reset — not a `'custom'`
 * marker, which made resolution depend on the current setting and orphaned
 * older recordings the moment it changed.
 */
export function currentRootKind(): MediaRoot {
  return customRecordingsRoot() ?? 'userData'
}

/**
 * Absolute path of a meeting's media, resolved against ITS root and contained
 * within it. Throws PathEscapeError rather than returning something unsafe.
 */
export function resolveMedia(row: { media_root?: string | null; media_path: string }): string {
  return mediaAbsolute({ userData: app.getPath('userData') }, row)
}

/** Turn an absolute path just written into the {root, relative} pair to store. */
export function relativizeMedia(absolute: string): { root: MediaRoot; relative: string } {
  const custom = customRecordingsRoot()
  if (custom) {
    const rel = path.relative(custom, absolute)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { root: custom, relative: rel }
  }
  return { root: 'userData', relative: path.relative(app.getPath('userData'), absolute) }
}

export interface RootStatus {
  ok: boolean
  path: string
  reason: string | null
}

/**
 * Is the configured folder usable RIGHT NOW?
 *
 * A write-then-delete probe, not `fs.access`: M-013's lesson — existence is not
 * integrity — applies to directories too. A removable drive can be present and
 * read-only, and a network share can answer `stat` and refuse writes.
 */
export function rootAvailable(): RootStatus {
  const dir = customRecordingsRoot() ?? defaultRecordingsRoot()
  try {
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.meetfroge-write-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return { ok: true, path: dir, reason: null }
  } catch (e) {
    return { ok: false, path: dir, reason: String(e).slice(0, 200) }
  }
}

/**
 * Validate a folder the user picked, before it is ever stored.
 * Rejects app-internal locations outright: recordings inside the models folder
 * or the packaged resources would be deleted or overwritten by other features.
 */
export function validateRecordingsFolder(candidate: string): { ok: true } | { ok: false; reason: string } {
  const resolved = path.resolve(candidate)
  const forbidden = [modelsDir(), app.getAppPath(), path.join(app.getPath('userData'), 'work')]
  for (const f of forbidden) {
    const rel = path.relative(path.resolve(f), resolved)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return { ok: false, reason: 'That folder is used by the app itself. Choose another one.' }
    }
  }
  try {
    if (!statSync(resolved).isDirectory()) return { ok: false, reason: 'That is not a folder.' }
  } catch {
    return { ok: false, reason: 'That folder could not be read.' }
  }
  try {
    const probe = path.join(resolved, `.meetfroge-write-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
  } catch {
    return { ok: false, reason: 'That folder is not writable.' }
  }
  return { ok: true }
}

/** Free space check shared by the folder picker and the recording pre-flight. */
export async function hasRoomToRecord(dir: string): Promise<{ ok: boolean; freeBytes: number }> {
  try {
    const free = await diskFreeBytes(dir)
    return { ok: free >= STORAGE_FLOOR_BYTES, freeBytes: free }
  } catch {
    // Unknown is not a refusal — the live disk guard still protects the session.
    return { ok: true, freeBytes: 0 }
  }
}

export { STORAGE_FLOOR_BYTES }
