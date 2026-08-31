/**
 * Pure helpers for the Q&A report — no Electron, no fs, no network, so they
 * unit-test like `chunking.ts` and `vlm-scene.ts`.
 *
 * Everything here exists because of something observed in a real probe against
 * qwen3-4b before any of this was built (M-015's rule):
 *
 * - the model reused one fact's timestamp on an unrelated answer, so a `t` is
 *   only trusted if it lands near a real transcript segment (`snapToSegment`)
 * - it asked "Who is doing what?" twice with different answers (`dedupePairs`)
 * - when there is nothing to send it, a report can still be assembled from the
 *   stored summary for free (`degradedPairsFrom`)
 */

export interface QaPair {
  q: string
  a: string
  /** Milliseconds into the recording, or null when there is nothing to seek to. */
  t: number | null
}

/**
 * Keep a model-supplied timestamp only if a real transcript segment starts near
 * it, and snap it to that segment's start.
 *
 * A wrong seek is worse than no seek: the user clicks, lands somewhere
 * unrelated, and stops trusting every other timestamp on the page. Returning
 * null costs a button; returning a plausible-looking lie costs the feature.
 */
export function snapToSegment(
  t: number | null | undefined,
  segmentStarts: number[],
  toleranceMs = 30_000,
): number | null {
  if (t === null || t === undefined || !Number.isFinite(t) || t < 0) return null
  if (segmentStarts.length === 0) return null

  let best: number | null = null
  let bestDelta = Infinity
  for (const start of segmentStarts) {
    const delta = Math.abs(start - t)
    if (delta < bestDelta) {
      bestDelta = delta
      best = start
    }
  }
  return bestDelta <= toleranceMs ? best : null
}

/**
 * Strip the timestamp marker the model leaks into its prose.
 *
 * Observed on a real meeting: told to put the `[t=...]` value in the `t` field,
 * qwen3-4b puts it there AND writes it into the answer, so the UI rendered
 * "...in the next quarter. t=19400" next to a perfectly good 0:19 button. The
 * marker is machine plumbing; it has no business in a sentence.
 */
export function cleanAnswer(text: string): string {
  return (
    text
      // A negative lookbehind for a letter rather than a word-boundary
      // escape, deliberately: that escape was written into this very file
      // as a literal 0x08 backspace byte on the first attempt, which is
      // exactly M-026. A lookbehind cannot be mistyped into an invisible
      // control character.
      .replace(/\[?(?<![a-z])t\s*=\s*(?:\d+|null)\]?/gi, '')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}

/** Lowercased, punctuation-free, whitespace-collapsed — for comparison only. */
function normaliseQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Drop repeated questions, keeping the one with the most substantial answer.
 *
 * The probe produced "Who is doing what?" twice — once covering both assignees
 * and once covering only the second. Keeping the longer answer keeps the more
 * complete of the two rather than whichever happened to come first.
 */
export function dedupePairs(pairs: QaPair[]): QaPair[] {
  const byQuestion = new Map<string, QaPair>()
  const order: string[] = []
  for (const pair of pairs) {
    const key = normaliseQuestion(pair.q)
    if (!key) continue
    const existing = byQuestion.get(key)
    if (!existing) {
      byQuestion.set(key, pair)
      order.push(key)
      continue
    }
    if (pair.a.length > existing.a.length) byQuestion.set(key, pair)
  }
  return order.map((k) => byQuestion.get(k)!)
}

/** The subset of a stored summary this fallback can build from. */
export interface SummaryLike {
  decisions?: { text: string; t?: number }[]
  action_items?: { text: string; assignee?: string | null; t?: number }[]
  open_questions?: string[]
  tldr?: string
}

/**
 * Build a report mechanically from an existing summary, with no model call.
 *
 * Used when the LLM pass fails validation twice. It costs zero tokens and is
 * marked `degraded` so the UI can say so — an honest smaller answer rather than
 * a spinner that never resolves (Principle 3).
 */
export function degradedPairsFrom(summary: SummaryLike): QaPair[] {
  const pairs: QaPair[] = []

  if (summary.tldr) {
    pairs.push({ q: 'What was this meeting about?', a: summary.tldr, t: null })
  }
  for (const d of summary.decisions ?? []) {
    pairs.push({ q: 'What was decided?', a: d.text, t: d.t ?? null })
  }
  for (const a of summary.action_items ?? []) {
    pairs.push({
      q: a.assignee ? `What is ${a.assignee} doing?` : 'What needs to happen next?',
      a: a.text,
      t: a.t ?? null,
    })
  }
  for (const q of summary.open_questions ?? []) {
    pairs.push({ q, a: 'Raised in the meeting and left unresolved.', t: null })
  }
  return dedupePairs(pairs)
}
