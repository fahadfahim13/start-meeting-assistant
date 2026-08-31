#!/usr/bin/env node
/**
 * Answer one question with measurements: is each audio track actually capturing?
 *
 * "The other person's voice is missing" means the SYSTEM track (WASAPI loopback
 * via Chromium) captured nothing. That has several distinct causes which look
 * identical from the outside, so this plays a known continuous tone through the
 * default output device, records through the real app, and measures both tracks
 * separately.
 *
 * M-020: the render session must be ALIVE BEFORE capture starts — a session
 * opened mid-capture does not reach the loopback stream. So the player starts
 * first and keeps playing throughout.
 *
 * Usage: node scripts/audio-diagnose.mjs [seconds]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ROOT, runApp, killStrays } from './electron-run.mjs'

const SECONDS = Math.max(8, parseInt(process.argv[2] ?? '14', 10) || 14)
const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const APPDATA = process.env.APPDATA ?? ''
const RECDIR = path.join(APPDATA, 'MeetFroge', 'recordings')
const TMP = path.join(os.tmpdir(), 'meetfroge-audio-diag')
const TONE = path.join(TMP, 'tone.wav')
const OUT = path.join(ROOT, 'out', 'e2e.json')

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })

// A two-tone alternation is unmistakable in a spectrum and cannot be confused
// with room noise or a hum.
execFileSync(FFMPEG, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `sine=frequency=600:duration=${SECONDS + 20}`,
  '-f', 'lavfi', '-i', `sine=frequency=900:duration=${SECONDS + 20}`,
  '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest,volume=0.8',
  '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', TONE,
])

/** volumedetect prints to STDERR, so read stderr, not stdout. */
function ffmpegStderr(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' })
  return String(r.stderr ?? '')
}

function levels(file, index) {
  return ffmpegStderr([
    '-hide_banner', '-nostats', '-vn', '-i', file,
    '-map', `0:a:${index}`, '-af', 'volumedetect', '-f', 'null', '-',
  ])
}

function parse(stderr) {
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  const x = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  return { mean: m ? parseFloat(m[1]) : null, max: x ? parseFloat(x[1]) : null }
}

killStrays()
// The folder does not exist until the first recording.
mkdirSync(RECDIR, { recursive: true })
const before = new Set(readdirSync(RECDIR).filter((f) => f.endsWith('.mkv')))

process.stdout.write(`playing a 600+900 Hz tone through the DEFAULT output device...\n`)
const player = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `$p = New-Object System.Media.SoundPlayer '${TONE}'; $p.PlaySync()`],
  { stdio: 'ignore' },
)

// Give the render session time to be genuinely open before capture (M-020).
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 2500'], { stdio: 'ignore' })

process.stdout.write(`recording ${SECONDS}s through the app (mic + system)...\n`)
const run = runApp({
  env: { MEETFROGE_AUTOREC: String(SECONDS), MEETFROGE_SEGTIME: '30' },
  expectFile: OUT,
})
try { player.kill() } catch { /* may have finished */ }

if (!run.ok) {
  process.stdout.write(`FAILED: ${run.reason}\n`)
  process.exit(1)
}

const added = readdirSync(RECDIR).filter((f) => f.endsWith('.mkv') && !before.has(f))
if (added.length === 0) {
  process.stdout.write('FAILED: no recording was produced\n')
  process.exit(1)
}
const file = path.join(RECDIR, added[0])
process.stdout.write(`\nrecording: ${added[0]}\n`)

const streams = execFileSync(
  path.join(ROOT, 'resources', 'bin', 'ffprobe.exe'),
  ['-v', 'error', '-show_entries', 'stream=index,codec_type', '-of', 'csv=p=0', file],
  { encoding: 'utf8' },
)
const audioCount = streams.split('\n').filter((l) => l.includes('audio')).length
process.stdout.write(`audio tracks: ${audioCount}\n\n`)

const names = ['mic (you)', 'system (everyone else)']
const results = []
for (let i = 0; i < audioCount; i++) {
  const lv = parse(levels(file, i))
  results.push(lv)
  const verdict =
    lv.mean === null ? 'unmeasurable'
      : Math.abs(lv.mean - lv.max) < 0.5 && lv.mean < -80 ? 'DIGITAL SILENCE — captured nothing'
        : lv.mean < -45 ? 'very quiet — no sustained sound'
          : 'has sound'
  process.stdout.write(
    `a:${i} ${names[i] ?? 'track'}\n    mean ${lv.mean} dB / max ${lv.max} dB  ->  ${verdict}\n`,
  )
}

// Was the tone actually there? Look for energy at 600/900 Hz on the system track.
if (audioCount > 1) {
  process.stdout.write('\nchecking the system track for the injected tone...\n')
  const spec = ffmpegStderr([
    '-hide_banner', '-nostats', '-vn', '-i', file, '-map', '0:a:1',
    '-af', 'bandpass=f=750:width_type=h:w=400,volumedetect', '-f', 'null', '-',
  ])
  const band = parse(spec)
  process.stdout.write(`    600-900 Hz band: mean ${band.mean} dB / max ${band.max} dB\n`)
  const heard = band.mean !== null && band.mean > -60
  process.stdout.write(`\n${heard ? 'SYSTEM AUDIO IS WORKING — the tone was captured.' : 'SYSTEM AUDIO CAPTURED NOTHING.'}\n`)
  if (!heard) {
    process.stdout.write(
      '\nMost likely causes, in order:\n' +
        '  1. Windows default output device is not the one the sound played on\n' +
        '     (this machine has three active endpoints: Headphones, Headset, Speaker).\n' +
        '  2. Output volume muted or at zero.\n' +
        '  3. The loopback stream attached to a different endpoint than playback (M-019).\n',
    )
  }
}

rmSync(TMP, { recursive: true, force: true })
process.stdout.write(`\nrecording kept for inspection: ${file}\n`)
