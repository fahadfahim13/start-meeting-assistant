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

/** Non-throwing variant for protocol handlers that answer 403 instead. */
export function isInside(root: string, candidateAbsolute: string): boolean {
  const rootResolved = path.resolve(root)
  const resolved = path.resolve(candidateAbsolute)
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)
}
