// Summarization E2E (Phase 6 verification).
//
// The two-voice TTS conversation contains concrete decisions and action items
// ("allocate budget", "prepare the job descriptions by Friday"). The app
// records it, the FULL pipeline runs (through summarize), and the assertions
// check the summary actually contains that substance — content, not exit codes.
//
// Usage: node scripts/summary-test.mjs   (machine otherwise idle, volume up)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultFile = path.join(root, 'out', 'transcribe-e2e.json')
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const RECORD_S = 35

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
spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { shell: false })
if (!existsSync(wav)) {
  console.error('TTS generation failed')
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

console.log(`recording ${RECORD_S}s conversation, then the FULL pipeline incl. summarize...`)
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
      console.log('recording started — playing conversation')
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
  console.error('SUMMARY E2E TIMEOUT — killing app')
  appProc.kill()
}, 25 * 60_000)
const code = await new Promise((resolve) => appProc.on('exit', resolve))
clearTimeout(timeout)
clearInterval(watcher)

if (!existsSync(resultFile)) {
  console.error(`SUMMARY E2E FAIL: app exited ${code} without a result file`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'))
console.log('\njobs:', JSON.stringify(result.jobs))

const summary = result.summary
if (!summary) {
  console.error('SUMMARY E2E FAIL: no summary in the dump')
  process.exit(1)
}
console.log(`\ntitle   : ${summary.title}`)
console.log(`tldr    : ${summary.tldr}`)
console.log(`summary : ${summary.summary.slice(0, 200)}...`)
console.log(`decisions:`)
for (const d of summary.decisions) console.log(`  - ${d.text}${d.t != null ? ` (t=${d.t})` : ''}`)
console.log(`action items:`)
for (const a of summary.action_items ?? []) console.log(`  - ${a.text}${a.assignee ? ` [${a.assignee}]` : ''}`)

const everything = JSON.stringify(summary).toLowerCase()
const substance = ['engineer', 'budget', 'job description', 'friday', 'quarterly', 'revenue']
const found = substance.filter((w) => everything.includes(w))
console.log(`\nsubstance check: ${found.length}/${substance.length} — ${found.join(', ')}`)

const summarizeJob = result.jobs.find((j) => j.stage === 'summarize')
const pass =
  summarizeJob?.state === 'done' &&
  !summary.degraded &&
  found.length >= 3 &&
  (summary.action_items ?? []).length >= 1 &&
  summary.decisions.length >= 1
console.log(pass ? '\nSUMMARY E2E PASS' : '\nSUMMARY E2E FAIL')
process.exit(pass ? 0 : 1)
