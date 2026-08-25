import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

/**
 * Carries loopback PCM from the renderer to ffmpeg over a Windows named pipe.
 *
 * Validated by spike 2 (benchmarks B-006): 5 minutes sustained, completeness
 * 1.0000, zero drops, 3 ms non-accumulating drift. The transport moved from
 * stdin to a named pipe so stdin can carry ffmpeg's 'q' stop command; the
 * framing, ring buffer and backpressure design are unchanged.
 *
 * Hardening (SECURITY.md §5.6):
 * - fixed-capacity ring; overflow drops OLDEST and counts it — never grows
 * - frames are length-validated; only accepted while armed
 * - pipe name is random per session; named-pipe default DACL = current user
 * - exactly one client (ffmpeg) is accepted; later connections are destroyed
 */

// 4 s of 48 kHz stereo s16le — the capacity spike 2 exercised.
const RING_CAPACITY_BYTES = 48_000 * 2 * 2 * 4
// 20 ms frames = 3840 bytes; tolerate worklet block-size variance up to 1 s.
const MAX_FRAME_BYTES = 48_000 * 2 * 2

export interface BridgeStats {
  frames: number
  bytes: number
  drops: number
  backpressure: number
  connected: boolean
}

export class LoopbackBridge {
  readonly pipePath: string
  private server: Server | null = null
  private client: Socket | null = null
  private ring: Buffer[] = []
  private ringBytes = 0
  private writable = true
  private armed = false
  private stats: BridgeStats = { frames: 0, bytes: 0, drops: 0, backpressure: 0, connected: false }

  constructor() {
    this.pipePath = `\\\\.\\pipe\\meetfroge-pcm-${randomBytes(8).toString('hex')}`
  }

  /** Start listening. Resolves once the pipe exists (before ffmpeg connects). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        if (this.client) {
          // One client only — anything after ffmpeg is uninvited.
          socket.destroy()
          return
        }
        this.client = socket
        this.stats.connected = true
        // Discard pre-roll: frames buffered before ffmpeg connected predate
        // the other inputs' t=0 and would shift the system track earlier
        // relative to the mic. Start the stream from "now".
        this.ring = []
        this.ringBytes = 0
        socket.on('drain', () => {
          this.writable = true
          this.flush()
        })
        socket.on('error', () => {
          /* EPIPE on teardown is expected */
        })
        socket.on('close', () => {
          this.stats.connected = false
          this.client = null
        })
        this.flush()
      })
      this.server.once('error', reject)
      this.server.listen(this.pipePath, () => {
        this.armed = true
        resolve()
      })
    })
  }

  /** Push one PCM frame from the renderer. Only accepted while armed. */
  push(frame: Buffer): void {
    if (!this.armed) return
    if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME_BYTES) return

    this.stats.frames++
    this.stats.bytes += frame.byteLength

    this.ring.push(frame)
    this.ringBytes += frame.byteLength
    while (this.ringBytes > RING_CAPACITY_BYTES && this.ring.length > 1) {
      const dropped = this.ring.shift()!
      this.ringBytes -= dropped.byteLength
      this.stats.drops++
    }
    this.flush()
  }

  private flush(): void {
    while (this.ring.length > 0 && this.writable && this.client && !this.client.destroyed) {
      const buf = this.ring.shift()!
      this.ringBytes -= buf.byteLength
      this.writable = this.client.write(buf)
      if (!this.writable) this.stats.backpressure++
    }
  }

  getStats(): BridgeStats {
    return { ...this.stats }
  }

  /** EOF the PCM stream (ffmpeg's pipe input ends) and stop accepting frames. */
  end(): void {
    this.armed = false
    this.client?.end()
    this.server?.close()
  }

  destroy(): void {
    this.armed = false
    this.client?.destroy()
    this.server?.close()
    this.ring = []
    this.ringBytes = 0
  }
}
