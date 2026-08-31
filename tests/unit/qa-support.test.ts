import { describe, expect, it } from 'vitest'
import {
  cleanAnswer,
  degradedPairsFrom,
  dedupePairs,
  snapToSegment,
  type QaPair,
} from '../../src/main/pipeline/stages/qa-support'

const pair = (q: string, a: string, t: number | null = null): QaPair => ({ q, a, t })

describe('snapToSegment', () => {
  const starts = [0, 252_000, 700_000, 1_320_000]

  it('snaps a near-miss to the real segment start', () => {
    expect(snapToSegment(253_400, starts)).toBe(252_000)
  })

  it('returns null when nothing is close — a wrong seek is worse than none', () => {
    // The probe put 252000 on an answer about the designer role, which belonged
    // to the budget decision. If no segment is near, the button disappears.
    expect(snapToSegment(999_999, starts)).toBeNull()
  })

  it('respects the tolerance boundary', () => {
    expect(snapToSegment(252_000 + 30_000, starts)).toBe(252_000)
    expect(snapToSegment(252_000 + 30_001, starts)).toBeNull()
  })

  it('treats missing, negative and non-finite input as no timestamp', () => {
    expect(snapToSegment(null, starts)).toBeNull()
    expect(snapToSegment(undefined, starts)).toBeNull()
    expect(snapToSegment(-1, starts)).toBeNull()
    expect(snapToSegment(NaN, starts)).toBeNull()
  })

  it('returns null when there are no segments to snap to', () => {
    expect(snapToSegment(1000, [])).toBeNull()
  })
})

describe('dedupePairs', () => {
  it('keeps the fuller answer when a question repeats', () => {
    // Observed in the real probe: "Who is doing what?" twice, once complete.
    const out = dedupePairs([
      pair('Who is doing what?', 'Ronny writes the JDs; Maya confirms the buffer.'),
      pair('What did we decide?', 'Raise the budget.'),
      pair('Who is doing what?', 'Maya confirms the buffer.'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.a).toContain('Ronny')
  })

  it('ignores case, punctuation and spacing when comparing', () => {
    const out = dedupePairs([
      pair('What did we decide?', 'A'),
      pair('  what   did we DECIDE ', 'BB'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.a).toBe('BB')
  })

  it('preserves the original order of the questions it keeps', () => {
    const out = dedupePairs([pair('Second?', 'x'), pair('First?', 'y'), pair('Second?', 'zz')])
    expect(out.map((p) => p.q)).toEqual(['Second?', 'First?'])
  })

  it('drops entries whose question is empty or punctuation only', () => {
    expect(dedupePairs([pair('', 'x'), pair('???', 'y'), pair('Real?', 'z')])).toHaveLength(1)
  })
})

describe('degradedPairsFrom', () => {
  const summary = {
    tldr: 'Budget raised, handoff locked.',
    decisions: [{ text: 'Increase the Q3 hiring budget by 20 percent', t: 252_000 }],
    action_items: [{ text: 'Write the job descriptions by Friday', assignee: 'Ronny', t: 700_000 }],
    open_questions: ['What seniority level for the new designer?'],
  }

  it('builds a usable report from a summary with no model call', () => {
    const out = degradedPairsFrom(summary)
    expect(out.length).toBeGreaterThanOrEqual(4)
    expect(out.some((p) => p.a.includes('20 percent'))).toBe(true)
    expect(out.some((p) => p.q.includes('Ronny'))).toBe(true)
  })

  it('carries through the timestamps the summary already had', () => {
    const out = degradedPairsFrom(summary)
    expect(out.find((p) => p.a.includes('20 percent'))!.t).toBe(252_000)
  })

  it('produces nothing rather than filler for an empty summary', () => {
    expect(degradedPairsFrom({})).toEqual([])
  })
})

describe('cleanAnswer', () => {
  it('strips the timestamp marker the model leaks into prose', () => {
    // Real output: "...for two new engineering positions in the next quarter. t=19400"
    expect(cleanAnswer('We allocated budget for two new roles. t=19400')).toBe(
      'We allocated budget for two new roles.',
    )
  })

  it('handles the bracketed form and mid-sentence placement', () => {
    expect(cleanAnswer('Ronny writes the JDs [t=700000] by Friday.')).toBe(
      'Ronny writes the JDs by Friday.',
    )
  })

  it('does not eat ordinary text that merely contains a t', () => {
    expect(cleanAnswer('The target was set at 19400 units.')).toBe('The target was set at 19400 units.')
    expect(cleanAnswer('It took 3 attempts.')).toBe('It took 3 attempts.')
  })

  it('strips the null form too — the model writes t=null in prose as well', () => {
    // Real output: "...requiring clarification. t=null"
    expect(cleanAnswer('Community size needs clarification. t=null')).toBe(
      'Community size needs clarification.',
    )
  })

  it('leaves a clean answer untouched', () => {
    expect(cleanAnswer('We decided to ship on the 15th.')).toBe('We decided to ship on the 15th.')
  })
})
