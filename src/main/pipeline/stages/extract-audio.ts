import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '@main/platform/binaries'
import { classifyLevel, parseVolumeDetect, type AudioLevel } from '@shared/audio-levels'

/**
 * Extract each audio track as 16 kHz mono WAV for transcription, with EBU R128
 * loudness normalization to stabilize Whisper input levels (plan §8.3.1).
 *
 * Also measures each track's real level so a later empty transcript can be
 * EXPLAINED rather than merely observed. The measurement used to run after
 * loudnorm, which meant it measured loudnorm's output and reported a
 * near-silent microphone as a healthy -19.8 dB — see MISTAKES.md M-023.
 */

export interface ExtractedTrack {
  track: 'mic' | 'system'
  wavPath: string
  meanVolumeDb: number | null
  maxVolumeDb: number | null
  /** Shared classifier — the capture session reaches the same verdict. */
  level: AudioLevel
}

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
    // ORDER IS LOAD-BEARING (M-023): volumedetect is pass-through and prints at
    // EOF, so putting it FIRST measures the decoded input while loudnorm still
    // normalises what gets written. Reversed, the meter reports the
    // normaliser's opinion and nothing is ever quiet.
    '-af', 'volumedetect,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wavPath,
  ])
  if (!res.ok) return null

  const levels = parseVolumeDetect(res.stderr)
  return {
    track,
    wavPath,
    meanVolumeDb: levels.meanVolumeDb,
    maxVolumeDb: levels.maxVolumeDb,
    level: classifyLevel(levels),
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
