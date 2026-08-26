import { app } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { modelAvailable, resolveModel } from '@main/platform/models'

/**
 * Speaker diarization on the SYSTEM track only (ADR-007): the mic track is
 * "You" by physics; diarization's only job is separating remote speakers
 * from each other. 1:1 meetings never even need this stage.
 *
 * sherpa-onnx offline pipeline: pyannote segmentation → eres2net embeddings →
 * clustering with auto speaker count.
 */

export interface DiarTurn {
  startMs: number
  endMs: number
  speaker: number
}

interface SherpaModule {
  OfflineSpeakerDiarization: new (config: object) => {
    sampleRate: number
    process(samples: Float32Array): { start: number; end: number; speaker: number }[]
  }
}

/**
 * Minimal RIFF/WAV reader for the pipeline's own 16 kHz mono s16le output.
 *
 * NOT sherpa's readWave: that uses napi_create_external_buffer, which
 * Electron's V8 memory cage forbids — "External buffers are not allowed"
 * (MISTAKES.md M-012). process() consuming a plain Float32Array is fine;
 * only the wave READER was affected. Walks chunks properly rather than
 * assuming a 44-byte header.
 */
export function readWav16kMonoS16(wavPath: string): Float32Array {
  const buf = readFileSync(wavPath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let off = 12
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      dataOff = off + 8
      dataLen = Math.min(len, buf.length - dataOff)
      break
    }
    off += 8 + len + (len % 2) // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error('WAV data chunk not found')
  const n = Math.floor(dataLen / 2)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2) / 32768
  return samples
}

let sherpa: SherpaModule | null = null

function loadSherpa(): SherpaModule {
  if (sherpa) return sherpa
  // The native DLLs live in the platform package and must be on PATH before
  // the addon loads (sherpa-onnx nodejs-addon requirement on Windows).
  const dllDir = path.join(app.getAppPath(), 'node_modules', 'sherpa-onnx-win-x64')
  process.env['PATH'] = `${dllDir};${process.env['PATH']}`
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sherpa = require('sherpa-onnx-node') as SherpaModule
  return sherpa
}

export function diarizationAvailable(): boolean {
  return modelAvailable('pyannote-segmentation') && modelAvailable('3dspeaker-embedding')
}

export function diarizeWav(wavPath: string): DiarTurn[] {
  const s = loadSherpa()
  const sd = new s.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: resolveModel('pyannote-segmentation') } },
    embedding: { model: resolveModel('3dspeaker-embedding') },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  })
  const samples = readWav16kMonoS16(wavPath)
  const turns = sd.process(samples)
  return turns.map((t) => ({
    startMs: Math.round(t.start * 1000),
    endMs: Math.round(t.end * 1000),
    speaker: t.speaker,
  }))
}

/**
 * Assign each transcript segment the diarization speaker with maximal time
 * overlap; ties resolve toward the longer turn. Segments with no overlapping
 * turn keep null (caller leaves them on the generic system speaker).
 * Pure — unit-tested.
 */
export function alignTurns(
  segments: { startMs: number; endMs: number }[],
  turns: DiarTurn[],
): (number | null)[] {
  return segments.map((seg) => {
    let best: { speaker: number; overlap: number; turnLen: number } | null = null
    for (const turn of turns) {
      const overlap = Math.min(seg.endMs, turn.endMs) - Math.max(seg.startMs, turn.startMs)
      if (overlap <= 0) continue
      const turnLen = turn.endMs - turn.startMs
      if (!best || overlap > best.overlap || (overlap === best.overlap && turnLen > best.turnLen)) {
        best = { speaker: turn.speaker, overlap, turnLen }
      }
    }
    return best ? best.speaker : null
  })
}
