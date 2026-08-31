#!/usr/bin/env node
/**
 * Phase E verification: does the Q&A report say something true about a real
 * meeting, with timestamps that actually land?
 *
 * Content assertions, not exit codes — that is this repo's standard and M-015
 * is why: a stage can return a perfectly-shaped empty answer and look fine.
 *
 * The Q&A stage is deliberately NOT in PROCESSING_STAGES (it runs from a
 * button), so this drives it through the `MEETFROGE_QA_MEETING` hook against a
 * meeting that already has a transcript and a summary.
 *
 * Usage:
 *   node scripts/qa-test.mjs                 # picks the richest meeting itself
 *   node scripts/qa-test.mjs <meeting-uuid>
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { ROOT, runApp } from './electron-run.mjs'

const OUT = path.join(ROOT, 'out', 'qa-e2e.json')
const DB = path.join(process.env.APPDATA ?? '', 'MeetFroge', 'meetfroge.db')

function pickMeeting() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const row = db
    .prepare(
      `SELECT m.id, m.title,
              (SELECT COUNT(*) FROM transcript_segments t WHERE t.meeting_id = m.id) segs
         FROM meetings m
        WHERE EXISTS (SELECT 1 FROM summaries s WHERE s.meeting_id = m.id AND s.is_current = 1)
          AND (SELECT COUNT(*) FROM transcript_segments t WHERE t.meeting_id = m.id) > 0
        ORDER BY segs DESC LIMIT 1`,
    )
    .get()
  db.close()
  return row
}

const explicit = process.argv[2]
const meeting = explicit ? { id: explicit, title: '(given)', segs: '?' } : pickMeeting()
if (!meeting) {
  process.stdout.write(
    'SKIP: no meeting has both a transcript and a summary. Run scripts/summary-test.mjs first.\n',
  )
  process.exit(0)
}
process.stdout.write(`meeting ${meeting.id} — "${meeting.title}" (${meeting.segs} segments)\n`)

const run = runApp({
  env: { MEETFROGE_QA_MEETING: meeting.id },
  expectFile: OUT,
  timeoutMs: 20 * 60_000,
})
if (!run.ok) {
  process.stdout.write(`FAIL: ${run.reason}\n`)
  process.exit(1)
}

const r = JSON.parse(readFileSync(OUT, 'utf8'))
const pairs = r.pairs ?? []
process.stdout.write(`job ${JSON.stringify(r.job)} · degraded=${r.degraded} · pairs=${pairs.length}\n\n`)
for (const p of pairs) {
  const stamp = p.t === null ? '(no timestamp)' : `[${Math.floor(p.t / 60000)}:${String(Math.floor((p.t % 60000) / 1000)).padStart(2, '0')}]`
  process.stdout.write(`Q: ${p.q}\nA: ${p.a} ${stamp}\n\n`)
}

const checks = [
  ['stage completed', r.job?.state === 'done'],
  ['at least 2 pairs', pairs.length >= 2],
  ['every pair has a real question and answer', pairs.every((p) => p.q?.length > 4 && p.a?.length > 2)],
  // The whole point of snapToSegment: a timestamp is either real or absent.
  ['timestamps are a number or null, never a guess', pairs.every((p) => p.t === null || Number.isInteger(p.t))],
  // The model writes the plumbing into its prose if you let it.
  ['no t= marker leaked into an answer', !pairs.some((p) => /t\s*=\s*(\d|null)/i.test(p.a))],
  ['no duplicate questions', new Set(pairs.map((p) => p.q.toLowerCase().trim())).size === pairs.length],
]

let failures = 0
for (const [label, ok] of checks) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`)
  if (!ok) failures++
}
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
