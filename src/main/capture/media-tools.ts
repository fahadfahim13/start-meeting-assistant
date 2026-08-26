import { execFile } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '@main/platform/binaries'

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

/** A segment is usable if ffprobe can read a positive duration from it. */
export async function isPlayable(file: string): Promise<boolean> {
  return (await probeDurationS(file)) !== null
}

/**
 * Lossless concat (`-c copy`) of segment files into one MKV.
 * Segment paths are written to a list file; single quotes are escaped per the
 * concat demuxer's rules ('\'' sequence).
 */
export function concatSegments(segmentPaths: string[], outputPath: string): Promise<void> {
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
        '-c', 'copy',
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

export function diskFreeBytes(dir: string): Promise<number> {
  return import('node:fs/promises').then(async (fs) => {
    const { bavail, bsize } = await fs.statfs(dir)
    return Number(bavail) * Number(bsize)
  })
}
