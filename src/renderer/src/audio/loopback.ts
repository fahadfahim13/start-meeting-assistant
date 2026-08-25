import { api } from '../api'

/**
 * System-audio capture in the renderer — the load-bearing oddity of the whole
 * architecture (ADR-002): Chromium's WASAPI loopback is the only driver-free
 * way to get desktop audio on Windows, and it lives here, not in main.
 *
 * Pattern validated by spike 1 (B-005): request {video:true, audio:true} —
 * audio-only throws (M-003) — then immediately discard the video track.
 */

export interface LoopbackHandle {
  /** Live RMS level 0..1 for the meter, updated ~20/s. */
  getLevel(): number
  stop(): void
}

export async function startLoopback(): Promise<LoopbackHandle> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })

  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Loopback audio track was not attached — system audio unavailable')
  }

  const ctx = new AudioContext({ sampleRate: 48_000 })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-processor')
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  const timeData = new Float32Array(analyser.fftSize)

  source.connect(worklet)
  source.connect(analyser)
  // Never connect to ctx.destination — that would feed captured system audio
  // back into system audio.

  worklet.port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { type: string; buffer?: ArrayBuffer }
    if (msg.type === 'pcm' && msg.buffer) api.sendPcmFrame(msg.buffer)
  }

  await ctx.resume()

  let level = 0
  const meterTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(timeData)
    let sum = 0
    for (let i = 0; i < timeData.length; i++) sum += timeData[i]! * timeData[i]!
    level = Math.sqrt(sum / timeData.length)
  }, 50)

  return {
    getLevel: () => level,
    stop: () => {
      clearInterval(meterTimer)
      worklet.port.onmessage = null
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}
