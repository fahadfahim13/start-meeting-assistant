#!/usr/bin/env node
/**
 * Exercise transcript editing, speaker-name memory, markers and notes against
 * the real database.
 *
 * These four have no natural harness: editing needs a transcript, which needs
 * real speech. Without this they would ship verified only by the type checker.
 * The hook builds a synthetic meeting, runs each path, and deletes it again —
 * the Library is left as it was found.
 *
 * Usage: npm run test:features
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, runApp } from './electron-run.mjs'

const OUT = path.join(ROOT, 'out', 'selftest.json')

const run = runApp({ env: { MEETFROGE_SELFTEST: 'features' }, expectFile: OUT, timeoutMs: 5 * 60_000 })
if (!run.ok) {
  process.stdout.write(`FAILED: ${run.reason}\n`)
  process.exit(1)
}

const r = JSON.parse(readFileSync(OUT, 'utf8'))
let failures = 0
for (const c of r.checks) {
  process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  |  ${c.detail}` : ''}\n`)
  if (!c.ok) failures++
}
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
