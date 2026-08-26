import { describe, expect, it } from 'vitest'
import { alignTurns } from '../../src/main/pipeline/stages/diarize'

describe('alignTurns — diarization ↔ transcript alignment (plan §8.3.3)', () => {
  const turns = [
    { startMs: 0, endMs: 5000, speaker: 0 },
    { startMs: 5500, endMs: 12000, speaker: 1 },
    { startMs: 12500, endMs: 20000, speaker: 0 },
  ]

  it('assigns by containment', () => {
    expect(alignTurns([{ startMs: 1000, endMs: 4000 }], turns)).toEqual([0])
    expect(alignTurns([{ startMs: 6000, endMs: 11000 }], turns)).toEqual([1])
  })

  it('assigns by maximal overlap when a segment spans a boundary', () => {
    // 4000–7000: 1000 ms with speaker 0, 1500 ms with speaker 1 → speaker 1.
    expect(alignTurns([{ startMs: 4000, endMs: 7000 }], turns)).toEqual([1])
  })

  it('returns null when nothing overlaps (silence gap)', () => {
    expect(alignTurns([{ startMs: 5100, endMs: 5400 }], turns)).toEqual([null])
    expect(alignTurns([{ startMs: 25000, endMs: 26000 }], turns)).toEqual([null])
  })

  it('breaks exact-overlap ties toward the longer turn', () => {
    const tied = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 1000, endMs: 3000, speaker: 1 },
    ]
    // 500–1500: 500 ms with each → the longer turn (speaker 1) wins.
    expect(alignTurns([{ startMs: 500, endMs: 1500 }], tied)).toEqual([1])
  })

  it('handles empty turn lists (diarization found nothing)', () => {
    expect(alignTurns([{ startMs: 0, endMs: 1000 }], [])).toEqual([null])
  })
})
