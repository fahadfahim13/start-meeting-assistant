import path from 'node:path'

/**
 * Path containment guard (SECURITY.md T4). Every place a stored or derived
 * relative path is resolved against a root goes through here — one
 * implementation, unit-tested against the traversal battery, instead of
 * inline startsWith checks scattered per call site.
 */

export class PathEscapeError extends Error {
  constructor(attempted: string) {
    super(`path escapes its root: ${attempted.slice(0, 120)}`)
    this.name = 'PathEscapeError'
  }
}

/**
 * Resolve `relative` against `root` and throw unless the result stays
 * strictly inside it. Rejects absolute inputs, drive-qualified inputs,
 * UNC paths and anything that walks out via `..`.
 */
export function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\\\')) {
    throw new PathEscapeError(relative)
  }
  const rootResolved = path.resolve(root)
  const resolved = path.resolve(rootResolved, relative)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new PathEscapeError(relative)
  }
  return resolved
}

/**
 * Which root a meeting's `media_path` is relative to.
 *
 * Either the sentinel `'userData'`, or an ABSOLUTE folder path recorded at the
 * time of capture.
 *
 * It stores the real path rather than a `'custom'` marker for a reason found the
 * hard way: with a marker, resolution depended on the CURRENT setting, so
 * switching the recordings folder back to the default orphaned every meeting
 * recorded under the old one — unplayable and undeletable, because the guard
 * (correctly) refused to guess. A recording must stay resolvable no matter what
 * the setting is changed to afterwards. Principle 2.
 *
 * This value is written by main and read back from SQLite. It never comes from
 * the renderer, so trusting it as a root is not a privilege escalation — and
 * `media_path` stays relative, so containment is still enforced.
 */
export type MediaRoot = string

/**
 * Resolve a meeting's media file against the root it was recorded under.
 *
 * Pure so the containment behaviour is testable without Electron. Throws
 * PathEscapeError on anything that would leave its root.
 */
export function mediaAbsolute(
  roots: { userData: string },
  row: { media_root?: string | null; media_path: string },
): string {
  const stored = row.media_root
  // Legacy rows (before the column existed) and every default-folder recording
  // resolve against userData exactly as they always did.
  const root = !stored || stored === 'userData' ? roots.userData : stored
  return resolveInside(root, row.media_path)
}

/** Non-throwing variant for protocol handlers that answer 403 instead. */
export function isInside(root: string, candidateAbsolute: string): boolean {
  const rootResolved = path.resolve(root)
  const resolved = path.resolve(candidateAbsolute)
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)
}
