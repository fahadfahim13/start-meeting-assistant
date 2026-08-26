import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { MODEL_REGISTRY, ALLOWED_DOWNLOAD_HOSTS, type ModelId } from './model-registry'
import { modelsDir, modelAvailable } from './models'

/**
 * Model downloads (plan §8.9): host-allowlisted HTTPS, resumable via Range,
 * SHA-256 verified BEFORE the file leaves its .partial name, atomic rename.
 * Every rule here was paid for: piped exit codes lied about a truncated
 * download (M-009), and a half-file crashed a consumer (M-013).
 */

export interface DownloadProgress {
  modelId: string
  received: number
  total: number
  state: 'downloading' | 'verifying' | 'done' | 'failed'
  error?: string
}

const active = new Map<ModelId, AbortController>()

function hostAllowed(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return ALLOWED_DOWNLOAD_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(p)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** pyannote ships inside a tar.bz2; Windows 10+ carries bsdtar in System32. */
async function extractPyannote(archivePath: string, destFile: string): Promise<void> {
  const tmpDir = path.join(modelsDir(), '.extract-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile(
      path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'),
      ['-xjf', archivePath, '-C', tmpDir],
      { timeout: 120_000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    )
  })
  const inner = path.join(tmpDir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
  if (!existsSync(inner)) throw new Error('archive did not contain the expected model.onnx')
  renameSync(inner, destFile)
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(archivePath, { force: true })
}

export async function downloadModel(
  id: ModelId,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const spec = MODEL_REGISTRY[id]
  if (modelAvailable(id)) {
    onProgress({ modelId: id, received: spec.bytes, total: spec.bytes, state: 'done' })
    return
  }
  if (!hostAllowed(spec.url)) throw new Error(`download host not allowlisted: ${spec.url}`)
  if (active.has(id)) return // already downloading

  const isArchive = spec.url.endsWith('.tar.bz2')
  const finalPath = path.join(modelsDir(), spec.file)
  const partialPath = `${finalPath}.partial${isArchive ? '.tar.bz2' : ''}`

  const controller = new AbortController()
  active.set(id, controller)
  try {
    // Resume from an existing partial (archives restart — their size is unknown).
    let start = 0
    if (!isArchive && existsSync(partialPath)) start = statSync(partialPath).size

    const res = await fetch(spec.url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`)
    if (start > 0 && res.status !== 206) start = 0 // server ignored the range — restart

    const total = isArchive
      ? parseInt(res.headers.get('content-length') ?? '0', 10) + start
      : spec.bytes
    const out = createWriteStream(partialPath, { flags: start > 0 ? 'a' : 'w' })
    let received = start
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(value)
      received += value.byteLength
      onProgress({ modelId: id, received, total, state: 'downloading' })
    }
    await new Promise<void>((resolve, reject) => out.end((e: unknown) => (e ? reject(e) : resolve())))

    onProgress({ modelId: id, received, total, state: 'verifying' })
    if (isArchive) {
      await extractPyannote(partialPath, finalPath)
    } else {
      renameSync(partialPath, finalPath)
    }

    // The gate: size AND hash, before the model counts as usable (T6).
    const size = statSync(finalPath).size
    if (size !== spec.bytes) throw new Error(`size ${size} != expected ${spec.bytes}`)
    const hash = await sha256File(finalPath)
    if (hash !== spec.sha256) {
      rmSync(finalPath, { force: true })
      throw new Error('sha256 mismatch — file deleted')
    }
    onProgress({ modelId: id, received: spec.bytes, total: spec.bytes, state: 'done' })
  } catch (e) {
    onProgress({
      modelId: id,
      received: 0,
      total: spec.bytes,
      state: 'failed',
      error: String(e).slice(0, 300),
    })
    throw e
  } finally {
    active.delete(id)
  }
}

export function cancelDownload(id: ModelId): void {
  active.get(id)?.abort()
}
