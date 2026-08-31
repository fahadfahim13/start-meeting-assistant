// Full live verification sweep — every feature, sequentially, one scoreboard.
// Reuses the individual E2E harnesses (each exits 0/1 with its own content
// assertions). Total runtime ~25-35 min on REF-01.
//
// REQUIREMENTS while running: speakers audible (several tests play audio),
// machine mostly idle. No windows are opened (the visual test is synthetic).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const installed = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'MeetFroge', 'MeetFroge.exe')
const appData = path.join(process.env.APPDATA ?? '', 'MeetFroge')

const results = []
function record(name, pass, detail, seconds) {
  results.push({ name, pass, detail, seconds })
  console.log(`\n[${results.length}] ${pass ? 'PASS' : 'FAIL'}  ${name}  (${seconds}s)  ${detail}`)
}

function runCmd(cmd, args, env, timeoutMs) {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, {
    cwd: root,
    shell: false,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), seconds: Math.round((Date.now() - t0) / 1000) }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

console.log('MeetFroge full verification sweep — keep volume ON, machine idle.\n')

// 1. Dev smoke: boot, probe, device enumeration
{
  rmSync(path.join(root, 'out', 'smoke.json'), { force: true })
  const r = runCmd('node', [path.join(root, 'scripts', 'smoke.mjs')], {}, 120_000)
  const d = readJson(path.join(root, 'out', 'smoke.json'))
  record('boot + hardware probe + device enumeration', r.code === 0 && !!d?.ok,
    d ? `encoders=[${d.capabilities.workingEncoders}] screens=${d.screens.length}` : 'no result', r.seconds)
}

// 2. Installed-app smoke (the shipped binary)
{
  const smokePath = path.join(appData, 'out', 'smoke.json')
  rmSync(smokePath, { force: true })
  const r = runCmd(installed, [], { MEETFROGE_SMOKE: '1' }, 150_000)
  const d = readJson(smokePath)
  record('INSTALLED app: boot + integrity + probe', r.code === 0 && !!d?.ok,
    d ? `encoders=[${d.capabilities.workingEncoders}]` : 'no result', r.seconds)
}

// 3. Recording: 4 streams, hardware encode (dev)
{
  const e2e = path.join(root, 'out', 'e2e.json')
  rmSync(e2e, { force: true })
  const r = runCmd(electron, ['.'], { MEETFROGE_AUTOREC: '20' }, 240_000)
  const d = readJson(e2e)
  record('recording: screen+camera+mic+system audio', r.code === 0 && !!d?.ok,
    d ? `${d.durationS}/${d.requestedS}s ${d.videoTracks}v+${d.audioTracks}a micVsSys=${d.micVsSystemMs}ms` : 'no result', r.seconds)
}

// 4. Recording through the INSTALLED app
{
  const e2e = path.join(appData, 'out', 'e2e.json')
  rmSync(e2e, { force: true })
  const r = runCmd(installed, [], { MEETFROGE_AUTOREC: '20' }, 240_000)
  const d = readJson(e2e)
  record('INSTALLED app: full recording', r.code === 0 && !!d?.ok,
    d ? `${d.durationS}/${d.requestedS}s ${d.videoTracks}v+${d.audioTracks}a` : 'no result', r.seconds)
}

// 5. Pause / resume
{
  const e2e = path.join(root, 'out', 'e2e.json')
  rmSync(e2e, { force: true })
  const r = runCmd(electron, ['.'], { MEETFROGE_AUTOREC: '24', MEETFROGE_AUTOPAUSE: '1' }, 240_000)
  const d = readJson(e2e)
  // ~24s window with pause 40%->60% => expect ~19s media minus transitions
  record('pause / resume (segment-based)', r.code === 0 && !!d && d.videoTracks >= 1 && d.durationS > 10,
    d ? `${d.durationS}s across pause` : 'no result', r.seconds)
}

// 6. Software-encode fallback ladder
{
  const e2e = path.join(root, 'out', 'e2e.json')
  rmSync(e2e, { force: true })
  const r = runCmd(electron, ['.'], { MEETFROGE_AUTOREC: '20', MEETFROGE_FORCE_ENCODER: 'libx264' }, 300_000)
  const d = readJson(e2e)
  record('fallback: forced libx264 (no-GPU machines)', r.code === 0 && !!d?.ok,
    d ? `${d.durationS}/${d.requestedS}s` : 'no result', r.seconds)
}

// 7. Crash recovery: hard-kill mid-recording, relaunch recovers
{
  const t0 = Date.now()
  const before = new Set(readdirSync(path.join(appData, 'recordings')))
  spawn(electron, ['.'], {
    cwd: root, shell: false, stdio: 'ignore',
    env: { ...process.env, MEETFROGE_AUTOREC: '600', MEETFROGE_SEGTIME: '8' },
  })
  let segs = 0
  await new Promise((resolve) => {
    const t = setInterval(() => {
      try {
        for (const dir of readdirSync(path.join(appData, 'recordings'))) {
          if (before.has(dir)) continue
          const p = path.join(appData, 'recordings', dir)
          if (statSync(p).isDirectory()) {
            segs = readdirSync(p).filter((f) => f.startsWith('seg_')).length
            if (segs >= 3) { clearInterval(t); resolve() }
          }
        }
      } catch { /* keep polling */ }
    }, 2000)
    setTimeout(() => { clearInterval(t); resolve() }, 90_000)
  })
  spawnSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { shell: false })
  spawnSync('taskkill', ['/F', '/IM', 'ffmpeg.exe', '/T'], { shell: false })
  await new Promise((r) => setTimeout(r, 2000))
  rmSync(path.join(root, 'out', 'smoke.json'), { force: true })
  runCmd('node', [path.join(root, 'scripts', 'smoke.mjs')], {}, 180_000)
  const d = readJson(path.join(root, 'out', 'smoke.json'))
  const rec = (d?.recovery ?? []).find((x) => x.outcome === 'recovered')
  record('crash recovery: hard kill mid-recording', !!rec,
    rec ? `${rec.segmentsPlayable}/${rec.segmentsFound} segments recovered, ${Math.round(rec.durationS)}s playable` : `no recovery (segs seen=${segs})`,
    Math.round((Date.now() - t0) / 1000))
}

// 8. Mic <-> system audio alignment
{
  const r = runCmd('node', [path.join(root, 'scripts', 'sync-test.mjs')], {}, 240_000)
  const m = /offset\s*:\s*(-?[\d.]+)\s*ms/.exec(r.out)
  record('audio alignment (tone-burst cross-correlation)', r.code === 0,
    m ? `offset ${m[1]}ms (budget ±100)` : r.out.split('\n').filter(Boolean).pop() ?? '', r.seconds)
}

// 9. Transcription with real speech
{
  const r = runCmd('node', [path.join(root, 'scripts', 'transcribe-test.mjs')], {}, 900_000)
  const m = /content check: (\d+)\/(\d+)/.exec(r.out)
  record('transcription (JFK content assertion)', r.code === 0, m ? `phrases ${m[1]}/${m[2]}` : '', r.seconds)
}

// 10. Diarization with two voices
{
  const r = runCmd('node', [path.join(root, 'scripts', 'diarize-test.mjs')], {}, 900_000)
  const m = /distinct system-track speakers: (.+)/.exec(r.out)
  record('speaker diarization (two TTS voices)', r.code === 0, m ? m[1].trim() : '', r.seconds)
}

// 11. Visual pipeline: keyframes + OCR + VLM (synthetic, deterministic)
{
  const r = runCmd('node', [path.join(root, 'scripts', 'visual-unit.mjs')], {}, 1_200_000)
  const kf = /keyframes: (\d+)/.exec(r.out)
  const ocr = /OCR found (\d+)\/(\d+)/.exec(r.out)
  const vlm = /VLM: done — (\d+)\/(\d+) captioned/.exec(r.out)
  record('visual analysis: keyframes + OCR + VLM captions', r.code === 0,
    `keyframes=${kf?.[1] ?? '?'} ocr=${ocr ? ocr[1] + '/' + ocr[2] : '?'} vlm=${vlm ? vlm[1] + '/' + vlm[2] : 'skipped?'}`, r.seconds)
}

// 12. Summarization: full 7-stage pipeline on a conversation
{
  const r = runCmd('node', [path.join(root, 'scripts', 'summary-test.mjs')], {}, 1_500_000)
  const t = /title\s*:\s*(.+)/.exec(r.out)
  const sub = /substance check: (\d+)\/(\d+)/.exec(r.out)
  record('summary: decisions + action items (7-stage)', r.code === 0,
    `${t ? '"' + t[1].trim().slice(0, 40) + '"' : ''} substance=${sub ? sub[1] + '/' + sub[2] : '?'}`, r.seconds)
}

// 13. Models: every registry entry present with exact size
{
  const t0 = Date.now()
  const expected = [
    ['ggml-large-v3-turbo-q5_0.bin', 574041195],
    ['ggml-silero-v5.1.2.bin', 885098],
    ['pyannote-segmentation-3-0.onnx', 5992913],
    ['3dspeaker-eres2net-base.onnx', 39593761],
    ['SmolVLM2-2.2B-Instruct-Q4_K_M.gguf', 1112602656],
    ['mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf', 592523200],
    ['qwen3-4b-instruct-q4_k_m.gguf', 2497280736],
    ['eng.traineddata', 4113088],
  ]
  const bad = expected.filter(([f, size]) => {
    const p = path.join(appData, 'models', f)
    return !existsSync(p) || statSync(p).size !== size
  })
  record('model registry: all 8 models size-exact', bad.length === 0,
    bad.length ? `bad: ${bad.map(([f]) => f).join(', ')}` : '8/8 verified', Math.round((Date.now() - t0) / 1000))
}

// ---- scoreboard ------------------------------------------------------------
const passed = results.filter((r) => r.pass).length
const summary = { date: new Date().toISOString(), passed, total: results.length, results }
writeFileSync(path.join(root, 'out', 'full-verification.json'), JSON.stringify(summary, null, 2))

console.log('\n' + '='.repeat(70))
console.log(`FULL VERIFICATION: ${passed}/${results.length} PASS`)
console.log('='.repeat(70))
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name.padEnd(48)} ${String(r.seconds).padStart(4)}s  ${r.detail}`)
}
process.exit(passed === results.length ? 0 : 1)
