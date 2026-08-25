// Converts Float32 audio blocks into 20 ms interleaved s16le frames.
// 20 ms at 48 kHz stereo = 960 frames = 1920 samples = 3840 bytes.
//
// This is the same shape the production loopback bridge will use, so whatever we
// learn here about timing and framing transfers directly.

const FRAME_MS = 20

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = 2
    this.framesPerChunk = Math.round((sampleRate * FRAME_MS) / 1000)
    this.buffer = new Int16Array(this.framesPerChunk * this.channels)
    this.offset = 0

    this.port.postMessage({ type: 'format', sampleRate, channels: this.channels })
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const left = input[0]
    // Mono sources are duplicated rather than dropped, so the frame layout is stable.
    const right = input.length > 1 ? input[1] : input[0]
    if (!left) return true

    for (let i = 0; i < left.length; i++) {
      this.buffer[this.offset++] = this.clamp(left[i])
      this.buffer[this.offset++] = this.clamp(right[i])

      if (this.offset >= this.buffer.length) {
        const out = this.buffer.slice()
        this.port.postMessage({ type: 'pcm', buffer: out.buffer }, [out.buffer])
        this.offset = 0
      }
    }

    return true
  }

  clamp(v) {
    if (v > 1) v = 1
    else if (v < -1) v = -1
    return v < 0 ? v * 0x8000 : v * 0x7fff
  }
}

registerProcessor('pcm-processor', PcmProcessor)
