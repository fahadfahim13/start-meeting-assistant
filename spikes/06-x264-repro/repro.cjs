// Reproduces the app's forced-libx264 freeze: full 4-input graph, segmented
// output, PCM over a named pipe, graceful 'q' stop — encoder switchable to
// bisect. Usage: node repro.cjs [libx264|h264_amf] [--nopipe|--nocam]
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const { mkdirSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')

const enc = process.argv[2] || 'libx264'
const noPipe = process.argv.includes('--nopipe')
const noCam = process.argv.includes('--nocam')
const outDir = path.join(os.tmpdir(), 'mf-x264-repro')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const pipeName = '\\\\.\\pipe\\mf-repro-' + Date.now()

function buildArgs() {
  const a = ['-hide_banner', '-loglevel', 'info', '-y', '-init_hw_device', 'd3d11va']
  a.push('-f', 'dshow', '-thread_queue_size', '4096', '-audio_buffer_size', '50', '-i', 'audio=Microphone Array (AMD Audio Device)')
  if (!noPipe) a.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-thread_queue_size', '4096', '-i', pipeName)
  if (!noCam) a.push('-f', 'dshow', '-thread_queue_size', '1024', '-rtbufsize', '64M', '-i', 'video=HP TrueVision HD Camera')
  const filters = []
  if (enc === 'h264_amf') filters.push('ddagrab=0:framerate=15,hwdownload,format=bgra,format=nv12,hwupload[vscreen]')
  else filters.push('ddagrab=0:framerate=15,hwdownload,format=bgra[vscreen]')
  if (!noCam) {
    const camIdx = noPipe ? 1 : 2
    const fmt = enc === 'h264_amf' ? 'nv12' : 'yuv420p'
    filters.push(`[${camIdx}:v]fps=15,scale=-2:480,format=${fmt}[vcam]`)
  }
  a.push('-filter_complex', filters.join(';'))
  a.push('-map', '[vscreen]')
  if (!noCam) a.push('-map', '[vcam]')
  if (enc === 'h264_amf') a.push('-c:v', 'h264_amf', '-b:v', '3000k')
  else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k')
  a.push('-map', '0:a')
  if (!noPipe) a.push('-map', '1:a')
  a.push('-c:a', 'libopus', '-b:a', '64k')
  a.push('-f', 'segment', '-segment_format', 'matroska', '-segment_time', '300', '-reset_timestamps', '1', '-segment_start_number', '0', path.join(outDir, 'seg_%03d.mkv'))
  return a
}

function start() {
  const args = buildArgs()
  console.log('ffmpeg', args.join(' '))
  const ff = spawn('ffmpeg', args, { shell: false, stdio: ['pipe', 'ignore', 'pipe'] })
  let lastProgress = ''
  ff.stderr.on('data', (d) => {
    const s = d.toString()
    const m = /time=(\S+)/.exec(s)
    if (m) lastProgress = m[1]
    for (const line of s.split(/\r?\n/)) {
      if (/error|failed|invalid|Impossible|blocking/i.test(line) && line.trim()) console.log('FF:', line.trim())
    }
  })
  const progTimer = setInterval(() => console.log('progress time=', lastProgress), 3000)
  setTimeout(() => {
    console.log('sending q...')
    try { ff.stdin.write('q\n') } catch {}
  }, 15000)
  ff.on('exit', (code) => {
    clearInterval(progTimer)
    console.log('ffmpeg exit', code)
    try {
      const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(outDir, 'seg_000.mkv')], { encoding: 'utf8' }).trim()
      console.log('segment duration:', dur, '(expected ~15)')
    } catch (e) { console.log('probe failed', String(e).slice(0, 120)) }
    process.exit(0)
  })
}

if (noPipe) {
  start()
} else {
  const server = net.createServer((sock) => {
    const frame = Buffer.alloc(3840) // 20 ms silence
    const t = setInterval(() => sock.write(frame), 20)
    sock.on('close', () => clearInterval(t))
    sock.on('error', () => clearInterval(t))
  })
  server.listen(pipeName, start)
}
