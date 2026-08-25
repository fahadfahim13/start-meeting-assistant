import { describe, expect, it } from 'vitest'
import { reconcile } from '../../src/main/capture/reconcile'

describe('WebRTC ↔ DirectShow name reconciliation (R-06)', () => {
  const dshow = ['HP TrueVision HD Camera', 'Microphone Array (AMD Audio Device)']

  it('matches identical names', () => {
    expect(reconcile('HP TrueVision HD Camera', dshow)).toBe('HP TrueVision HD Camera')
  })

  it('strips the Chromium USB vid:pid suffix', () => {
    expect(reconcile('HP TrueVision HD Camera (04f2:b6f1)', dshow)).toBe('HP TrueVision HD Camera')
  })

  it('falls back to substring containment', () => {
    expect(reconcile('Microphone Array', dshow)).toBe('Microphone Array (AMD Audio Device)')
  })

  it('returns null rather than guessing on no match', () => {
    expect(reconcile('Totally Different Device', dshow)).toBeNull()
  })

  it('does not treat a parenthetical device suffix as a USB id', () => {
    // "(AMD Audio Device)" is not a vid:pid — stripping it would be wrong.
    expect(reconcile('Microphone Array (AMD Audio Device)', dshow)).toBe(
      'Microphone Array (AMD Audio Device)',
    )
  })
})
