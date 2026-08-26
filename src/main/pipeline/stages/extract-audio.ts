import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '@main/platform/binaries'

/**
 * Extract each audio track as 16 kHz mono WAV for transcription, with EBU R128
 * loudness normalization to stabilize Whisper input levels (plan §8.3.1).
 * Also measures each track's mean volume so downstream stages can skip
 * transcribing digital silence — many meetings are mic-only or system-only,
 * and running Whisper over silence wastes half the pipeline time.
 */

export interface ExtractedTrack {
  track: 'mic' | 'system'
  wavPath: string
  meanVolumeDb: number | null
  /** Below -70 dB mean is effectively silence — not worth transcribing. */
  isSilent: boolean
}

const SILENCE_MEAN_DB = -70

function run(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffmpeg'),
      ['-hide_banner', ...args],
      { timeout: 30 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, _stdout, stderr) => resolve({ ok: !error, stderr: String(stderr) }),
    )
  })
}

async function extractOne(
  mediaPath: string,
  streamSpec: string,
  track: 'mic' | 'system',
  outDir: string,
): Promise<ExtractedTrack | null> {
  const wavPath = path.join(outDir, `${track}.wav`)
  const res = await run([
    '-loglevel', 'info', '-y',
    '-i', mediaPath,
    '-map', streamSpec,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,volumedetect',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wavPath,
  ])
  if (!res.ok) return null

  const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(res.stderr)
  const meanVolumeDb = m ? parseFloat(m[1]!) : null
  return {
    track,
    wavPath,
    meanVolumeDb,
    isSilent: meanVolumeDb !== null && meanVolumeDb < SILENCE_MEAN_DB,
  }
}

export async function extractAudio(input: {
  mediaPath: string
  workDir: string
  hasMic: boolean
  hasSystem: boolean
}): Promise<ExtractedTrack[]> {
  mkdirSync(input.workDir, { recursive: true })
  const tracks: ExtractedTrack[] = []

  // Track order is fixed by ADR-007: a:0 mic, a:1 system. When only one audio
  // track exists it is a:0 regardless of which source it came from.
  let audioIndex = 0
  if (input.hasMic) {
    const t = await extractOne(input.mediaPath, `0:a:${audioIndex++}`, 'mic', input.workDir)
    if (t) tracks.push(t)
  }
  if (input.hasSystem) {
    const t = await extractOne(input.mediaPath, `0:a:${audioIndex++}`, 'system', input.workDir)
    if (t) tracks.push(t)
  }
  return tracks
}
