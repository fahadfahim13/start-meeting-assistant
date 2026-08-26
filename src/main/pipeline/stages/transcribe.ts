import { execFile, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveBinary } from '@main/platform/binaries'
import { resolveModel } from '@main/platform/models'

/**
 * whisper.cpp transcription of one extracted track.
 *
 * VAD is whisper-cli's built-in silero integration (`--vad`) — the plan's
 * "VAD gating before Whisper" efficiency win without a second runtime.
 * Output is whisper's JSON (`-oj`); progress is parsed from stderr (`-pp`).
 */

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscribeResult {
  segments: TranscriptSegment[]
  language: string
  elapsedMs: number
}

export interface TranscribeOptions {
  wavPath: string
  /** 'en' (default), 'bn', or 'auto' — the per-meeting override (ADR-004). */
  language: string
  threads: number
  onProgress?(pct: number): void
}

interface WhisperJson {
  result?: { language?: string }
  transcription?: {
    offsets?: { from: number; to: number }
    text?: string
  }[]
}

export function transcribeTrack(opts: TranscribeOptions): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const outBase = `${opts.wavPath}.whisper`
    const args = [
      '-m', resolveModel('whisper-large-v3-turbo-q5'),
      '-f', opts.wavPath,
      '-t', String(opts.threads),
      '-l', opts.language === 'auto' ? 'auto' : opts.language,
      '--vad',
      '-vm', resolveModel('silero-vad'),
      '-oj',
      '-of', outBase,
      '-pp',
      '-np', // no prints of the transcription itself to stderr
    ]

    const started = Date.now()
    const child: ChildProcess = execFile(
      resolveBinary('whisper-cli'),
      args,
      { timeout: 6 * 3600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error) => {
        if (error) return reject(new Error(`whisper failed: ${error.message}`))
        try {
          const raw = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as WhisperJson
          const segments: TranscriptSegment[] = (raw.transcription ?? [])
            .map((t) => ({
              startMs: t.offsets?.from ?? 0,
              endMs: t.offsets?.to ?? 0,
              text: (t.text ?? '').trim(),
            }))
            .filter((s) => s.text.length > 0)
          resolve({
            segments,
            language: raw.result?.language ?? opts.language,
            elapsedMs: Date.now() - started,
          })
        } catch (e) {
          reject(new Error(`whisper output parse failed: ${String(e)}`))
        }
      },
    )

    child.stderr?.on('data', (d: Buffer) => {
      // "whisper_print_progress_callback: progress =  15%"
      const m = /progress\s*=\s*(\d+)%/.exec(d.toString())
      if (m) opts.onProgress?.(parseInt(m[1]!, 10))
    })
  })
}
