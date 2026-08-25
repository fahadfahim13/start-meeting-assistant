// Spike 4 - llama.cpp inference benchmark, CPU vs Vulkan offload.
//
// THE QUESTION: how fast does a 4B summarizer run on this machine's Vega 7 iGPU
// compared to CPU-only, and does that make map-reduce summarization of a 1-hour
// meeting practical?
//
// EXPECTATION TO TEST (from a published Ryzen 5 5600H + Vega 7 datapoint, which is
// near-identical hardware): Vulkan roughly DOUBLES prompt processing (34 -> 76 t/s)
// but leaves token generation flat at ~10 t/s, because generation is bound by DDR4
// memory bandwidth rather than compute. If that holds, offload is worth having -
// summarization is prompt-heavy, since it reads a long transcript and writes a short
// summary - but it is not transformative.
//
// Method: the SAME Vulkan-capable binary is used for both runs. Only -ngl differs
// (0 layers offloaded vs all). That isolates the offload variable properly; comparing
// a CPU build against a Vulkan build would confound compiler flags with the thing
// being measured.
//
// Usage:
//   node bench.mjs --model models/qwen3-4b-instruct-q4_k_m.gguf

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')
const BENCH = path.join(__dirname, 'bin', 'llama-bench.exe')

const args = process.argv.slice(2)
const argOf = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const MODEL = argOf('--model', path.join(__dirname, 'models', 'qwen3-4b-instruct-q4_k_m.gguf'))
const THREADS = parseInt(argOf('--threads', String(Math.max(1, os.cpus().length - 2))), 10)

// Prompt size chosen to resemble the real workload: a map-reduce chunk of transcript
// is ~3000 tokens, so 2048 is representative. Generation of 128 tokens matches the
// length of a chunk summary.
const PROMPT_TOKENS = argOf('--pp', '2048')
const GEN_TOKENS = argOf('--tg', '128')

if (!existsSync(BENCH)) {
  console.error(`llama-bench not found at ${BENCH}`)
  process.exit(2)
}
if (!existsSync(MODEL)) {
  console.error(`model not found at ${MODEL}`)
  process.exit(2)
}

mkdirSync(OUT_DIR, { recursive: true })

function listDevices() {
  const cli = path.join(__dirname, 'bin', 'llama-cli.exe')
  const r = spawnSync(cli, ['--list-devices'], { shell: false, encoding: 'utf8' })
  return (r.stdout || '').trim()
}

// llama-bench emits markdown by default; -o json gives us something parseable.
function run(label, ngl) {
  const a = [
    '-m', MODEL,
    '-p', PROMPT_TOKENS,
    '-n', GEN_TOKENS,
    '-t', String(THREADS),
    '-ngl', String(ngl),
    '-r', '3', // three repetitions, llama-bench reports mean +/- stddev
    '-o', 'json',
  ]
  console.log(`\n[${label}] llama-bench -ngl ${ngl} -t ${THREADS} -p ${PROMPT_TOKENS} -n ${GEN_TOKENS}`)
  const t0 = Date.now()
  const r = spawnSync(BENCH, a, {
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const elapsedS = +((Date.now() - t0) / 1000).toFixed(1)

  if (r.status !== 0) {
    console.error(`[${label}] FAILED (exit ${r.status})`)
    console.error((r.stderr || '').split(/\r?\n/).slice(-15).join('\n'))
    return { label, ngl, ok: false, exitCode: r.status, elapsedS, error: (r.stderr || '').slice(-2000) }
  }

  let rows = []
  try {
    // llama-bench prints a JSON array; stderr carries load logs, so parse stdout only.
    const start = r.stdout.indexOf('[')
    rows = JSON.parse(r.stdout.slice(start))
  } catch (e) {
    return { label, ngl, ok: false, elapsedS, error: `parse failed: ${e.message}`, raw: r.stdout.slice(0, 2000) }
  }

  const pick = (kind) => {
    const row = rows.find((x) => (x.n_prompt > 0) === (kind === 'pp'))
    if (!row) return null
    return {
      tokensPerSecond: +Number(row.avg_ts).toFixed(2),
      stddev: row.stddev_ts != null ? +Number(row.stddev_ts).toFixed(2) : null,
      nTokens: kind === 'pp' ? row.n_prompt : row.n_gen,
    }
  }

  // Confirm the backend actually used, rather than trusting the flag we passed.
  const backend = rows[0] ? rows[0].backends || rows[0].backend : null
  const gpuLayers = rows[0] ? rows[0].n_gpu_layers : null

  return {
    label,
    ngl,
    ok: true,
    elapsedS,
    backend,
    gpuLayers,
    promptProcessing: pick('pp'),
    tokenGeneration: pick('tg'),
  }
}

console.log('devices:\n' + listDevices())

const cpu = run('cpu', 0)
const vulkan = run('vulkan', 99)

function speedup(a, b, field) {
  if (!a || !b || !a.ok || !b.ok) return null
  const x = a[field] && a[field].tokensPerSecond
  const y = b[field] && b[field].tokensPerSecond
  if (!x || !y) return null
  return +(y / x).toFixed(2)
}

const ppSpeedup = speedup(cpu, vulkan, 'promptProcessing')
const tgSpeedup = speedup(cpu, vulkan, 'tokenGeneration')

// What this means for the actual product: a 1-hour meeting is roughly 10k transcript
// tokens, summarized by map-reduce into ~4 chunks of 3k with a ~800 token output.
function projectSummaryMinutes(r) {
  if (!r.ok || !r.promptProcessing || !r.tokenGeneration) return null
  const promptTokens = 12000 // ~10k transcript + prompt scaffolding across map+reduce
  const genTokens = 1600 // chunk notes + final summary
  const s = promptTokens / r.promptProcessing.tokensPerSecond + genTokens / r.tokenGeneration.tokensPerSecond
  return +(s / 60).toFixed(1)
}

const result = {
  spike: '04-llama-vulkan',
  date: new Date().toISOString(),
  host: {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0] && os.cpus()[0].model,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
  },
  devices: listDevices(),
  config: {
    model: path.basename(MODEL),
    modelBytes: statSync(MODEL).size,
    threads: THREADS,
    promptTokens: +PROMPT_TOKENS,
    genTokens: +GEN_TOKENS,
    repetitions: 3,
    note: 'Same Vulkan-capable binary for both runs; only -ngl differs.',
  },
  runs: { cpu, vulkan },
  comparison: {
    promptProcessingSpeedup: ppSpeedup,
    tokenGenerationSpeedup: tgSpeedup,
    expected: {
      promptProcessingSpeedup: 2.2,
      tokenGenerationSpeedup: 1.0,
      source: 'Ryzen 5 5600H + Vega 7, llama.cpp discussion #10879',
    },
  },
  projection: {
    note: '1-hour meeting: ~12k prompt tokens, ~1.6k generated, across map-reduce',
    summaryMinutesCpu: projectSummaryMinutes(cpu),
    summaryMinutesVulkan: projectSummaryMinutes(vulkan),
    budgetMinutes: 10,
  },
  verdict: {
    cpuRan: cpu.ok,
    vulkanRan: vulkan.ok,
    vulkanActuallyUsedGpu: vulkan.ok && vulkan.gpuLayers > 0,
    withinSummaryBudget:
      projectSummaryMinutes(vulkan) != null && projectSummaryMinutes(vulkan) <= 10,
  },
}

writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2))

console.log('\n' + '='.repeat(66))
console.log('SPIKE 4 - llama.cpp CPU vs Vulkan')
console.log('='.repeat(66))
const fmt = (r) =>
  r.ok
    ? `pp ${r.promptProcessing?.tokensPerSecond ?? '?'} t/s   tg ${r.tokenGeneration?.tokensPerSecond ?? '?'} t/s   (ngl ${r.gpuLayers})`
    : `FAILED: ${r.error?.slice(0, 200)}`
console.log(`CPU     : ${fmt(cpu)}`)
console.log(`Vulkan  : ${fmt(vulkan)}`)
console.log(`speedup : prompt ${ppSpeedup ?? '?'}x   generation ${tgSpeedup ?? '?'}x`)
console.log(`expected: prompt 2.2x        generation 1.0x`)
console.log('-'.repeat(66))
console.log(`projected 1-hour-meeting summary: CPU ${result.projection.summaryMinutesCpu} min, Vulkan ${result.projection.summaryMinutesVulkan} min (budget 10)`)
console.log('='.repeat(66))

process.exit(cpu.ok && vulkan.ok ? 0 : 1)
