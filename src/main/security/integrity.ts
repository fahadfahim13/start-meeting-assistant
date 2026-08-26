import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Bundled-binary integrity (SECURITY.md T7). The manifest is generated at
 * build time (scripts/gen-binaries-manifest.mjs) and shipped read-only inside
 * the package; every binary is hashed against it before first use.
 *
 * Packaged: a mismatch is FATAL — a tampered ffmpeg must never run.
 * Dev: a warning — developers legitimately swap binaries while iterating.
 */

interface Manifest {
  files: Record<string, { sha256: string; bytes: number }>
}

let verified: 'pending' | 'ok' | 'failed' = 'pending'

export function verifyBinaries(): { ok: boolean; problems: string[] } {
  const binDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin')
  const manifestPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin.manifest.json')
    : path.join(app.getAppPath(), 'resources', 'bin.manifest.json')

  const problems: string[] = []
  if (!existsSync(manifestPath)) {
    problems.push('bin.manifest.json missing')
  } else {
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    } catch {
      return finish(false, ['bin.manifest.json unreadable'])
    }
    for (const [file, expected] of Object.entries(manifest.files)) {
      const p = path.join(binDir, file)
      if (!existsSync(p)) {
        problems.push(`${file}: missing`)
        continue
      }
      const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
      if (actual !== expected.sha256) problems.push(`${file}: hash mismatch`)
    }
  }
  return finish(problems.length === 0, problems)
}

function finish(ok: boolean, problems: string[]): { ok: boolean; problems: string[] } {
  verified = ok ? 'ok' : 'failed'
  if (!ok) {
    if (app.isPackaged) {
      // T7: refuse to run with tampered binaries. The user reinstalls.
      console.error('[integrity] FATAL — bundled binaries failed verification:', problems)
      app.exit(13)
    } else {
      console.warn('[integrity] dev warning — binaries differ from manifest:', problems.slice(0, 5))
    }
  }
  return { ok, problems }
}

export function integrityState(): typeof verified {
  return verified
}
