// Spike 1 - Electron system-audio loopback capture.
//
// THE QUESTION: can Electron 44 capture non-silent desktop audio on Windows
// without installing a virtual audio driver?
//
// This is the hard gate for the whole project. ffmpeg cannot do it (MISTAKES.md M-002),
// so if Chromium cannot either, ADR-002 is invalid and the capture architecture changes.
//
// Method: start loopback capture, play a known test tone through the default output
// device, and measure whether the captured PCM is actually non-silent.

const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const CI = process.argv.includes('--ci')
const ASSERT_NON_SILENT = process.argv.includes('--assert-non-silent')

const OUT_DIR = path.join(__dirname, 'out')
const TONE_WAV = path.join(OUT_DIR, 'tone.wav')
const PCM_OUT = path.join(OUT_DIR, 'captured.pcm')
const RESULT_JSON = path.join(OUT_DIR, 'result.json')

const CAPTURE_MS = 8000 // total capture window
const TONE_DELAY_MS = 1500 // let capture settle before making noise
const TONE_SECONDS = 5

// Anything above this RMS is unambiguously not digital silence.
// Digital silence is exactly 0; noise floor on a loopback tap is ~1e-5.
const SILENCE_FLOOR_RMS = 0.001

const stats = {
  frames: 0,
  bytes: 0,
  samples: 0,
  peak: 0,
  sumSquares: 0,
  firstFrameAt: null,
  lastFrameAt: null,
  maxWindowRms: 0,
  sampleRate: null,
  channels: null,
}

let pcmStream = null

function log(...args) {
  console.log('[spike1]', ...args)
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

// Generate a test tone. Two tones at different frequencies so we can tell a real
// capture from, say, a buffer of uninitialised memory that happens to be non-zero.
function generateTone() {
  log('generating test tone via ffmpeg...')
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TONE_SECONDS}:sample_rate=48000`,
      '-f', 'lavfi', '-i', `sine=frequency=660:duration=${TONE_SECONDS}:sample_rate=48000`,
      '-filter_complex', '[0:a][1:a]amerge=inputs=2,volume=0.5[a]',
      '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
      TONE_WAV,
    ],
    { shell: false, encoding: 'utf8' }
  )
  if (r.status !== 0) {
    throw new Error(`ffmpeg tone generation failed (${r.status}): ${r.stderr}`)
  }
  const size = fs.statSync(TONE_WAV).size
  log(`tone written: ${TONE_WAV} (${size} bytes)`)
}

// Play the tone through the default render endpoint. SoundPlayer.PlaySync blocks,
// so this runs in its own process and we do not wait for it.
function playTone() {
  log('playing test tone through default output device...')
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = New-Object System.Media.SoundPlayer '${TONE_WAV}'; $p.PlaySync()`,
    ],
    { shell: false, stdio: 'ignore', detached: false }
  )
  ps.on('error', (e) => log('tone playback error:', e.message))
  return ps
}

function analyseFrame(buf) {
  // s16le interleaved stereo
  const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < view.length; i++) {
    const v = view[i] / 32768
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    sumSq += v * v
  }
  const rms = Math.sqrt(sumSq / view.length)

  stats.frames++
  stats.bytes += buf.byteLength
  stats.samples += view.length
  stats.sumSquares += sumSq
  if (peak > stats.peak) stats.peak = peak
  if (rms > stats.maxWindowRms) stats.maxWindowRms = rms

  const now = Date.now()
  if (stats.firstFrameAt === null) stats.firstFrameAt = now
  stats.lastFrameAt = now
}

function finish(code, extra = {}) {
  if (pcmStream) pcmStream.end()

  const overallRms = stats.samples > 0 ? Math.sqrt(stats.sumSquares / stats.samples) : 0
  const durationMs =
    stats.firstFrameAt && stats.lastFrameAt ? stats.lastFrameAt - stats.firstFrameAt : 0
  const expectedSamples =
    stats.sampleRate && stats.channels ? (durationMs / 1000) * stats.sampleRate * stats.channels : 0

  const result = {
    spike: '01-loopback',
    date: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    capture: {
      sampleRate: stats.sampleRate,
      channels: stats.channels,
      frames: stats.frames,
      bytes: stats.bytes,
      samples: stats.samples,
      durationMs,
      sampleCompleteness:
        expectedSamples > 0 ? +(stats.samples / expectedSamples).toFixed(4) : null,
    },
    audio: {
      peak: +stats.peak.toFixed(6),
      overallRms: +overallRms.toFixed(6),
      maxWindowRms: +stats.maxWindowRms.toFixed(6),
      silenceFloorRms: SILENCE_FLOOR_RMS,
    },
    verdict: {
      receivedFrames: stats.frames > 0,
      nonSilent: stats.maxWindowRms > SILENCE_FLOOR_RMS,
    },
    ...extra,
  }

  const passed = result.verdict.receivedFrames && result.verdict.nonSilent

  ensureOutDir()
  fs.writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2))

  console.log('\n' + '='.repeat(64))
  console.log('SPIKE 1 RESULT - Electron system-audio loopback')
  console.log('='.repeat(64))
  console.log(JSON.stringify(result, null, 2))
  console.log('='.repeat(64))
  console.log(passed ? 'PASS - non-silent system audio captured' : 'FAIL - see result above')
  console.log('='.repeat(64) + '\n')

  const exitCode = ASSERT_NON_SILENT ? (passed ? 0 : 1) : code
  app.exit(exitCode)
}

app.whenReady().then(async () => {
  ensureOutDir()

  try {
    generateTone()
  } catch (e) {
    return finish(1, { error: `tone generation failed: ${e.message}` })
  }

  // THE CRITICAL BIT. Chromium attaches loopback audio to a display-capture request;
  // it is not independently requestable (MISTAKES.md M-003).
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) {
            log('no screen sources available')
            return callback({})
          }
          log(`granting display media: ${sources[0].name} + loopback audio`)
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((e) => {
          log('getSources failed:', e.message)
          callback({})
        })
    },
    { useSystemPicker: false }
  )

  const win = new BrowserWindow({
    width: 520,
    height: 340,
    show: !CI,
    title: 'Spike 1 - loopback audio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  pcmStream = fs.createWriteStream(PCM_OUT)

  ipcMain.on('spike:format', (_e, fmt) => {
    stats.sampleRate = fmt.sampleRate
    stats.channels = fmt.channels
    log(`capture format: ${fmt.sampleRate} Hz, ${fmt.channels}ch`)
  })

  ipcMain.on('spike:pcm', (_e, arrayBuffer) => {
    const buf = Buffer.from(arrayBuffer)
    analyseFrame(buf)
    pcmStream.write(buf)
  })

  ipcMain.on('spike:error', (_e, message) => {
    log('renderer error:', message)
    finish(1, { error: message })
  })

  ipcMain.on('spike:ready', () => {
    log('capture started, waiting for it to settle...')
    setTimeout(playTone, TONE_DELAY_MS)
  })

  await win.loadFile(path.join(__dirname, 'index.html'))

  setTimeout(() => finish(0), CAPTURE_MS)
})

app.on('window-all-closed', () => {
  // Deliberately do nothing - the timer decides when we are done.
})
