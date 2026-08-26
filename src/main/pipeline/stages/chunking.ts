/**
 * Semantic transcript chunking (plan §8.5.2). Pure — no Electron imports —
 * so it stays unit-testable. Greedy-packs whole speaker turns into
 * ~token-budget chunks; a turn is never split.
 */

export const CHUNK_TOKEN_BUDGET = 2500
const CHARS_PER_TOKEN = 4

export interface ChunkInput {
  startMs: number
  speaker: string
  text: string
}

export function chunkTranscript(rows: ChunkInput[], tokenBudget = CHUNK_TOKEN_BUDGET): ChunkInput[][] {
  const chunks: ChunkInput[][] = []
  let current: ChunkInput[] = []
  let budget = 0
  for (const row of rows) {
    const cost = Math.ceil(row.text.length / CHARS_PER_TOKEN) + 8
    if (current.length > 0 && budget + cost > tokenBudget) {
      chunks.push(current)
      current = []
      budget = 0
    }
    current.push(row)
    budget += cost
  }
  if (current.length) chunks.push(current)
  return chunks
}

export function renderChunk(chunk: ChunkInput[]): string {
  return chunk.map((r) => `[t=${r.startMs}] ${r.speaker}: ${r.text}`).join('\n')
}
