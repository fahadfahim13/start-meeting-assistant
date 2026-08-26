import { describe, expect, it } from 'vitest'
import { chunkTranscript } from '../../src/main/pipeline/stages/chunking'

const turn = (startMs: number, speaker: string, words: number) => ({
  startMs,
  speaker,
  text: Array.from({ length: words }, (_, i) => `word${i}`).join(' '),
})

describe('chunkTranscript — semantic chunking (plan §8.5.2)', () => {
  it('keeps a short meeting in one chunk', () => {
    const rows = [turn(0, 'You', 50), turn(5000, 'Others', 60)]
    expect(chunkTranscript(rows)).toHaveLength(1)
  })

  it('splits at turn boundaries, never inside a turn', () => {
    const rows = Array.from({ length: 40 }, (_, i) => turn(i * 10_000, i % 2 ? 'Others' : 'You', 300))
    const chunks = chunkTranscript(rows, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    // every original turn appears exactly once, whole
    const flat = chunks.flat()
    expect(flat).toHaveLength(rows.length)
    expect(flat.map((r) => r.startMs)).toEqual(rows.map((r) => r.startMs))
  })

  it('a single oversized turn still forms its own chunk rather than being dropped', () => {
    const rows = [turn(0, 'Others', 5000)]
    const chunks = chunkTranscript(rows, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(1)
  })

  it('preserves order across chunk boundaries', () => {
    const rows = Array.from({ length: 10 }, (_, i) => turn(i * 1000, 'You', 400))
    const chunks = chunkTranscript(rows, 500)
    const starts = chunks.flat().map((r) => r.startMs)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })
})
