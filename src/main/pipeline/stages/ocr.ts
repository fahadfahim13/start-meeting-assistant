import { app } from 'electron'
import path from 'node:path'
import { createWorker, type Worker } from 'tesseract.js'
import { modelsDir } from '@main/platform/models'
import { getDb } from '@main/db'

/**
 * OCR over keyframes (plan §8.4.3) — tier 1 of visual analysis: for
 * screen-share meetings the value is overwhelmingly TEXT, and OCR captures it
 * at a fraction of a VLM's cost while feeding full-text search directly.
 *
 * Fully offline: langPath points at the local models dir (eng.traineddata
 * staged there); nothing is fetched at runtime.
 */

let worker: Worker | null = null

async function getWorker(): Promise<Worker> {
  if (worker) return worker
  worker = await createWorker('eng', 1, {
    langPath: modelsDir(),
    gzip: false,
    cachePath: path.join(app.getPath('userData'), 'work'),
  })
  return worker
}

export async function disposeOcr(): Promise<void> {
  await worker?.terminate()
  worker = null
}

export interface OcrOutcome {
  processed: number
  withText: number
}

export async function ocrKeyframes(input: {
  meetingId: string
  onProgress(pct: number): void
}): Promise<OcrOutcome> {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, image_path FROM keyframes WHERE meeting_id = ? ORDER BY timestamp_ms')
    .all(input.meetingId) as unknown as { id: string; image_path: string }[]
  if (rows.length === 0) return { processed: 0, withText: 0 }

  const w = await getWorker()
  let withText = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const absPath = path.join(app.getPath('userData'), row.image_path)
    try {
      const result = await w.recognize(absPath)
      const text = result.data.text.replace(/\s+/g, ' ').trim()
      const confidence = result.data.confidence
      // Low-confidence noise pollutes search more than it helps.
      const usable = text.length >= 3 && confidence >= 40
      db.prepare('UPDATE keyframes SET ocr_text = ?, ocr_confidence = ? WHERE id = ?').run(
        usable ? text : null,
        confidence,
        row.id,
      )
      if (usable) {
        db.prepare('INSERT INTO keyframe_fts (ocr_text, vlm_caption, meeting_id, keyframe_id) VALUES (?, ?, ?, ?)').run(
          text,
          '',
          input.meetingId,
          row.id,
        )
        withText++
      }
    } catch (e) {
      console.warn(`[ocr] keyframe ${row.id} failed:`, String(e).slice(0, 200))
    }
    input.onProgress(Math.round(((i + 1) / rows.length) * 100))
  }
  return { processed: rows.length, withText }
}
