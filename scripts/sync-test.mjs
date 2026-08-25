// Mic ↔ system-audio alignment harness (Phase 1 verification), v2.
//
// Method: record ~25 s unattended (MEETFROGE_AUTOREC) and play a tone burst
// through the speakers mid-recording. The burst reaches the SYSTEM track
// digitally (loopback) and the MIC track acoustically (speaker → microphone).
// The time difference between the burst's position in each track is the real
// alignment error — the number that decides whether a merged transcript
// timeline attributes words to the right moment.
//
// v2 fixes, after v1 produced a degenerate boundary result (M-005's rule —
// suspect the measurement first — applied to our own harness):
// - burst timing is anchored to the RECORDING FILE appearing, not app launch
//   (boot + device enumeration takes a variable ~6 s)
// - the burst is located in each track independently by energy envelope, then
//   refined by cross-correlation around the candidates
// - a correlation peak at the search boundary is reported as DEGENERATE, and
//   an inaudible burst in the mic reports "raise speaker volume", never a number
//
// Usage: node scripts/sync-test.mjs   (machine otherwise idle, speakers audible)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eFile = path.join(root, 'out', 'e2e.json')
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const RECORD_S = 25
const BURST_AFTER_FILE_S = 6

const tmp = path.join(os.tmpdir(), 'meetfroge-sync')

function listRecordings() {
  try {
    return new Set(readdirSync(recDir).filter((f) => f.endsWith('.mkv')))
  } catch {
    return new Set()
  }
}

// --- 1. burst wav: two sharp pips, distinct frequencies --------------------
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.1,apad=pad_dur=0.4',
  '-f', 'lavfi', '-i', 'sine=frequency=1500:duration=0.1',
  '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,volume=0.9[a]', '-map', '[a]',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', `${tmp}-burst.wav`,
], { shell: false })

// --- 2. record via the app; burst anchored to file creation ----------------
rmSync(e2eFile, { force: true })
const before = listRecordings()
console.log(`recording ${RECORD_S}s; burst fires ${BURST_AFTER_FILE_S}s after the file appears...`)

const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_AUTOREC: String(RECORD_S) },
  stdio: 'ignore',
})

let burstScheduled = false
const watcher = setInterval(() => {
  if (burstScheduled) return
  const now = listRecordings()
  for (const f of now) {
    if (!before.has(f)) {
      burstScheduled = true
      clearInterval(watcher)
      console.log(`file appeared (${f}) — burst in ${BURST_AFTER_FILE_S}s`)
      setTimeout(() => {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p = New-Object System.Media.SoundPlayer '${tmp}-burst.wav'; $p.PlaySync()`,
        ], { shell: false, stdio: 'ignore' })
      }, BURST_AFTER_FILE_S * 1000)
      return
    }
  }
}, 250)

await new Promise((resolve) => appProc.on('exit', resolve))
clearInterval(watcher)

if (!existsSync(e2eFile)) {
  console.error('SYNC FAIL: no e2e.json produced')
  process.exit(1)
}
const e2e = JSON.parse(readFileSync(e2eFile, 'utf8'))
if (!e2e.ok) {
  console.error('SYNC FAIL: recording failed', e2e)
  process.exit(1)
}

// --- 3. extract both audio tracks ------------------------------------------
const files = readdirSync(recDir)
  .filter((f) => f.endsWith('.mkv'))
  .map((f) => ({ f, t: statSync(path.join(recDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
const mkv = path.join(recDir, files[0].f)
console.log(`analyzing ${files[0].f}`)

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

// --- 4. locate the burst in each track by short-window energy --------------
const WIN = Math.floor(SR / 50) // 20 ms windows
function envelope(x) {
  const out = []
  for (let i = 0; i + WIN <= x.length; i += WIN) {
    let acc = 0
    for (let j = 0; j < WIN; j++) acc += x[i + j] * x[i + j]
    out.push(Math.sqrt(acc / WIN))
  }
  return out
}
function locate(env, skipWindows) {
  let bestI = -1
  let bestV = -Infinity
  for (let i = skipWindows; i < env.length; i++) {
    if (env[i] > bestV) {
      bestV = env[i]
      bestI = i
    }
  }
  const sorted = [...env].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 1
  return { atS: (bestI * WIN) / SR, peak: bestV, median, snr: bestV / Math.max(1, median) }
}

// skip the first second — recording-start transients are not the burst
const micLoc = locate(envelope(mic), 50)
const sysLoc = locate(envelope(sys), 50)
console.log(`sys burst  : ${sysLoc.atS.toFixed(2)}s (snr ${sysLoc.snr.toFixed(1)})`)
console.log(`mic burst  : ${micLoc.atS.toFixed(2)}s (snr ${micLoc.snr.toFixed(1)})`)

if (sysLoc.snr < 5) {
  console.error('SYNC INCONCLUSIVE: burst not found in the system track — was audio playing elsewhere?')
  process.exit(2)
}
if (micLoc.snr < 3) {
  console.error('SYNC INCONCLUSIVE: the microphone did not hear the burst clearly.')
  console.error('Raise the speaker volume and run again.')
  process.exit(2)
}

// --- 5. refine with cross-correlation around the located positions ---------
const coarseOffset = Math.round((micLoc.atS - sysLoc.atS) * SR)
const wStart = Math.max(0, Math.floor(sysLoc.atS * SR) - SR / 2)
const wLen = Math.min(SR * 2, sys.length - wStart)
const REFINE = Math.floor(SR * 0.3) // ±300 ms around the coarse estimate
let best = { lag: coarseOffset, score: -Infinity }
for (let lag = coarseOffset - REFINE; lag <= coarseOffset + REFINE; lag++) {
  let acc = 0
  for (let i = 0; i < wLen; i += 2) {
    const a = sys[wStart + i] ?? 0
    const b = mic[wStart + i + lag] ?? 0
    acc += a * b
  }
  if (acc > best.score) best = { lag, score: acc }
}

const degenerate = Math.abs(best.lag - coarseOffset) >= REFINE - 2
const offsetMs = (best.lag / SR) * 1000

console.log('\n' + '='.repeat(56))
console.log('SYNC RESULT — mic vs system audio alignment')
console.log('='.repeat(56))
if (degenerate) {
  console.log('DEGENERATE: correlation peaked at the search boundary — no reliable signal.')
  process.exit(2)
}
console.log(`offset : ${offsetMs.toFixed(1)} ms (positive = mic lags system)`)
console.log('budget : ±100 ms  (acoustic path adds ~1-3 ms)')
const pass = Math.abs(offsetMs) <= 100
console.log(pass ? 'SYNC PASS' : 'SYNC FAIL')
process.exit(pass ? 0 : 1)
