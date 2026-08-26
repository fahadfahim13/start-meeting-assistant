// Diarization E2E (Phase 4 verification).
//
// Plays a two-voice TTS conversation (Hazel + Zira alternating) through the
// speakers while the app records, runs the full pipeline (extract → transcribe
// → diarize), and asserts that the system track ends up attributed to at least
// TWO distinct "Speaker N" identities — the thing diarization exists to do.
//
// Usage: node scripts/diarize-test.mjs   (machine otherwise idle, volume up)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultFile = path.join(root, 'out', 'transcribe-e2e.json')
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const RECORD_S = 35

// --- 1. build the two-voice conversation -----------------------------------
const wav = path.join(os.tmpdir(), 'meetfroge-two-voices.wav')
const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('${wav}')
$s.SelectVoice('Microsoft Hazel Desktop')
$s.Speak('Good morning everyone. Let us review the quarterly numbers and discuss the roadmap for the next release.')
$s.SelectVoice('Microsoft Zira Desktop')
$s.Speak('Thanks for the introduction. I think the revenue targets look achievable, but we need to hire two more engineers.')
$s.SelectVoice('Microsoft Hazel Desktop')
$s.Speak('That is a fair point. Let us allocate budget for the new positions in the next quarter.')
$s.SelectVoice('Microsoft Zira Desktop')
$s.Speak('Agreed. I will prepare the job descriptions by Friday and send them to the team for review.')
$s.Dispose()
`
const gen = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  shell: false,
  encoding: 'utf8',
})
if (!existsSync(wav)) {
  console.error('TTS generation failed:', gen.stderr?.slice(0, 400))
  process.exit(2)
}

const listRecordings = () => {
  try {
    return new Set(readdirSync(recDir))
  } catch {
    return new Set()
  }
}

rmSync(resultFile, { force: true })
const before = listRecordings()

console.log(`recording ${RECORD_S}s with a two-voice conversation playing; then full pipeline...`)
const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_AUTOREC: String(RECORD_S), MEETFROGE_AUTOPROCESS: '1' },
  stdio: 'ignore',
})

let played = false
const watcher = setInterval(() => {
  if (played) return
  for (const f of listRecordings()) {
    if (!before.has(f)) {
      played = true
      clearInterval(watcher)
      console.log('recording started — playing conversation (~29 s)')
      setTimeout(() => {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p = New-Object System.Media.SoundPlayer '${wav}'; $p.PlaySync()`,
        ], { shell: false, stdio: 'ignore' })
      }, 1000)
      return
    }
  }
}, 250)

const timeout = setTimeout(() => {
  console.error('DIARIZE E2E TIMEOUT — killing app')
  appProc.kill()
}, 15 * 60_000)

const code = await new Promise((resolve) => appProc.on('exit', resolve))
clearTimeout(timeout)
clearInterval(watcher)

if (!existsSync(resultFile)) {
  console.error(`DIARIZE E2E FAIL: app exited ${code} without a result file`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'))
console.log('\njobs:', JSON.stringify(result.jobs))

const systemSegs = result.segments.filter((s) => s.track === 'system')
for (const s of systemSegs) {
  console.log(`  [${s.speaker}] ${String(s.startMs).padStart(6)}ms  ${s.text.slice(0, 80)}`)
}

const speakers = new Set(systemSegs.map((s) => s.speaker))
const diarizeJob = result.jobs.find((j) => j.stage === 'diarize')
console.log(`\ndistinct system-track speakers: ${[...speakers].join(', ') || 'none'}`)
console.log(`diarize job: ${diarizeJob?.state}`)

// Content sanity too — the transcript should contain conversation substance.
const text = systemSegs.map((s) => s.text.toLowerCase()).join(' ')
const contentOk = text.includes('quarterly') || text.includes('engineers') || text.includes('budget')

const pass = result.ok && diarizeJob?.state === 'done' && speakers.size >= 2 && contentOk
console.log(pass ? '\nDIARIZE E2E PASS' : '\nDIARIZE E2E FAIL')
process.exit(pass ? 0 : 1)
