import { app } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { modelAvailable, resolveModel } from '@main/platform/models'
import { getDb } from '@main/db'
import { chat, ensureLlm } from '../llm/server'

/**
 * VLM captioning of keyframes (plan §8.4.4) — tier 2, after OCR. One call per
 * keyframe produces both the caption and the scene type, in a constrained
 * format rather than free prose.
 */

const SCENE_TYPES = ['slide', 'code', 'document', 'browser', 'video', 'desktop', 'other'] as const

// One plain ask. SmolVLM2-2.2B ignores multi-field format instructions and
// answers in free prose (M-015) — the caption IS the reply; scene type is
// inferred from caption keywords below.
const PROMPT =
  'Describe this screenshot from a meeting recording in one or two sentences. ' +
  'If it shows a slide, document, code, chart or website, say what it is about.'

export function vlmAvailable(): boolean {
  return modelAvailable('smolvlm2') && modelAvailable('smolvlm2-mmproj')
}

const SCENE_KEYWORDS: Record<string, RegExp> = {
  slide: /slide|presentation|powerpoint|deck/i,
  code: /code|editor|terminal|programming|function|console/i,
  document: /document|text document|word|pdf|letter|report|spreadsheet/i,
  browser: /browser|website|web page|webpage|url|search engine/i,
  video: /video (?:call|conference|player)|watching|movie/i,
  desktop: /desktop|taskbar|file explorer|home screen/i,
}

function parseReply(text: string): { sceneType: string | null; caption: string | null } {
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

export async function captionKeyframes(input: {
  meetingId: string
  onProgress(pct: number): void
}): Promise<{ processed: number; captioned: number }> {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, image_path FROM keyframes WHERE meeting_id = ? ORDER BY timestamp_ms')
    .all(input.meetingId) as unknown as { id: string; image_path: string }[]
  if (rows.length === 0) return { processed: 0, captioned: 0 }

  const server = await ensureLlm({
    modelPath: resolveModel('smolvlm2'),
    mmprojPath: resolveModel('smolvlm2-mmproj'),
    contextSize: 4096,
  })

  let captioned = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    try {
      const jpeg = readFileSync(path.join(app.getPath('userData'), row.image_path))
      const reply = await chat({
        server,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
            ],
          },
        ],
        maxTokens: 120,
      })
      const { sceneType, caption } = parseReply(reply)
      if (caption) {
        db.prepare('UPDATE keyframes SET vlm_caption = ?, scene_type = ? WHERE id = ?').run(caption, sceneType, row.id)
        db.prepare('UPDATE keyframe_fts SET vlm_caption = ? WHERE keyframe_id = ?').run(caption, row.id)
        captioned++
      }
    } catch (e) {
      console.warn(`[vlm] keyframe ${row.id}:`, String(e).slice(0, 200))
    }
    input.onProgress(Math.round(((i + 1) / rows.length) * 100))
  }
  return { processed: rows.length, captioned }
}
