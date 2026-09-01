#!/usr/bin/env node
/**
 * Prove the camera is really ON the screen track — not that the app said so.
 *
 * A "camera overlay" feature can pass every shape check while compositing
 * nothing: the file still has two video streams, the argv still contains
 * `overlay=`, ffmpeg still exits 0. So this asserts CONTENT (M-015). It records
 * twice through the real app, once with the overlay on and once off, and each
 * time compares the rectangle where the camera should be against the raw camera
 * track (v:1) at the same timestamp:
 *
 *   overlay ON  -> that rectangle IS the camera        -> high PSNR
 *   overlay OFF -> that rectangle is whatever was there -> low PSNR
 *
 * The control run is the point. Without it the test would also pass on a
 * desktop that happens to resemble a webcam, and "high PSNR" would mean
 * nothing. Measured on REF-01 while this was written: 24.2 dB on, 5.9 dB off.
 *
 * The inner 80% of the box is compared, so the white border and the rounded
 * corners — which are deliberately NOT in the camera track — do not skew it.
 *
 * Usage: node scripts/pip-test.mjs [seconds]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ROOT, runApp, killStrays } from './electron-run.mjs'

const SECONDS = Math.max(8, parseInt(process.argv[2] ?? '12', 10) || 12)
const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FFPROBE = path.join(ROOT, 'resources', 'bin', 'ffprobe.exe')
const APPDATA = process.env.APPDATA ?? ''
const DB = path.join(APPDATA, 'MeetFroge', 'meetfroge.db')
const OUT = path.join(ROOT, 'out', 'e2e.json')

/** Same measured floor either side of: on must clear it, off must not. */
const PSNR_FLOOR_DB = 15
const SIZE_PCT = 22

function recordingsDir() {
  try {
    const db = new DatabaseSync(DB, { readOnly: true })
    const row = db.prepare("SELECT value FROM settings WHERE key = 'recordingsDir'").get()
    db.close()
    if (row) {
      const configured = JSON.parse(row.value)
      if (configured) return configured
    }
  } catch {
    /* no database yet — fall through to the default */
  }
  return path.join(APPDATA, 'MeetFroge', 'recordings')
}

const RECDIR = recordingsDir()

function setOverlay(position) {
  // A stray instance would hold the DB and the single-instance lock (M-030).
  killStrays()
  const db = new DatabaseSync(DB)
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  stmt.run('cameraOverlay', JSON.stringify(position))
  stmt.run('cameraOverlaySizePct', JSON.stringify(SIZE_PCT))
  db.close()
}

function profileOverlay() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db
    .prepare('SELECT capture_profile FROM meetings ORDER BY started_at DESC LIMIT 5')
    .all()
  db.close()
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.capture_profile)
      if (parsed.cameraOverlay) return parsed.cameraOverlay
    } catch {
      /* older row */
    }
  }
  return null
}

function probe(file, args) {
  return execFileSync(FFPROBE, ['-v', 'error', ...args, file], { encoding: 'utf8' }).trim()
}

/**
 * Record once through the real app and return the finished file.
 *
 * The name comes from the app's own e2e.json rather than from scanning the
 * folder for `*.mkv`: the finished container follows the outputFormat setting,
 * so a directory scan for one extension finds nothing at all when the user has
 * chosen the other, and reports it as "no recording was produced".
 */
function record(label) {
  process.stdout.write(`\n[${label}] recording ${SECONDS}s through the app...\n`)
  const run = runApp({
    env: { MEETFROGE_AUTOREC: String(SECONDS), MEETFROGE_SEGTIME: '30' },
    expectFile: OUT,
  })
  if (!run.ok) throw new Error(run.reason ?? `app run failed (exit ${run.status})`)
  const e2e = JSON.parse(readFileSync(OUT, 'utf8'))
  if (!e2e.ok) throw new Error(`the app reported the recording as bad: ${JSON.stringify(e2e)}`)
  const file = path.join(RECDIR, e2e.file)
  if (!existsSync(file)) throw new Error(`recording not found where expected: ${file}`)
  return file
}

/**
 * Similarity between the overlay rectangle in v:0 and the camera in v:1.
 *
 * Both sides are reduced to gray: the comparison is about whether it is the
 * same PICTURE, and chroma subsampling differences between a composited and a
 * directly-encoded frame would only add noise to that question.
 */
function pipPsnr(file, geom, screenW, screenH) {
  const margin = Math.floor(screenW * 0.02)
  const boxX = geom.position.endsWith('right') ? screenW - geom.boxW - margin : margin
  const boxY = geom.position.startsWith('bottom') ? screenH - geom.boxH - margin : margin
  const innerW = geom.boxW - 2 * geom.borderPx
  const innerH = geom.boxH - 2 * geom.borderPx
  // Inner 80%, centred: skips the border and the rounded corners entirely.
  const cmpW = Math.floor((innerW * 0.8) / 2) * 2
  const cmpH = Math.floor((innerH * 0.8) / 2) * 2
  const offX = Math.floor((innerW - cmpW) / 2)
  const offY = Math.floor((innerH - cmpH) / 2)
  const at = Math.max(1, Math.floor(SECONDS / 2))

  const filter =
    `[0:v:0]crop=${cmpW}:${cmpH}:${boxX + geom.borderPx + offX}:${boxY + geom.borderPx + offY},format=gray[a];` +
    `[1:v:1]scale=${innerW}:${innerH}:force_original_aspect_ratio=increase,crop=${innerW}:${innerH},` +
    `crop=${cmpW}:${cmpH}:${offX}:${offY},format=gray[b];[a][b]psnr`

  // spawnSync, not execFileSync: the psnr filter prints its summary to STDERR
  // like every other ffmpeg log line, and execFileSync returns only stdout — so
  // the number silently came back as "n/a" and both assertions failed.
  const res = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'info', '-y',
     '-ss', String(at), '-i', file, '-ss', String(at), '-i', file,
     '-filter_complex', filter, '-frames:v', '3', '-f', 'null', '-'],
    { encoding: 'utf8', shell: false, windowsHide: true },
  )
  const m = /PSNR y:([0-9.]+)/.exec(`${res.stdout ?? ''}${res.stderr ?? ''}`)
  if (!m) {
    process.stdout.write(`  ffmpeg said: ${String(res.stderr ?? '').slice(-400)}\n`)
    return null
  }
  return parseFloat(m[1])
}

const checks = []
let geom = null
let onDb = null
let offDb = null

try {
  // ---- run 1: overlay ON ---------------------------------------------------
  setOverlay('bottom-right')
  const onFile = record('overlay ON')
  process.stdout.write(`  ${path.basename(onFile)}\n`)

  const streams = probe(onFile, ['-show_entries', 'stream=index,codec_type,width,height', '-of', 'csv=p=0'])
  const video = streams.split('\n').filter((l) => l.includes('video'))
  checks.push(['the camera still has its own track — 2 video streams', video.length === 2])

  geom = profileOverlay()
  checks.push(['capture_profile recorded the overlay geometry', geom !== null && geom.boxW > 0])

  if (geom && video.length === 2) {
    const [, , w, h] = video[0].split(',')
    const screenW = parseInt(w, 10)
    const screenH = parseInt(h, 10)
    checks.push(['v:0 is still full screen size', screenW > 0 && screenH > 0])
    // The box must actually fit on the screen it was sized for.
    checks.push(['the overlay fits inside the frame', geom.boxW < screenW && geom.boxH < screenH])

    onDb = pipPsnr(onFile, geom, screenW, screenH)
    process.stdout.write(`  PSNR(overlay region vs camera track): ${onDb?.toFixed(2) ?? 'n/a'} dB\n`)
    checks.push([`the overlay region IS the camera (>= ${PSNR_FLOOR_DB} dB)`, onDb !== null && onDb >= PSNR_FLOOR_DB])

    // ---- run 2: the control, overlay OFF -----------------------------------
    setOverlay('off')
    const offFile = record('overlay OFF')
    process.stdout.write(`  ${path.basename(offFile)}\n`)
    const offStreams = probe(offFile, ['-show_entries', 'stream=index,codec_type', '-of', 'csv=p=0'])
    checks.push([
      'overlay off still records both video tracks',
      offStreams.split('\n').filter((l) => l.includes('video')).length === 2,
    ])
    offDb = pipPsnr(offFile, geom, screenW, screenH)
    process.stdout.write(`  PSNR(same region, overlay off): ${offDb?.toFixed(2) ?? 'n/a'} dB\n`)
    // Without this the "on" number proves nothing: it must be the OVERLAY that
    // made the region match, not the desktop underneath.
    checks.push([`the control does NOT match (< ${PSNR_FLOOR_DB} dB)`, offDb !== null && offDb < PSNR_FLOOR_DB])
  }
} catch (e) {
  checks.push([`harness ran to completion (${String(e).slice(0, 160)})`, false])
} finally {
  // Leave the app in its default state whatever happened above.
  try {
    setOverlay('bottom-right')
  } catch {
    /* nothing to restore */
  }
}

process.stdout.write('\n')
let failures = 0
for (const [label, ok] of checks) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`)
  if (!ok) failures++
}
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
