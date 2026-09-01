import { execFile } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '@main/platform/binaries'
import { parseVolumeDetect, type TrackLevels } from '@shared/audio-levels'

/** Small ffmpeg/ffprobe helpers shared by the session and crash recovery. */

export function probeDurationS(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)
        const v = parseFloat(stdout.trim())
        resolve(Number.isFinite(v) && v > 0 ? v : null)
      },
    )
  })
}

/** How many audio streams a file carries. 0 on any probe failure. */
export function countAudioTracks(file: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(0)
        resolve(String(stdout).trim().split(/\r?\n/).filter((l) => l.trim().length > 0).length)
      },
    )
  })
}

/** A segment is usable if ffprobe can read a positive duration from it. */
export async function isPlayable(file: string): Promise<boolean> {
  return (await probeDurationS(file)) !== null
}

/**
 * Lossless concat (`-c copy`) of segment files into one MKV.
 * Segment paths are written to a list file; single quotes are escaped per the
 * concat demuxer's rules ('\'' sequence).
 */
export type OutputFormat = 'mkv' | 'mp4'

export function concatSegments(
  segmentPaths: string[],
  outputPath: string,
  format: OutputFormat = 'mkv',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const listPath = path.join(path.dirname(outputPath), `concat-${Date.now()}.txt`)
    const escape = (p: string): string => p.replace(/'/g, "'\\''")
    writeFileSync(listPath, segmentPaths.map((p) => `file '${escape(p)}'`).join('\n'))

    execFile(
      resolveBinary('ffmpeg'),
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        // -map 0 is NOT optional: default stream selection keeps only the
        // "best" video and audio stream, silently dropping the camera track
        // and the second audio track (M-011).
        '-map', '0',
        // MKV: a pure stream copy, so finalising is lossless and near-instant.
        //
        // MP4: the video is still copied — no re-encode, no quality change —
        // but the audio is converted to AAC. Opus inside MP4 is legal and
        // ffmpeg writes it happily, yet Windows Media Player, older players and
        // several editors will not play it. Choosing MP4 is a choice about
        // compatibility, so shipping a container half of them cannot open would
        // defeat the point. Measured cost: ~18% more bytes on a 33 s recording.
        ...(format === 'mp4'
          ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k']
          : ['-c', 'copy']),
        outputPath,
      ],
      { timeout: 300_000, windowsHide: true },
      (error, _stdout, stderr) => {
        try {
          rmSync(listPath, { force: true })
        } catch {
          /* best effort */
        }
        if (error) reject(new Error(`concat failed: ${String(stderr).slice(-500)}`))
        else resolve()
      },
    )
  })
}

/**
 * Measure each audio track of a finished recording (MISTAKES.md M-023).
 *
 * `-vn` is the cost control, not a detail: without it ffmpeg decodes the whole
 * video to reach the audio, turning a 1-hour meeting into a minutes-long stall
 * at the exact moment the user is waiting to see their recording appear.
 *
 * Never throws. A recording that cannot be measured is still a recording —
 * Principle 2 — so failure yields nulls, which classifyLevel() reads as 'ok'.
 */
export async function measureTrackLevels(
  file: string,
  trackCount: number,
): Promise<TrackLevels[]> {
  const measureOne = (index: number): Promise<TrackLevels> =>
    new Promise((resolve) => {
      execFile(
        resolveBinary('ffmpeg'),
        [
          '-hide_banner', '-nostats', '-vn',
          '-i', file,
          '-map', `0:a:${index}`,
          '-af', 'volumedetect',
          '-f', 'null', '-',
        ],
        { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          // volumedetect prints its summary to stderr at EOF even on success.
          if (error && !stderr) return resolve({ meanVolumeDb: null, maxVolumeDb: null })
          resolve(parseVolumeDetect(String(stderr)))
        },
      )
    })

  const out: TrackLevels[] = []
  for (let i = 0; i < trackCount; i++) out.push(await measureOne(i))
  return out
}

export function diskFreeBytes(dir: string): Promise<number> {
  return import('node:fs/promises').then(async (fs) => {
    const { bavail, bsize } = await fs.statfs(dir)
    return Number(bavail) * Number(bsize)
  })
}
