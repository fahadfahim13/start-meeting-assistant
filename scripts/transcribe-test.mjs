// Transcription E2E (Phase 3 verification).
//
// Records ~25 s through the full app while REAL SPEECH (whisper.cpp's jfk.wav)
// plays through the speakers — so it lands in the SYSTEM track digitally via
// loopback — then lets the pipeline extract + VAD + transcribe, and asserts the
// transcript actually contains the famous words. This is a content assertion,
// not a "did it exit 0" assertion.
//
// Usage: node scripts/transcribe-test.mjs   (machine otherwise idle)

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultFile = path.join(root, 'out', 'transcribe-e2e.json')
const jfk = path.join(root, 'spikes', '03-whisper-vulkan', 'samples', 'jfk.wav')
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const RECORD_S = 25

if (!existsSync(jfk)) {
  console.error(`speech sample missing: ${jfk}`)
  process.exit(2)
}

const listRecordings = () => {
  try {
    return new Set(readdirSync(recDir).filter((f) => f.endsWith('.mkv') || !f.includes('.')))
  } catch {
    return new Set()
  }
}

rmSync(resultFile, { force: true })
const before = listRecordings()

console.log(`recording ${RECORD_S}s with JFK speech playing; then full pipeline...`)
const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_AUTOREC: String(RECORD_S), MEETFROGE_AUTOPROCESS: '1' },
  stdio: 'ignore',
})

// Play the 11 s speech twice, anchored to the recording actually starting.
let played = false
const watcher = setInterval(() => {
  if (played) return
  for (const f of listRecordings()) {
    if (!before.has(f)) {
      played = true
      clearInterval(watcher)
      console.log('recording started — playing speech (2×11 s)')
      setTimeout(() => {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p = New-Object System.Media.SoundPlayer '${jfk}'; $p.PlaySync(); $p.PlaySync()`,
        ], { shell: false, stdio: 'ignore' })
      }, 1000)
      return
    }
  }
}, 250)

const timeout = setTimeout(() => {
  console.error('TRANSCRIBE E2E TIMEOUT — killing app')
  appProc.kill()
}, 10 * 60_000) // recording + CPU transcription needs headroom

const code = await new Promise((resolve) => appProc.on('exit', resolve))
clearTimeout(timeout)
clearInterval(watcher)

if (!existsSync(resultFile)) {
  console.error(`TRANSCRIBE E2E FAIL: app exited ${code} without writing ${resultFile}`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'))

console.log('\njobs:', JSON.stringify(result.jobs))
console.log(`segments: ${result.segmentCount}`)
for (const s of result.segments.slice(0, 12)) {
  console.log(`  [${s.track}/${s.speaker}] ${String(s.startMs).padStart(6)}ms  ${s.text}`)
}

// Content assertion: the system track must contain recognizable JFK.
const systemText = result.segments
  .filter((s) => s.track === 'system')
  .map((s) => s.text.toLowerCase())
  .join(' ')
const expected = ['country', 'ask not']
const found = expected.filter((w) => systemText.includes(w))

console.log(`\ncontent check: ${found.length}/${expected.length} expected phrases found (${found.join(', ') || 'none'})`)
const pass = result.ok && found.length >= 1
console.log(pass ? '\nTRANSCRIBE E2E PASS' : '\nTRANSCRIBE E2E FAIL')
process.exit(pass ? 0 : 1)
