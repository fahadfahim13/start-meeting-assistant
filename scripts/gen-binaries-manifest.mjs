// Generates resources/bin.manifest.json — SHA-256 of every bundled binary.
// Run whenever resources/bin changes; the app verifies against it at startup
// (SECURITY.md T7). The manifest IS committed; the binaries are not.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'resources', 'bin')

const entries = {}
for (const f of readdirSync(binDir).sort()) {
  const p = path.join(binDir, f)
  if (!statSync(p).isFile()) continue
  const hash = createHash('sha256').update(readFileSync(p)).digest('hex')
  entries[f] = { sha256: hash, bytes: statSync(p).size }
}
const manifest = {
  generated: new Date().toISOString(),
  note: 'SHA-256 of bundled binaries. Regenerate with scripts/gen-binaries-manifest.mjs after any binary change.',
  files: entries,
}
writeFileSync(path.join(root, 'resources', 'bin.manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`manifest written: ${Object.keys(entries).length} files`)
