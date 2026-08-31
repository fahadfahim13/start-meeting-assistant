/**
 * Scene classification from a VLM caption — pure, so it can be unit-tested
 * without Electron (same shape as `chunking.ts` and `keyframe-select.ts`).
 *
 * It was extracted precisely because it could NOT be tested where it lived, and
 * it had been silently wrong for its whole life: the source held literal
 * BACKSPACE bytes (0x08) where `\b` word boundaries were intended, and the
 * alternation was never grouped. `/\x08slide|presentation|powerpoint|deck\x08/i`
 * parses as four independent alternatives, so "a slide about budget" and "the
 * deck" never matched while "powerpointless" did. Every keyword group had a
 * dead first and last entry. eslint's `no-control-regex` had been reporting it
 * the entire time and the finding was read as noise.
 */

export const SCENE_TYPES = [
  'slide',
  'code',
  'document',
  'browser',
  'video',
  'desktop',
  'other',
] as const

export type SceneType = (typeof SCENE_TYPES)[number]

/**
 * Grouping is load-bearing: `\b(?:a|b)\b` applies the boundaries to every
 * alternative, `\ba|b\b` applies them only to the first and the last.
 */
export const SCENE_KEYWORDS: Record<string, RegExp> = {
  slide: /\b(?:slide|presentation|powerpoint|deck)\b/i,
  code: /\b(?:code|editor|terminal|programming|function|console)\b/i,
  document: /\b(?:document|text document|word|pdf|letter|report|spreadsheet)\b/i,
  browser: /\b(?:browser|website|web page|webpage|url|search engine)\b/i,
  video: /\b(?:video (?:call|conference|player)|watching|movie)\b/i,
  desktop: /\b(?:desktop|taskbar|file explorer|home screen)\b/i,
}

/**
 * The caption IS the model's reply (M-015: a 2B VLM ignores multi-field format
 * instructions and answers in prose), so the scene type is inferred from it.
 */
export function parseReply(text: string): { sceneType: string | null; caption: string | null } {
  const caption = text.replace(/\s+/g, ' ').trim().slice(0, 500) || null
  let sceneType: string | null = null
  if (caption) {
    for (const t of SCENE_TYPES) {
      const re = SCENE_KEYWORDS[t]
      if (re && re.test(caption)) {
        sceneType = t
        break
      }
    }
  }
  return { sceneType, caption }
}
