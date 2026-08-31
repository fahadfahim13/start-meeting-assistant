#!/usr/bin/env node
/**
 * Phase B verification: does the pipeline SAY why it produced nothing?
 *
 * The bug this pins (M-023/M-024): a recording whose audio held no speech ran
 * every stage to completion, wrote zero transcript rows, reported `done`, and
 * left the user with "No summary yet" and no error anywhere in the system.
 *
 * Deterministic by construction — synthetic media, no microphone, no speakers,
 * no window focus games (M-014). Two cases:
 *
 *   silence  video + two bit-exact-silent audio tracks
 *            -> extract must skip with PIPELINE_AUDIO_SILENT
 *   tone     video + two audible-but-speechless tracks
 *            -> extract runs, transcribe must skip with PIPELINE_NO_SPEECH
 *
 * The second case is the important one: the audio is genuinely loud, so nothing
 * upstream can dismiss it, and whisper will still find no words.
 *
 * Usage: node scripts/pipeline-honesty-test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ROOT, runApp } from './electron-run.mjs'

const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const OUT = path.join(ROOT, 'out', 'transcribe-e2e.json')
const TMP = path.join(os.tmpdir(), 'meetfroge-honesty')

const CASES = [
  {
    name: 'silence',
    // anullsrc is bit-exact zeros: mean == max == -91 dB, the M-020 signature.
    audio: ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'],
    expectStage: 'extract',
    expectCode: 'PIPELINE_AUDIO_SILENT',
    // transcribe must reach the same verdict, not a vaguer one.
    alsoExpect: { stage: 'transcribe', code: 'PIPELINE_AUDIO_SILENT' },
  },
  {
    name: 'tone',
    // A loud 440 Hz tone: unmistakably audible, containing no speech.
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
    expectStage: 'transcribe',
    expectCode: 'PIPELINE_NO_SPEECH',
  },
]

function makeMedia(kase) {
  const file = path.join(TMP, `${kase.name}.mkv`)
  execFileSync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=5',
      ...kase.audio,
      ...kase.audio,
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-t', '8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '64k',
      file,
    ],
    { stdio: 'inherit' },
  )
  return file
}

function runPipeline(mediaFile) {
  // runApp kills strays and proves the artefact is fresh: a stray instance
  // holding the single-instance lock exits 0 without booting (M-030).
  const r = runApp({ env: { MEETFROGE_PROCESS_FILE: mediaFile }, expectFile: OUT })
  if (!r.ok) throw new Error(r.reason ?? `app run failed (exit ${r.status})`)
  return JSON.parse(readFileSync(OUT, 'utf8'))
}

mkdirSync(TMP, { recursive: true })
let failures = 0

for (const kase of CASES) {
  process.stdout.write(`\n=== case: ${kase.name} ===\n`)
  const media = makeMedia(kase)
  const result = runPipeline(media)
  const jobs = result.jobs ?? []
  const job = jobs.find((j) => j.stage === kase.expectStage)

  const summary = jobs.map((j) => `${j.stage}:${j.state}${j.errorCode ? `(${j.errorCode})` : ''}`).join(' ')
  process.stdout.write(`  jobs      ${summary}\n`)
  process.stdout.write(`  segments  ${result.segmentCount}\n`)

  const checks = [
    ['stage present', Boolean(job)],
    [`${kase.expectStage} skipped`, job?.state === 'skipped'],
    [`reason is ${kase.expectCode}`, job?.errorCode === kase.expectCode],
    ['no transcript invented', result.segmentCount === 0],
    // The whole point: nothing may claim plain success.
    ['no stage reports a bare done+nothing', !jobs.some((j) => j.stage === 'transcribe' && j.state === 'done' && result.segmentCount === 0)],
  ]
  if (kase.alsoExpect) {
    const other = jobs.find((j) => j.stage === kase.alsoExpect.stage)
    checks.push([
      `${kase.alsoExpect.stage} agrees: ${kase.alsoExpect.code}`,
      other?.errorCode === kase.alsoExpect.code,
    ])
  }
  for (const [label, ok] of checks) {
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`)
    if (!ok) failures++
  }
}

rmSync(TMP, { recursive: true, force: true })
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
