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

const tmp = path.join(os.tmpdir(), 'meetfroge-sync')


// --- 1. burst TRAIN: a 1 kHz pip every 3 s for 30 s ------------------------
// A single late-fired burst proved fragile (M-020): the verified-reliable
// pattern (continuous-tone A/B test) is a player that starts BEFORE the app
// and keeps the render session alive across the whole recording. Every
// repetition carries the same clock offset; correlation picks the strongest.
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.15',
  '-af', 'apad=pad_dur=2.85,aloop=loop=9:size=144000,volume=0.9',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', `${tmp}-burst.wav`,
], { shell: false })

// --- 2. player first, then record via the app ------------------------------
rmSync(e2eFile, { force: true })
console.log(`starting burst train (pip every 3 s), then recording ${RECORD_S}s...`)
const player = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$p = New-Object System.Media.SoundPlayer '${tmp}-burst.wav'; $p.PlaySync()`,
], { shell: false, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 2000)) // render session live before capture starts

const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_AUTOREC: String(RECORD_S) },
  stdio: 'ignore',
})

await new Promise((resolve) => appProc.on('exit', resolve))
try { player.kill() } catch { /* may have finished */ }

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
const micEnv = envelope(mic)
const sysEnv = envelope(sys)
const micLoc = locate(micEnv, 0)
const sysLoc = locate(sysEnv, 0)
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

// --- 5. whole-envelope cross-correlation ------------------------------------
// With a periodic train, per-track loudest-pip picking can select DIFFERENT
// repetitions (3 s apart). Correlating the FULL envelopes within ±half-period
// is unambiguous: every repetition reinforces the true offset peak.
const HALF_PERIOD_WINDOWS = Math.floor((1.4 * SR) / WIN) // ±1.4 s in 20 ms windows
const n = Math.min(micEnv.length, sysEnv.length)
let envBest = { lag: 0, score: -Infinity }
for (let lag = -HALF_PERIOD_WINDOWS; lag <= HALF_PERIOD_WINDOWS; lag++) {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const a = sysEnv[i] ?? 0
    const b = micEnv[i + lag] ?? 0
    acc += a * b
  }
  if (acc > envBest.score) envBest = { lag, score: acc }
}
// sample-level refinement ±40 ms around the envelope estimate
const coarse = envBest.lag * WIN
const REFINE = Math.floor(SR * 0.04)
let best = { lag: coarse, score: -Infinity }
for (let lag = coarse - REFINE; lag <= coarse + REFINE; lag++) {
  let acc = 0
  for (let i = 0; i < Math.min(sys.length, SR * 20); i += 2) {
    const a = sys[i] ?? 0
    const b = mic[i + lag] ?? 0
    acc += a * b
  }
  if (acc > best.score) best = { lag, score: acc }
}

const degenerate = Math.abs(envBest.lag) >= HALF_PERIOD_WINDOWS - 1
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
