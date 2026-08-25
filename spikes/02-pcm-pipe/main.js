// Spike 2 - loopback PCM into ffmpeg stdin, alongside screen and mic capture.
//
// THE QUESTION: can the renderer's loopback PCM feed ffmpeg stdin for a sustained
// recording without drift or underruns, while ffmpeg simultaneously captures the
// screen (ddagrab + AMF) and the microphone (dshow)?
//
// This is the production capture shape from docs/architecture.md, built end to end:
//   screen  -> ddagrab -> nv12 -> h264_amf   -> v:0
//   mic     -> dshow                          -> a:0
//   loopback-> renderer -> stdin              -> a:1
//
// The nv12 conversion in the filter chain is mandatory (MISTAKES.md M-001).
//
// Reminder (MISTAKES.md M-004): Electron prints nothing to the parent shell on
// Windows. Read out/result.json and the exit code.

const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const argv = process.argv
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const DURATION_S = parseInt(argOf('--duration', '60'), 10)
const MIC_NAME = argOf('--mic', 'Microphone Array (AMD Audio Device)')
const FPS = 15

const OUT_DIR = path.join(__dirname, 'out')
const OUT_MKV = path.join(OUT_DIR, 'recording.mkv')
const RESULT_JSON = path.join(OUT_DIR, 'result.json')
const FFMPEG_LOG = path.join(OUT_DIR, 'ffmpeg.log')

// Ring buffer sized to 4 seconds of 48 kHz stereo s16le, matching the production design.
const RING_CAPACITY_BYTES = 48000 * 2 * 2 * 4

const state = {
  pcmFrames: 0,
  pcmBytes: 0,
  ringBytes: 0,
  drops: 0, // frames discarded because the ring was full
  backpressureEvents: 0, // ffmpeg stdin asked us to wait
  firstPcmAt: null,
  lastPcmAt: null,
  ffmpegStartedAt: null,
  ffmpegExitedAt: null,
  ffmpegExitCode: null,
  ffmpegStderr: [],
  encoderUsed: null,
}

const ring = []
let ff = null
let stdinReady = true

const log = (...a) => console.log('[spike2]', ...a)

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

function ffmpegArgs() {
  return [
    '-hide_banner',
    '-loglevel', 'info',
    '-y',
    '-init_hw_device', 'd3d11va',

    // a:0 - microphone via DirectShow
    '-f', 'dshow',
    '-thread_queue_size', '4096',
    '-audio_buffer_size', '50',
    '-i', `audio=${MIC_NAME}`,

    // a:1 - system audio, piped in from the renderer's loopback capture
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-thread_queue_size', '4096',
    '-i', 'pipe:0',

    // v:0 - screen via Desktop Duplication. The bgra->nv12 conversion is REQUIRED
    // before h264_amf; without it AMF fails with SubmitInput error 18 (M-001).
    '-filter_complex',
    `ddagrab=0:framerate=${FPS},hwdownload,format=bgra,format=nv12,hwupload[v]`,

    '-map', '[v]',
    '-c:v', 'h264_amf',
    '-b:v', '3M',

    '-map', '0:a',
    '-map', '1:a',
    '-c:a', 'libopus',
    '-b:a', '64k',

    // Explicit track titles so ffprobe output is self-describing.
    '-metadata:s:a:0', 'title=Microphone',
    '-metadata:s:a:1', 'title=System Audio',
    '-metadata:s:v:0', 'title=Screen',

    '-t', String(DURATION_S),
    OUT_MKV,
  ]
}

function startFfmpeg() {
  const args = ffmpegArgs()
  fs.writeFileSync(FFMPEG_LOG, `ffmpeg ${args.join(' ')}\n\n`)
  log('starting ffmpeg...')

  // shell: false, argv array. Production invariant - never build a command string.
  ff = spawn('ffmpeg', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  state.ffmpegStartedAt = Date.now()

  ff.stderr.on('data', (d) => {
    const s = d.toString()
    fs.appendFileSync(FFMPEG_LOG, s)
    // Keep only interesting lines in the result to avoid a wall of progress output.
    for (const line of s.split(/\r?\n/)) {
      if (/error|failed|invalid|cannot|unable/i.test(line) && line.trim()) {
        state.ffmpegStderr.push(line.trim())
      }
      if (/Stream #0:0.*Video/.test(line) && !state.encoderUsed) {
        const m = line.match(/Video:\s*([a-z0-9_]+)/i)
        if (m) state.encoderUsed = m[1]
      }
    }
  })

  ff.stdin.on('drain', () => {
    stdinReady = true
    flushRing()
  })

  ff.stdin.on('error', (e) => {
    if (e.code !== 'EPIPE') log('stdin error:', e.message)
  })

  ff.on('exit', (code) => {
    state.ffmpegExitedAt = Date.now()
    state.ffmpegExitCode = code
    log('ffmpeg exited', code)
    setTimeout(() => finish(), 500)
  })
}

function flushRing() {
  while (ring.length > 0 && stdinReady && ff && ff.stdin.writable) {
    const buf = ring.shift()
    state.ringBytes -= buf.byteLength
    stdinReady = ff.stdin.write(buf)
    if (!stdinReady) state.backpressureEvents++
  }
}

function onPcm(buf) {
  const now = Date.now()
  if (state.firstPcmAt === null) state.firstPcmAt = now
  state.lastPcmAt = now
  state.pcmFrames++
  state.pcmBytes += buf.byteLength

  // Bounded ring. Overflow drops the OLDEST frame and counts it, rather than
  // growing without limit - a renderer that outruns ffmpeg must not exhaust memory.
  ring.push(buf)
  state.ringBytes += buf.byteLength
  while (state.ringBytes > RING_CAPACITY_BYTES && ring.length > 1) {
    const dropped = ring.shift()
    state.ringBytes -= dropped.byteLength
    state.drops++
  }

  flushRing()
}

function probe(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { shell: false, encoding: 'utf8' }
  )
  if (r.status !== 0) return { error: r.stderr }
  try {
    return JSON.parse(r.stdout)
  } catch (e) {
    return { error: e.message }
  }
}

// Matroska stores duration at the container level, not per stream, so
// ffprobe -show_streams reports duration: null for every track (MISTAKES.md M-005).
// The only reliable per-track duration is the presentation timestamp of the last
// packet, which is what drift has to be measured from.
function lastPacketPts(file, streamSpec) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', streamSpec,
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      file,
    ],
    { shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (r.status !== 0) return null
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (!lines.length) return null
  const v = parseFloat(lines[lines.length - 1].replace(/,\s*$/, ''))
  return Number.isFinite(v) ? +v.toFixed(3) : null
}

function packetCount(file, streamSpec) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', streamSpec,
      '-count_packets',
      '-show_entries', 'stream=nb_read_packets',
      '-of', 'csv=p=0',
      file,
    ],
    { shell: false, encoding: 'utf8' }
  )
  if (r.status !== 0) return null
  const n = parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : null
}

function finish() {
  if (ff && ff.stdin.writable) {
    try { ff.stdin.end() } catch {}
  }

  const exists = fs.existsSync(OUT_MKV)
  const probed = exists ? probe(OUT_MKV) : { error: 'no output file' }

  const streams = (probed.streams || []).map((s) => ({
    index: s.index,
    type: s.codec_type,
    codec: s.codec_name,
    title: s.tags && s.tags.title,
    durationS: s.duration ? +parseFloat(s.duration).toFixed(3) : null,
    frames: s.nb_frames ? +s.nb_frames : null,
    sampleRate: s.sample_rate ? +s.sample_rate : undefined,
    channels: s.channels,
    width: s.width,
    height: s.height,
  }))

  const video = streams.find((s) => s.type === 'video')
  const audio = streams.filter((s) => s.type === 'audio')

  // Per-track timing measured from last-packet PTS, since MKV exposes no per-stream
  // duration (M-005).
  const timing = exists
    ? {
        video: { lastPts: lastPacketPts(OUT_MKV, 'v:0'), packets: packetCount(OUT_MKV, 'v:0') },
        mic: { lastPts: lastPacketPts(OUT_MKV, 'a:0'), packets: packetCount(OUT_MKV, 'a:0') },
        system: { lastPts: lastPacketPts(OUT_MKV, 'a:1'), packets: packetCount(OUT_MKV, 'a:1') },
      }
    : null

  // The number that actually matters. The mic and system tracks are merged into a
  // single transcript timeline, so any divergence between them corrupts speaker
  // attribution. Video-vs-audio matters far less and is bounded by frame interval.
  const micVsSystemMs =
    timing && timing.mic.lastPts != null && timing.system.lastPts != null
      ? Math.round(Math.abs(timing.mic.lastPts - timing.system.lastPts) * 1000)
      : null

  // The last video frame legitimately lands up to one frame interval before the
  // last audio packet, so compare against that bound rather than against zero.
  const frameIntervalMs = 1000 / FPS
  const audioEnd =
    timing && timing.mic.lastPts != null && timing.system.lastPts != null
      ? Math.max(timing.mic.lastPts, timing.system.lastPts)
      : null
  const videoVsAudioMs =
    timing && timing.video.lastPts != null && audioEnd != null
      ? Math.round((audioEnd - timing.video.lastPts) * 1000)
      : null

  const measuredFps =
    timing && timing.video.packets && timing.video.lastPts
      ? +((timing.video.packets - 1) / timing.video.lastPts).toFixed(3)
      : null

  const driftMs = micVsSystemMs

  const pcmDurationMs =
    state.firstPcmAt && state.lastPcmAt ? state.lastPcmAt - state.firstPcmAt : 0
  const pcmExpectedBytes = (pcmDurationMs / 1000) * 48000 * 2 * 2

  const result = {
    spike: '02-pcm-pipe',
    date: new Date().toISOString(),
    electron: process.versions.electron,
    config: { durationS: DURATION_S, fps: FPS, mic: MIC_NAME },
    pcmBridge: {
      frames: state.pcmFrames,
      bytes: state.pcmBytes,
      durationMs: pcmDurationMs,
      completeness:
        pcmExpectedBytes > 0 ? +(state.pcmBytes / pcmExpectedBytes).toFixed(4) : null,
      ringDrops: state.drops,
      backpressureEvents: state.backpressureEvents,
      ringHighWaterBytes: RING_CAPACITY_BYTES,
    },
    ffmpeg: {
      exitCode: state.ffmpegExitCode,
      encoderUsed: state.encoderUsed,
      wallClockMs:
        state.ffmpegStartedAt && state.ffmpegExitedAt
          ? state.ffmpegExitedAt - state.ffmpegStartedAt
          : null,
      errors: state.ffmpegStderr.slice(0, 20),
    },
    output: {
      exists,
      bytes: exists ? fs.statSync(OUT_MKV).size : 0,
      formatDurationS: probed.format ? +parseFloat(probed.format.duration).toFixed(3) : null,
      streams,
    },
    timing,
    drift: {
      micVsSystemAudioMs: micVsSystemMs,
      videoVsAudioMs: videoVsAudioMs,
      frameIntervalMs: +frameIntervalMs.toFixed(1),
      measuredFps,
      targetFps: FPS,
    },
    verdict: {
      recordingProduced: exists && state.ffmpegExitCode === 0,
      hasScreenTrack: !!video,
      hasTwoAudioTracks: audio.length === 2,
      hardwareEncoded: state.encoderUsed === 'h264',
      noRingDrops: state.drops === 0,
      audioTracksAlignedUnder100ms: driftMs != null && driftMs < 100,
      videoWithinOneFrameOfAudio:
        videoVsAudioMs != null && Math.abs(videoVsAudioMs) < frameIntervalMs + 50,
      fpsWithin5Percent:
        measuredFps != null && Math.abs(measuredFps - FPS) / FPS < 0.05,
    },
  }

  const passed = Object.values(result.verdict).every(Boolean)

  ensureOutDir()
  fs.writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2))

  console.log('\n' + '='.repeat(64))
  console.log('SPIKE 2 RESULT - PCM pipe + screen + mic')
  console.log('='.repeat(64))
  console.log(JSON.stringify(result, null, 2))
  console.log(passed ? '\nPASS' : '\nFAIL - see verdict above')

  app.exit(passed ? 0 : 1)
}

app.whenReady().then(async () => {
  ensureOutDir()

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) return callback({})
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  const win = new BrowserWindow({
    width: 520,
    height: 300,
    title: 'Spike 2 - PCM pipe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  ipcMain.on('spike:pcm', (_e, ab) => onPcm(Buffer.from(ab)))
  ipcMain.on('spike:error', (_e, msg) => {
    log('renderer error:', msg)
    state.ffmpegStderr.push(`renderer: ${msg}`)
    finish()
  })

  // Start ffmpeg only once PCM is actually flowing, so its pipe input does not
  // starve at the very beginning of the recording.
  ipcMain.once('spike:ready', () => {
    log('loopback flowing, starting ffmpeg')
    startFfmpeg()
  })

  await win.loadFile(path.join(__dirname, 'index.html'))

  // Hard safety timeout: duration + generous headroom for ffmpeg startup and finalize.
  setTimeout(() => {
    if (state.ffmpegExitCode === null) {
      log('safety timeout reached')
      if (ff) ff.kill('SIGKILL')
      setTimeout(finish, 1000)
    }
  }, (DURATION_S + 30) * 1000)
})

app.on('window-all-closed', () => {})
