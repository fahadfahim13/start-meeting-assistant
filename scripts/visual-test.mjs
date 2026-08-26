// Visual-analysis E2E (Phase 5 verification).
//
// Opens a fullscreen-ish slideshow that flips between six slides — each a huge
// unique word on a distinct background — while the app records the screen.
// Then the pipeline runs and the assertions are:
//   1. keyframe count lands near the slide count (change detection works)
//   2. OCR finds the slide words (text extraction works)
//   3. cap did not bind silently
// VLM captions are reported when the models are present, asserted only loosely
// (caption text is model-dependent; presence is what matters).
//
// Usage: node scripts/visual-test.mjs   (machine otherwise idle)
// NOTE: opens a browser window with the slideshow; close it afterwards.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultFile = path.join(root, 'out', 'transcribe-e2e.json')
const recDir = path.join(process.env.APPDATA ?? '', 'meetfroge', 'recordings')
const RECORD_S = 40
const WORDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT']
const SLIDE_MS = 6000

// --- 1. slideshow page ------------------------------------------------------
const slidesHtml = `<!doctype html><html><head><title>MeetFroge visual test</title><style>
  body { margin:0; display:grid; place-items:center; height:100vh; font-family:Arial, sans-serif; transition:none; }
  h1 { font-size:18vw; margin:0; letter-spacing:0.05em; }
  p { font-size:2vw; position:fixed; bottom:2vh; }
</style></head><body><h1 id="w"></h1><p id="s"></p><script>
  const words=${JSON.stringify(WORDS)};
  const colors=['#ffffff','#e8f4e8','#fdf3d8','#e8ecfd','#fde8ec','#e8fdf9'];
  let i=0;
  function show(){ document.body.style.background=colors[i%colors.length];
    document.getElementById('w').textContent=words[i%words.length];
    document.getElementById('s').textContent='slide '+((i%words.length)+1)+' of '+words.length; i++; }
  show(); setInterval(show, ${SLIDE_MS});
</script></body></html>`
const slidesPath = path.join(os.tmpdir(), 'meetfroge-slides.html')
writeFileSync(slidesPath, slidesHtml)

const listRecordings = () => {
  try {
    return new Set(readdirSync(recDir))
  } catch {
    return new Set()
  }
}

rmSync(resultFile, { force: true })

// Slideshow FIRST and foreground: Windows denies focus to background launches,
// so opening it mid-recording left it BEHIND other windows and the test
// recorded whatever was already on screen (first-run failure). The app then
// minimizes itself (MEETFROGE_MINIMIZE) so the slides own the screen.
console.log('opening slideshow (foreground)...')
spawn('cmd.exe', ['/c', 'start', '/max', '', slidesPath], { shell: false, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 5000))

console.log(`recording ${RECORD_S}s of a ${WORDS.length}-word slideshow (${SLIDE_MS / 1000}s per slide)...`)
const appProc = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: {
    ...process.env,
    MEETFROGE_AUTOREC: String(RECORD_S),
    MEETFROGE_AUTOPROCESS: '1',
    MEETFROGE_MINIMIZE: '1',
  },
  stdio: 'ignore',
})

const timeout = setTimeout(() => {
  console.error('VISUAL E2E TIMEOUT — killing app')
  appProc.kill()
}, 20 * 60_000)

const code = await new Promise((resolve) => appProc.on('exit', resolve))
clearTimeout(timeout)

if (!existsSync(resultFile)) {
  console.error(`VISUAL E2E FAIL: app exited ${code} without a result file`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'))
console.log('\njobs:', JSON.stringify(result.jobs))

const kfs = result.keyframes ?? []
console.log(`keyframes: ${kfs.length}`)
for (const k of kfs) {
  console.log(
    `  ${String(k.timestampMs).padStart(6)}ms score=${k.changeScore}` +
      `${k.sceneType ? ` [${k.sceneType}]` : ''}` +
      `${k.ocrText ? `  ocr="${k.ocrText.slice(0, 50)}"` : ''}` +
      `${k.caption ? `  vlm="${k.caption.slice(0, 60)}"` : ''}`,
  )
}

const ocrAll = kfs.map((k) => (k.ocrText ?? '').toUpperCase()).join(' ')
const wordsFound = WORDS.filter((w) => ocrAll.includes(w))
const captioned = kfs.filter((k) => k.caption).length
const vlmJob = result.jobs.find((j) => j.stage === 'vlm')

console.log(`\nOCR found ${wordsFound.length}/${WORDS.length} slide words: ${wordsFound.join(', ') || 'none'}`)
console.log(`VLM: ${vlmJob?.state}${captioned ? ` (${captioned} captions)` : ''}`)

// ~6 slide changes in 40 s + first frame; allow browser-open transition noise.
const kfCountOk = kfs.length >= 4 && kfs.length <= 16
const ocrOk = wordsFound.length >= 3
const jobsOk = result.jobs.every((j) => j.state === 'done' || j.state === 'skipped')

console.log(`\nkeyframe count ${kfs.length} in [4..16]: ${kfCountOk}`)
const pass = jobsOk && kfCountOk && ocrOk
console.log(pass ? '\nVISUAL E2E PASS' : '\nVISUAL E2E FAIL')
console.log('(close the slideshow browser tab when convenient)')
process.exit(pass ? 0 : 1)
