import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { resolveBinary } from '@main/platform/binaries'
import { getDb } from '@main/db'
import { DEFAULT_SELECTION, FRAME_BYTES, pHash, selectKeyframes, type SelectionOptions, type SelectionResult } from './keyframe-select'
import { log } from '@main/log'

/** Settings presets → selection options (plan §8.4.2 Sensitive/Balanced/Sparse). */
export const SENSITIVITY_PRESETS: Record<'sensitive' | 'balanced' | 'sparse', SelectionOptions> = {
  sensitive: { ...DEFAULT_SELECTION, hashThreshold: 8, strongMargin: 4, minGapS: 2 },
  balanced: DEFAULT_SELECTION,
  sparse: { ...DEFAULT_SELECTION, hashThreshold: 16, strongMargin: 8, minGapS: 5 },
}

/**
 * Visual sampling (plan §8.4.1–8.4.2). One ffmpeg pass emits the whole screen
 * track as raw 32×32 grayscale — 1 KB/second, no image decode in Node. The
 * selection walk picks keyframes; full-resolution JPEGs are then re-extracted
 * only at those timestamps for OCR/VLM/display.
 */

function run(args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffmpeg'),
      ['-hide_banner', '-loglevel', 'error', ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => resolve({ ok: !error, stderr: String(stderr) }),
    )
  })
}

export function framesDirFor(meetingId: string): string {
  const dir = path.join(app.getPath('userData'), 'frames', meetingId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface KeyframesOutcome {
  selection: SelectionResult
  written: number
}

export async function extractKeyframes(input: {
  meetingId: string
  mediaPath: string
  workDir: string
  sensitivity?: 'sensitive' | 'balanced' | 'sparse'
  onProgress(pct: number): void
}): Promise<KeyframesOutcome> {
  const grayPath = path.join(input.workDir, 'screen-gray.raw')

  // 1. The whole screen track at 1 fps as raw grayscale.
  const grayRes = await run(
    ['-y', '-i', input.mediaPath, '-map', '0:v:0', '-vf', 'fps=1,scale=32:32', '-pix_fmt', 'gray', '-f', 'rawvideo', grayPath],
    30 * 60_000,
  )
  if (!grayRes.ok) throw new Error(`gray extraction failed: ${grayRes.stderr.slice(-300)}`)
  input.onProgress(25)

  const frames = new Uint8Array(readFileSync(grayPath))
  const selection = selectKeyframes(frames, SENSITIVITY_PRESETS[input.sensitivity ?? 'balanced'])
  if (selection.capped) {
    log.warn('keyframes', 'cap bound - visual coverage truncated', {
      keyframes: selection.keyframes.length,
      totalSeconds: selection.totalFrames,
    })
  }
  input.onProgress(35)

  // 2. Full-resolution re-extraction at each keyframe timestamp.
  const framesDir = framesDirFor(input.meetingId)
  const db = getDb()
  db.prepare('DELETE FROM keyframe_fts WHERE meeting_id = ?').run(input.meetingId)
  db.prepare('DELETE FROM keyframes WHERE meeting_id = ?').run(input.meetingId)

  let written = 0
  for (let i = 0; i < selection.keyframes.length; i++) {
    const kf = selection.keyframes[i]!
    const fileName = `kf_${String(kf.timestampMs).padStart(9, '0')}.jpg`
    const outPath = path.join(framesDir, fileName)
    // -ss before -i: fast keyframe-accurate seek, then decode one frame.
    const res = await run(
      ['-y', '-ss', String(kf.timestampMs / 1000), '-i', input.mediaPath, '-map', '0:v:0', '-frames:v', '1', '-q:v', '3', outPath],
      60_000,
    )
    if (res.ok) {
      const gray = frames.subarray(kf.index * FRAME_BYTES, (kf.index + 1) * FRAME_BYTES)
      db.prepare(
        `INSERT INTO keyframes (id, meeting_id, timestamp_ms, image_path, phash, change_score)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.meetingId,
        kf.timestampMs,
        path.join('frames', input.meetingId, fileName),
        pHash(gray).toString(16),
        kf.changeScore,
      )
      written++
    }
    input.onProgress(35 + Math.round(((i + 1) / selection.keyframes.length) * 60))
  }

  return { selection, written }
}

/**
 * Camera presence (plan §8.4.5): cheap luminance/variance heuristics on the
 * camera track at 0.2 fps. No per-frame face detection — deliberately.
 */
export async function detectCameraPresence(input: {
  meetingId: string
  mediaPath: string
  workDir: string
}): Promise<number> {
  const grayPath = path.join(input.workDir, 'camera-gray.raw')
  const res = await run(
    ['-y', '-i', input.mediaPath, '-map', '0:v:1', '-vf', 'fps=0.2,scale=32:32', '-pix_fmt', 'gray', '-f', 'rawvideo', grayPath],
    30 * 60_000,
  )
  if (!res.ok) return 0 // no camera track — not an error

  const frames = new Uint8Array(readFileSync(grayPath))
  const total = Math.floor(frames.length / FRAME_BYTES)
  const SAMPLE_MS = 5000

  // Present = not near-black and not frozen flat.
  const present: boolean[] = []
  for (let i = 0; i < total; i++) {
    const gray = frames.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)
    let sum = 0
    for (let j = 0; j < gray.length; j++) sum += gray[j]!
    const mean = sum / gray.length
    let varAcc = 0
    for (let j = 0; j < gray.length; j++) varAcc += (gray[j]! - mean) ** 2
    present.push(mean > 16 && varAcc / gray.length > 25)
  }

  // Collapse into spans.
  const db = getDb()
  db.prepare('DELETE FROM camera_presence WHERE meeting_id = ?').run(input.meetingId)
  let spans = 0
  let spanStart: number | null = null
  for (let i = 0; i <= total; i++) {
    const p = i < total ? present[i]! : false
    if (p && spanStart === null) spanStart = i * SAMPLE_MS
    if (!p && spanStart !== null) {
      db.prepare('INSERT INTO camera_presence (meeting_id, start_ms, end_ms) VALUES (?, ?, ?)').run(
        input.meetingId,
        spanStart,
        i * SAMPLE_MS,
      )
      spans++
      spanStart = null
    }
  }
  return spans
}
