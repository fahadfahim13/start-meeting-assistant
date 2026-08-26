import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
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

const MODEL_FILES: Record<ModelId, string> = {
  'whisper-large-v3-turbo-q5': 'ggml-large-v3-turbo-q5_0.bin',
  'silero-vad': 'ggml-silero-v5.1.2.bin',
  'pyannote-segmentation': 'pyannote-segmentation-3-0.onnx',
  '3dspeaker-embedding': '3dspeaker-eres2net-base.onnx',
}

export function modelsDir(): string {
  const dir = process.env['MEETFROGE_MODELS_DIR'] ?? path.join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveModel(id: ModelId): string {
  const p = path.join(modelsDir(), MODEL_FILES[id])
  if (!existsSync(p)) {
    throw new AppError('SYSTEM_BINARY_MISSING', `model missing: ${MODEL_FILES[id]} (expected in ${modelsDir()})`)
  }
  return p
}

export function modelAvailable(id: ModelId): boolean {
  return existsSync(path.join(modelsDir(), MODEL_FILES[id]))
}
