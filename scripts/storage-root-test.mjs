#!/usr/bin/env node
/**
 * Verify the choosable recordings folder end to end, without the GUI.
 *
 * Writes the same settings row the folder-picker handler writes, records a
 * synthetic meeting, and then — the part that matters — **resets the setting to
 * the default** and checks the recording is still resolvable. That reversal is
 * what a `'custom'` marker got wrong: resolution depended on the current
 * setting, so reverting orphaned every recording made under the old folder,
 * leaving it unplayable and undeletable.
 *
 * Usage: node scripts/storage-root-test.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { ROOT, runApp, killStrays } from './electron-run.mjs'

const APPDATA = process.env.APPDATA ?? ''
const DB = path.join(APPDATA, 'MeetFroge', 'meetfroge.db')
const CUSTOM = path.join(process.env.USERPROFILE ?? '', 'Documents', 'MeetFroge-storage-test')
const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const OUT = path.join(ROOT, 'out', 'transcribe-e2e.json')
const CLIP = path.join(APPDATA, 'MeetFroge', 'storage-root-probe.mkv')

function setFolder(value) {
  killStrays()
  const db = new DatabaseSync(DB)
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('recordingsDir', JSON.stringify(value))
  db.close()
}

function query(sql, ...args) {
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare(sql).all(...args)
  db.close()
  return rows
}

let failures = 0
const check = (label, ok) => {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`)
  if (!ok) failures++
}

try {
  mkdirSync(CUSTOM, { recursive: true })
  rmSync(CLIP, { force: true })
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-b:a', '64k', CLIP,
  ])

  const before = new Set(readdirSync(CUSTOM))
  setFolder(CUSTOM)
  process.stdout.write(`custom folder: ${CUSTOM}\n`)

  const run = runApp({ env: { MEETFROGE_PROCESS_FILE: CLIP }, expectFile: OUT })
  if (!run.ok) throw new Error(run.reason)

  const added = readdirSync(CUSTOM).filter((f) => !before.has(f))
  process.stdout.write(`created: ${added.join(', ') || '(none)'}\n`)

  const rows = query(
    "SELECT id, media_root, media_path FROM meetings ORDER BY created_at DESC LIMIT 1",
  )
  const row = rows[0]
  check('the .mkv landed in the chosen folder', added.some((f) => f.endsWith('.mkv')))
  check('media_root records the ACTUAL folder, not a marker', row?.media_root === CUSTOM)
  check('media_path stays relative', Boolean(row) && !path.isAbsolute(row.media_path))
  check(
    'the file is where media_root + media_path say it is',
    Boolean(row) && existsSync(path.join(row.media_root, row.media_path)),
  )

  // The reversal: back to the default folder, recording must remain resolvable.
  setFolder(null)
  const after = query('SELECT media_root, media_path FROM meetings WHERE id = ?', row.id)[0]
  check('after resetting to the default folder, the row still points at the real file',
    Boolean(after) && existsSync(path.join(after.media_root, after.media_path)))
  check('and it is still NOT under userData', !path.join(after.media_root, after.media_path).startsWith(path.join(APPDATA, 'MeetFroge')))

  // Clean up the meeting we just made, through the app's own delete path.
  const del = runApp({
    env: { MEETFROGE_DELETE_ALL: 'yes-delete-everything' },
    expectFile: path.join(ROOT, 'out', 'delete-all.json'),
  })
  check('the meeting deletes cleanly after the folder was reset', del.ok)
} finally {
  setFolder(null)
  rmSync(CLIP, { force: true })
  rmSync(CUSTOM, { recursive: true, force: true })
  process.stdout.write('\nsetting restored, test folder removed\n')
}

process.stdout.write(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
