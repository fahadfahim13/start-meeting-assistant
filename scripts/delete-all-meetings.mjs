#!/usr/bin/env node
/**
 * Delete EVERY meeting — media, sidecars, frames and database rows.
 *
 * Irreversible. Guarded by an explicit flag so it cannot be run by accident:
 *
 *   node scripts/delete-all-meetings.mjs --yes-delete-everything
 *
 * It drives the app's own `deleteMeeting()` — the same code path the Library's
 * delete button uses — rather than reimplementing removal, and reports
 * per-meeting outcomes so a partial failure cannot leave the database and the
 * disk disagreeing without a record.
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { ROOT, runApp } from './electron-run.mjs'

const OUT = path.join(ROOT, 'out', 'delete-all.json')
const DB = path.join(process.env.APPDATA ?? '', 'MeetFroge', 'meetfroge.db')

if (!process.argv.includes('--yes-delete-everything')) {
  process.stdout.write(
    'Refusing to run without --yes-delete-everything.\n' +
      'This deletes every recording, transcript, summary and Q&A report permanently.\n',
  )
  process.exit(2)
}

const db = new DatabaseSync(DB, { readOnly: true })
const before = db.prepare('SELECT COUNT(*) c, SUM(COALESCE(media_bytes,0)) b FROM meetings').get()
db.close()
process.stdout.write(
  `About to delete ${before.c} meeting(s), ${(before.b / 1024 ** 2).toFixed(0)} MB of media.\n`,
)

const run = runApp({
  env: { MEETFROGE_DELETE_ALL: 'yes-delete-everything' },
  expectFile: OUT,
  timeoutMs: 10 * 60_000,
})
if (!run.ok) {
  process.stdout.write(`FAILED: ${run.reason}\n`)
  process.exit(1)
}

const r = JSON.parse(readFileSync(OUT, 'utf8'))
process.stdout.write(`attempted : ${r.attempted}\n`)
process.stdout.write(`deleted   : ${r.deleted}\n`)
process.stdout.write(`failed    : ${r.failed.length}\n`)
for (const f of r.failed.slice(0, 10)) {
  process.stdout.write(`   ${f.id}: ${f.error ?? 'not found'}\n`)
}
process.stdout.write(`freed     : ${(r.freedBytes / 1024 ** 2).toFixed(0)} MB\n`)
process.stdout.write(`remaining : ${r.remaining}\n`)

process.exit(r.failed.length === 0 && r.remaining === 0 ? 0 : 1)
