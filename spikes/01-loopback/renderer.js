// Renderer side of the loopback capture.
//
// The important detail (MISTAKES.md M-003): getDisplayMedia must be called with
// video: true even though we only want audio. Requesting { video: false, audio: true }
// throws NotSupportedError on Windows. We take the video track and immediately
// discard it.

const statusEl = document.getElementById('status')
const detailEl = document.getElementById('detail')
const meterEl = document.getElementById('meter')

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = cls || ''
}

function detail(text) {
  detailEl.textContent += text + '\n'
}

async function start() {
  let stream
  try {
    setStatus('requesting display media...')
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (e) {
    setStatus('getDisplayMedia FAILED', 'fail')
    detail(`${e.name}: ${e.message}`)
    window.spike.error(`getDisplayMedia failed: ${e.name}: ${e.message}`)
    return
  }

  const videoTracks = stream.getVideoTracks()
  const audioTracks = stream.getAudioTracks()
  detail(`video tracks: ${videoTracks.length}`)
  detail(`audio tracks: ${audioTracks.length}`)

  // We asked for video only because loopback audio rides along with it.
  videoTracks.forEach((t) => {
    t.stop()
    stream.removeTrack(t)
  })
  detail('video track discarded')

  if (audioTracks.length === 0) {
    setStatus('NO AUDIO TRACK', 'fail')
    detail('Loopback audio was not attached to the stream.')
    window.spike.error('no audio track in display media stream')
    return
  }

  const settings = audioTracks[0].getSettings()
  detail(`track settings: ${JSON.stringify(settings)}`)

  const ctx = new AudioContext({ sampleRate: 48000 })
  await ctx.audioWorklet.addModule('pcm-worklet.js')

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-processor')

  // An AnalyserNode gives us a live meter independent of the PCM path, so we can
  // see whether audio is arriving even if the worklet has a problem.
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  const timeData = new Float32Array(analyser.fftSize)

  source.connect(analyser)
  source.connect(worklet)
  // Deliberately NOT connected to ctx.destination - that would feed captured
  // system audio back into system audio.

  worklet.port.onmessage = (ev) => {
    const msg = ev.data
    if (msg.type === 'format') {
      window.spike.format({ sampleRate: msg.sampleRate, channels: msg.channels })
      detail(`worklet format: ${msg.sampleRate} Hz, ${msg.channels}ch`)
    } else if (msg.type === 'pcm') {
      window.spike.pcm(msg.buffer)
    }
  }

  await ctx.resume()
  setStatus('CAPTURING', 'ok')
  window.spike.ready()

  let peakSeen = 0
  setInterval(() => {
    analyser.getFloatTimeDomainData(timeData)
    let peak = 0
    for (let i = 0; i < timeData.length; i++) {
      const a = Math.abs(timeData[i])
      if (a > peak) peak = a
    }
    if (peak > peakSeen) peakSeen = peak
    meterEl.style.width = Math.min(100, peak * 100 * 3).toFixed(1) + '%'
    meterEl.style.background = peakSeen > 0.001 ? '#3fb950' : '#484f58'
  }, 50)
}

start()
