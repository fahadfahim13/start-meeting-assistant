// Mic ↔ system-audio alignment harness (Phase 1 verification).
//
// Method: record ~20 s unattended (MEETFROGE_AUTOREC) while playing a tone
// burst through the speakers. The burst reaches the SYSTEM track digitally
// (loopback) and the MIC track acoustically (speaker → microphone). The
// cross-correlation peak between the two tracks around the burst is the
// real-world alignment error between them — the number that decides whether
// a merged transcript timeline attributes words to the right moment.
//
// The acoustic path adds ~1-3 ms (sound travel + mic latency); anything under
// ~50 ms is inaudible in a transcript, the budget is 100 ms.
//
// Usage: node scripts/sync-test.mjs   (run while the machine is otherwise idle)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eFile = path.join(root, 'out', 'e2e.json')
const RECORD_S = 20
const BURST_AT_S = 6

function newestRecording(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.mkv'))
    .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files[0] ? path.join(dir, files[0].f) : null
}

// --- 1. build the burst wav (two sharp 100 ms pips, distinctive to correlate)
const tmp = path.join(os.tmpdir(), 'meetfroge-sync')
rmSync(tmp, { recursive: true, force: true })
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.1,adelay=0|0,apad=pad_dur=0.4',
  '-f', 'lavfi', '-i', 'sine=frequency=1500:duration=0.1',
  '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,volume=0.8[a]', '-map', '[a]',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', `${tmp}-burst.wav`,
], { shell: false })

// --- 2. record via the app, playing the burst mid-recording ---------------
rmSync(e2eFile, { force: true })
console.log(`recording ${RECORD_S}s through the app; burst at ~${BURST_AT_S}s...`)

const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_AUTOREC: String(RECORD_S) },
  stdio: 'ignore',
})

setTimeout(() => {
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = New-Object System.Media.SoundPlayer '${tmp}-burst.wav'; $p.PlaySync()`,
  ], { shell: false, stdio: 'ignore' })
}, (1.5 + BURST_AT_S) * 1000) // autorec starts ~1.5 s after boot

await new Promise((resolve) => appProc.on('exit', resolve))

if (!existsSync(e2eFile)) {
  console.error('SYNC FAIL: no e2e.json produced')
  process.exit(1)
}
const e2e = JSON.parse(readFileSync(e2eFile, 'utf8'))
if (!e2e.ok) {
  console.error('SYNC FAIL: recording failed', e2e)
  process.exit(1)
}

// --- 3. extract both audio tracks as 16 kHz mono pcm ----------------------
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const mkv = newestRecording(recDir)
console.log(`analyzing ${path.basename(mkv)}`)

for (const [spec, name] of [['a:0', 'mic'], ['a:1', 'sys']]) {
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mkv,
    '-map', spec, '-ar', '16000', '-ac', '1', '-f', 's16le', `${tmp}-${name}.pcm`,
  ], { shell: false })
}

const SR = 16_000
const load = (f) => {
  const buf = readFileSync(f)
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
}
const mic = load(`${tmp}-mic.pcm`)
const sys = load(`${tmp}-sys.pcm`)

// --- 4. cross-correlate a window around the burst -------------------------
// window: burst ±2 s in the system track; search offsets ±1 s.
const wStart = Math.max(0, (BURST_AT_S - 2) * SR)
const wLen = Math.min(4 * SR, sys.length - wStart)
const maxLag = SR // ±1 s
let best = { lag: 0, score: -Infinity }
for (let lag = -maxLag; lag <= maxLag; lag += 4) {
  let acc = 0
  for (let i = 0; i < wLen; i += 4) {
    const a = sys[wStart + i] ?? 0
    const b = mic[wStart + i + lag] ?? 0
    acc += a * b
  }
  if (acc > best.score) best = { lag, score: acc }
}
// refine around the coarse peak at full resolution
let fine = { lag: best.lag, score: -Infinity }
for (let lag = best.lag - 8; lag <= best.lag + 8; lag++) {
  let acc = 0
  for (let i = 0; i < wLen; i++) {
    const a = sys[wStart + i] ?? 0
    const b = mic[wStart + i + lag] ?? 0
    acc += a * b
  }
  if (acc > fine.score) fine = { lag, score: acc }
}

const offsetMs = (fine.lag / SR) * 1000
console.log('\n' + '='.repeat(56))
console.log('SYNC RESULT — burst cross-correlation, mic vs system')
console.log('='.repeat(56))
console.log(`offset : ${offsetMs.toFixed(1)} ms (positive = mic lags system)`)
console.log(`budget : ±100 ms`)
const pass = Math.abs(offsetMs) <= 100
console.log(pass ? 'SYNC PASS' : 'SYNC FAIL')
process.exit(pass ? 0 : 1)
