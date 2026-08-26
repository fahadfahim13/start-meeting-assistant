// Deterministic visual-pipeline verification (Phase 5).
//
// Generates a synthetic slide video with ffmpeg (six slides, six seconds each,
// a huge unique word per slide) and runs it through the REAL pipeline stages
// (keyframes → ocr → vlm) via the MEETFROGE_PROCESS_FILE harness. No live
// desktop involved (M-014: a screen test on a machine the user is actively
// using is unwinnable — and content verification never needed the desktop).
//
// The live-desktop variant (scripts/visual-test.mjs) remains for manual runs.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultFile = path.join(root, 'out', 'transcribe-e2e.json')
const WORDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT']
const SLIDE_S = 6
const COLORS = ['white', '0xe8f4e8', '0xfdf3d8', '0xe8ecfd', '0xfde8ec', '0xe8fdf9']

// --- 1. generate the slide video -------------------------------------------
const tmp = path.join(os.tmpdir(), 'meetfroge-visual')
rmSync(tmp, { recursive: true, force: true })
spawnSync('cmd.exe', ['/c', 'mkdir', tmp.replace(/\//g, '\\')], { shell: false })

const FONT = "fontfile='C\\:/Windows/Fonts/arialbd.ttf'"
const parts = []
for (let i = 0; i < WORDS.length; i++) {
  const part = path.join(tmp, `slide${i}.mkv`)
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=${COLORS[i]}:s=1920x1080:d=${SLIDE_S}:r=15`,
    '-vf',
    `drawtext=text='${WORDS[i]}':${FONT}:fontsize=300:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `drawtext=text='slide ${i + 1} of ${WORDS.length}':${FONT}:fontsize=48:fontcolor=0x555555:x=(w-text_w)/2:y=h-120`,
    '-c:v', 'libx264', '-preset', 'ultrafast', part,
  ], { shell: false, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`slide ${i} generation failed:`, r.stderr?.slice(0, 300))
    process.exit(2)
  }
  parts.push(part)
}
const listFile = path.join(tmp, 'list.txt')
writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))
const video = path.join(tmp, 'slides.mkv')
const concat = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', video], { shell: false, encoding: 'utf8' })
if (concat.status !== 0) {
  console.error('concat failed:', concat.stderr?.slice(0, 300))
  process.exit(2)
}
console.log(`generated ${WORDS.length * SLIDE_S}s slide video (${WORDS.length} slides)`)

// --- 2. run the real pipeline on it ----------------------------------------
rmSync(resultFile, { force: true })
console.log('processing through the app pipeline (keyframes → ocr → vlm)...')
const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_PROCESS_FILE: video },
  stdio: 'ignore',
})
const timeout = setTimeout(() => {
  console.error('TIMEOUT — killing app')
  appProc.kill()
}, 20 * 60_000)
const code = await new Promise((resolve) => appProc.on('exit', resolve))
clearTimeout(timeout)

if (!existsSync(resultFile)) {
  console.error(`VISUAL PIPELINE FAIL: app exited ${code} without a result file`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'))
console.log('\njobs:', JSON.stringify(result.jobs))

const kfs = result.keyframes ?? []
console.log(`keyframes: ${kfs.length}`)
for (const k of kfs) {
  console.log(
    `  ${String(k.timestampMs).padStart(6)}ms score=${String(k.changeScore).padStart(2)}` +
      `${k.sceneType ? ` [${k.sceneType}]` : ''}` +
      `${k.ocrText ? `  ocr="${k.ocrText.slice(0, 40)}"` : ''}` +
      `${k.caption ? `  vlm="${k.caption.slice(0, 70)}"` : ''}`,
  )
}

const ocrAll = kfs.map((k) => (k.ocrText ?? '').toUpperCase()).join(' ')
const wordsFound = WORDS.filter((w) => ocrAll.includes(w))
const captioned = kfs.filter((k) => k.caption).length
const vlmJob = result.jobs.find((j) => j.stage === 'vlm')

console.log(`\nOCR found ${wordsFound.length}/${WORDS.length} slide words: ${wordsFound.join(', ') || 'none'}`)
console.log(`VLM: ${vlmJob?.state}${captioned ? ` — ${captioned}/${kfs.length} captioned` : ''}`)

// Exactly 6 content changes expected (first frame + 5 transitions); allow ±1.
const kfCountOk = kfs.length >= 5 && kfs.length <= 8
const ocrOk = wordsFound.length >= 5
const jobsOk = result.jobs.every((j) => j.state === 'done' || j.state === 'skipped')
const vlmOk = vlmJob?.state === 'skipped' || captioned >= Math.floor(kfs.length / 2)

console.log(`\nkeyframes ${kfs.length} in [5..8]: ${kfCountOk} · OCR ≥5 words: ${ocrOk} · vlm ok: ${vlmOk}`)
const pass = jobsOk && kfCountOk && ocrOk && vlmOk
console.log(pass ? '\nVISUAL PIPELINE PASS' : '\nVISUAL PIPELINE FAIL')
process.exit(pass ? 0 : 1)
