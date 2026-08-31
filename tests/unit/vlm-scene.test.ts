import { describe, expect, it } from 'vitest'
import { parseReply, SCENE_KEYWORDS } from '../../src/main/pipeline/stages/vlm-scene'

/**
 * Regression pin for a classifier that was wrong for its whole life.
 *
 * The source contained literal backspace bytes (0x08) where `\b` was meant, and
 * the alternation was never grouped, so `/\x08slide|presentation|powerpoint|deck\x08/i`
 * matched "powerpointless" but not "a slide about budget" or "the deck".
 */
describe('SCENE_KEYWORDS', () => {
  it('contains no control characters — the bug was invisible in the source', () => {
    for (const [name, re] of Object.entries(SCENE_KEYWORDS)) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f]/.test(re.source), `${name} carries a control character`).toBe(false)
    }
  })

  it('applies word boundaries to EVERY alternative, not just the outer two', () => {
    // Grouping is what makes this true. Without it the boundaries bind only to
    // the first and last keyword in each list.
    for (const [name, re] of Object.entries(SCENE_KEYWORDS)) {
      expect(re.source.startsWith('\\b(?:'), `${name} is not grouped`).toBe(true)
      expect(re.source.endsWith(')\\b'), `${name} is not grouped`).toBe(true)
    }
  })
})

describe('parseReply', () => {
  it('matches the FIRST keyword of a group — previously dead', () => {
    expect(parseReply('A slide about the Q3 budget.').sceneType).toBe('slide')
    expect(parseReply('Some code in an editor.').sceneType).toBe('code')
  })

  it('matches the LAST keyword of a group — previously dead', () => {
    expect(parseReply('The deck is on screen.').sceneType).toBe('slide')
    expect(parseReply('A home screen with icons.').sceneType).toBe('desktop')
  })

  it('no longer matches a keyword buried inside a longer word', () => {
    // "powerpointless" used to classify as a slide.
    expect(parseReply('This is powerpointless nonsense.').sceneType).not.toBe('slide')
    expect(parseReply('He decoded the message.').sceneType).not.toBe('code')
  })

  it('keeps the multi-word video pattern working', () => {
    expect(parseReply('A video call with four people.').sceneType).toBe('video')
    expect(parseReply('Someone is watching a movie.').sceneType).toBe('video')
  })

  it('returns null rather than guessing when nothing matches', () => {
    expect(parseReply('A photograph of a cat.').sceneType).toBeNull()
  })

  it('collapses whitespace and caps the caption, and treats blank as null', () => {
    expect(parseReply('  a   slide\n\nhere  ').caption).toBe('a slide here')
    expect(parseReply('   ').caption).toBeNull()
    expect(parseReply('x'.repeat(900)).caption).toHaveLength(500)
  })
})
