import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { MODEL_REGISTRY, type ModelId } from './model-registry'

export type { ModelId } from './model-registry'

/**
 * Model file resolution over the pinned registry (file + exact bytes + sha256).
 * Presence checks verify SIZE on every call (cheap); the full hash is verified
 * at download time — a partial file must never count as present (M-013).
 */

export function modelsDir(): string {
  const dir = process.env['MEETFROGE_MODELS_DIR'] ?? path.join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

function checkModel(id: ModelId): { path: string; ok: boolean; reason: string | null } {
  const spec = MODEL_REGISTRY[id]
  const p = path.join(modelsDir(), spec.file)
  if (!existsSync(p)) return { path: p, ok: false, reason: 'missing' }
  const actual = statSync(p).size
  if (actual !== spec.bytes) {
    return { path: p, ok: false, reason: `size ${actual} != expected ${spec.bytes} (partial or corrupt)` }
  }
  return { path: p, ok: true, reason: null }
}

export const MODEL_IDS = Object.keys(MODEL_REGISTRY) as ModelId[]

export function modelStatus(id: ModelId): { id: string; file: string; status: 'ok' | 'missing' | 'corrupt' } {
  const c = checkModel(id)
  return {
    id,
    file: MODEL_REGISTRY[id].file,
    status: c.ok ? 'ok' : c.reason === 'missing' ? 'missing' : 'corrupt',
  }
}

export function resolveModel(id: ModelId): string {
  const c = checkModel(id)
  if (!c.ok) {
    throw new AppError('SYSTEM_BINARY_MISSING', `model ${MODEL_REGISTRY[id].file}: ${c.reason} (dir: ${modelsDir()})`)
  }
  return c.path
}

export function modelAvailable(id: ModelId): boolean {
  const c = checkModel(id)
  if (!c.ok && c.reason !== 'missing') {
    console.warn(`[models] ${MODEL_REGISTRY[id].file}: ${c.reason}`)
  }
  return c.ok
}
