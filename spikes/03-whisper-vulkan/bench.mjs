// Spike 3 - whisper.cpp transcription benchmark, CPU vs Vulkan.
//
// THE QUESTION: how fast is whisper.cpp on this machine's Vega 7 (GCN5) iGPU
// compared to CPU-only?
//
// This matters more than any other inference number in the project. The published
// "12x iGPU speedup" figure was measured on a Radeon 680M (RDNA2), two architecture
// generations newer than the reference machine. If it transfers, transcription runs
// at ~3-4x realtime and the product feels instant. If it does not, transcription
// runs at ~0.3x realtime and a 1-hour meeting takes 3 hours - a completely different
// product. MEASURE, DO NOT ASSUME.
//
// Usage:
//   node bench.mjs --whisper <path-to-whisper-cli.exe> --model <path-to-ggml.bin>
//                  [--audio <wav>] [--label cpu|vulkan] [--threads N]
//
// Writes out/result-<label>.json. Compare the two runs with compare.mjs.

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')

const args = process.argv.slice(2)
const argOf = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const WHISPER = argOf('--whisper', null)
const MODEL = argOf('--model', null)
const LABEL = argOf('--label', 'cpu')
const THREADS = parseInt(argOf('--threads', String(Math.max(1, os.cpus().length - 2))), 10)
const AUDIO = argOf('--audio', path.join(OUT_DIR, 'bench-10min.wav'))

if (!WHISPER || !MODEL) {
  console.error('usage: node bench.mjs --whisper <exe> --model <bin> [--label cpu|vulkan]')
  process.exit(2)
}
for (const [name, p] of [['whisper', WHISPER], ['model', MODEL]]) {
  if (!existsSync(p)) {
    console.error(`${name} not found: ${p}`)
    process.exit(2)
  }
}

mkdirSync(OUT_DIR, { recursive: true })

// --- build the benchmark audio if it does not exist -------------------------
//
// Deterministic and self-contained: whisper.cpp ships samples/jfk.wav (11s of real
// speech). Looping it to ~10 minutes gives a reproducible benchmark with no external
// download. Real meeting audio would be better for accuracy testing, but for a pure
// throughput measurement what matters is that both runs see identical input.

function ensureAudio() {
  if (existsSync(AUDIO)) {
    console.log(`using existing audio: ${AUDIO} (${statSync(AUDIO).size} bytes)`)
    return
  }
  const sample = path.join(__dirname, 'samples', 'jfk.wav')
  if (!existsSync(sample)) {
    console.error(`benchmark audio missing and sample not found at ${sample}`)
    console.error(`fetch it: curl -L -o samples/jfk.wav https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav`)
    process.exit(2)
  }
  console.log('building 10-minute benchmark audio from jfk.wav...')
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-stream_loop', '54', '-i', sample,
      '-t', '600',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      AUDIO,
    ],
    { shell: false, encoding: 'utf8' }
  )
  if (r.status !== 0) {
    console.error('ffmpeg failed:', r.stderr)
    process.exit(1)
  }
}

function audioDurationS(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { shell: false, encoding: 'utf8' }
  )
  return r.status === 0 ? parseFloat(r.stdout.trim()) : null
}

ensureAudio()
const durationS = audioDurationS(AUDIO)

// --- run --------------------------------------------------------------------

const whisperArgs = [
  '-m', MODEL,
  '-f', AUDIO,
  '-t', String(THREADS),
  '-l', 'en',
  '-oj', // JSON output, same as production will use
  '-of', path.join(OUT_DIR, `transcript-${LABEL}`),
  '-pp', // print progress so a long run is observable
]

console.log(`\nrunning whisper.cpp [${LABEL}] with ${THREADS} threads...`)
console.log(`  ${WHISPER} ${whisperArgs.join(' ')}\n`)

const t0 = Date.now()
const run = spawnSync(WHISPER, whisperArgs, {
  shell: false,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
})
const elapsedMs = Date.now() - t0

const stderr = run.stderr || ''
const stdout = run.stdout || ''
const combined = stderr + stdout

// whisper.cpp announces its backend at startup. This is the only reliable way to
// confirm Vulkan is actually in use - the binary falls back to CPU silently.
// NOTE: must match a device-INIT line, not just the word "vulkan" - the build
// banner prints "VULKAN = 0/1" in every run, which made the loose /vulkan/i
// report true even for the CPU binary (caught reading B-007).
const vulkanDetected = /ggml_vulkan:.*(?:Found|device)|using\s+Vulkan|Vulkan\d+\s*:/i.test(combined)
const backendLines = combined
  .split(/\r?\n/)
  .filter((l) => /ggml_vulkan|using .* backend|device \d|whisper_backend_init|BLAS|Metal|CUDA/i.test(l))
  .slice(0, 12)

const realtimeFactor = durationS ? +(durationS / (elapsedMs / 1000)).toFixed(3) : null

const result = {
  spike: '03-whisper-vulkan',
  label: LABEL,
  date: new Date().toISOString(),
  host: {
    cpus: os.cpus().length,
    model: os.cpus()[0] && os.cpus()[0].model,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
  },
  config: {
    whisper: WHISPER,
    model: path.basename(MODEL),
    modelBytes: statSync(MODEL).size,
    threads: THREADS,
    audio: path.basename(AUDIO),
    audioDurationS: durationS,
  },
  run: {
    exitCode: run.status,
    elapsedMs,
    elapsedS: +(elapsedMs / 1000).toFixed(2),
    realtimeFactor,
    vulkanDetected,
    backendLines,
  },
  verdict: {
    completed: run.status === 0,
    // Vulkan runs must actually be using Vulkan, or the comparison is meaningless.
    backendMatchesLabel: LABEL === 'vulkan' ? vulkanDetected : true,
  },
}

writeFileSync(path.join(OUT_DIR, `result-${LABEL}.json`), JSON.stringify(result, null, 2))

console.log('\n' + '='.repeat(60))
console.log(`SPIKE 3 [${LABEL}]`)
console.log('='.repeat(60))
console.log(`elapsed          : ${result.run.elapsedS}s`)
console.log(`audio duration   : ${durationS}s`)
console.log(`realtime factor  : ${realtimeFactor}x  (higher is better; 1.0 = realtime)`)
console.log(`vulkan detected  : ${vulkanDetected}`)
if (backendLines.length) console.log(`backend:\n  ${backendLines.join('\n  ')}`)
console.log('='.repeat(60))

if (LABEL === 'vulkan' && !vulkanDetected) {
  console.log('\nWARNING: label says vulkan but no Vulkan backend was reported.')
  console.log('The binary likely fell back to CPU. This measurement is NOT a Vulkan result.')
}

process.exit(run.status === 0 ? 0 : 1)
