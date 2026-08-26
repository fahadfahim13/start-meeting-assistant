import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/**
 * Model file resolution. Models live in userData/models (populated by the
 * model manager in Phase 7's download flow; in development they are placed
 * there by hand — docs/setup.md). MEETFROGE_MODELS_DIR overrides for testing.
 */

export type ModelId =
  | 'whisper-large-v3-turbo-q5'
  | 'silero-vad'
  | 'pyannote-segmentation'
  | '3dspeaker-embedding'
  | 'smolvlm2'
  | 'smolvlm2-mmproj'
  | 'qwen3-4b'

/**
 * File name + EXACT expected byte size per model. Size is verified before a
 * model is reported available: a partially-downloaded file must never count
 * as present — a truncated mmproj sent llama-server to exit(1) mid-pipeline
 * (M-013, the M-009 lesson resurfacing at the consumer side). Phase 7's model
 * manager adds SHA-256; size is the floor.
 */
const MODEL_FILES: Record<ModelId, { file: string; bytes: number }> = {
  'whisper-large-v3-turbo-q5': { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574_041_195 },
  'silero-vad': { file: 'ggml-silero-v5.1.2.bin', bytes: 885_098 },
  'pyannote-segmentation': { file: 'pyannote-segmentation-3-0.onnx', bytes: 5_992_913 },
  '3dspeaker-embedding': { file: '3dspeaker-eres2net-base.onnx', bytes: 39_593_761 },
  smolvlm2: { file: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf', bytes: 1_112_602_656 },
  'smolvlm2-mmproj': { file: 'mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf', bytes: 592_523_200 },
  'qwen3-4b': { file: 'qwen3-4b-instruct-q4_k_m.gguf', bytes: 2_497_280_736 },
}

export function modelsDir(): string {
  const dir = process.env['MEETFROGE_MODELS_DIR'] ?? path.join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

function checkModel(id: ModelId): { path: string; ok: boolean; reason: string | null } {
  const spec = MODEL_FILES[id]
  const p = path.join(modelsDir(), spec.file)
  if (!existsSync(p)) return { path: p, ok: false, reason: 'missing' }
  const actual = statSync(p).size
  if (actual !== spec.bytes) {
    return { path: p, ok: false, reason: `size ${actual} != expected ${spec.bytes} (partial or corrupt)` }
  }
  return { path: p, ok: true, reason: null }
}

export function resolveModel(id: ModelId): string {
  const c = checkModel(id)
  if (!c.ok) {
    throw new AppError('SYSTEM_BINARY_MISSING', `model ${MODEL_FILES[id].file}: ${c.reason} (dir: ${modelsDir()})`)
  }
  return c.path
}

export function modelAvailable(id: ModelId): boolean {
  const c = checkModel(id)
  if (!c.ok && c.reason !== 'missing') {
    console.warn(`[models] ${MODEL_FILES[id].file}: ${c.reason}`)
  }
  return c.ok
}
