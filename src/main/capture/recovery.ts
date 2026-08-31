import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import * as meetings from '@main/db/repositories/meetings'
import { concatSegments, isPlayable, probeDurationS } from './media-tools'
import { log } from '@main/log'
import { relativizeMedia, resolveMedia } from '@main/platform/storage'

/**
 * Crash recovery (plan §10.2). Runs once at startup, before any new session:
 * any meeting the DB says is 'recording'/'paused'/'finalizing' was interrupted.
 * Its segment directory holds independently playable 5-minute segments — each
 * one that ffprobe can read is kept; the rest are noted and dropped. The valid
 * segments are concatenated into the final file and the meeting is marked
 * 'recovered' (honest state: something may be missing), or 'failed' when
 * nothing usable survived.
 */

export interface RecoveryReport {
  meetingId: string
  title: string
  outcome: 'recovered' | 'failed'
  segmentsFound: number
  segmentsPlayable: number
  durationS: number | null
}

export async function recoverInterrupted(): Promise<RecoveryReport[]> {
  const interrupted = meetings.findInterrupted()
  const reports: RecoveryReport[] = []

  for (const meeting of interrupted) {
    const segmentDir = resolveMedia(meeting)
    const report: RecoveryReport = {
      meetingId: meeting.id,
      title: meeting.title,
      outcome: 'failed',
      segmentsFound: 0,
      segmentsPlayable: 0,
      durationS: null,
    }

    try {
      if (!existsSync(segmentDir) || !statSync(segmentDir).isDirectory()) {
        // Directory already gone (or media_path already points at a file from a
        // crash inside finalize-cleanup) — check whether the final file exists.
        const finalCandidate = `${segmentDir}.mkv`
        if (existsSync(finalCandidate) && (await isPlayable(finalCandidate))) {
          const durationS = await probeDurationS(finalCandidate)
          meetings.finalizeMeeting(
            meeting.id,
            relativizeMedia(finalCandidate).relative,
            statSync(finalCandidate).size,
            Math.round((durationS ?? 0) * 1000),
          )
          meetings.setMeetingState(meeting.id, 'recovered')
          report.outcome = 'recovered'
          report.durationS = durationS
        } else {
          meetings.setMeetingState(meeting.id, 'failed')
        }
        reports.push(report)
        continue
      }

      const segFiles = readdirSync(segmentDir)
        .filter((f) => /^seg_\d+\.mkv$/.test(f))
        .sort()
        .map((f) => path.join(segmentDir, f))
      report.segmentsFound = segFiles.length

      const playable: string[] = []
      for (const f of segFiles) {
        if (await isPlayable(f)) playable.push(f)
        else log.warn('recovery', 'unplayable segment dropped', { segment: path.basename(f) })
      }
      report.segmentsPlayable = playable.length

      if (playable.length === 0) {
        meetings.setMeetingState(meeting.id, 'failed')
        reports.push(report)
        continue
      }

      const finalPath = `${segmentDir}.mkv`
      await concatSegments(playable, finalPath)
      const durationS = await probeDurationS(finalPath)
      if (durationS === null) throw new Error('recovered concat is not playable')

      meetings.finalizeMeeting(
        meeting.id,
        relativizeMedia(finalPath).relative,
        statSync(finalPath).size,
        Math.round(durationS * 1000),
      )
      meetings.setMeetingState(meeting.id, 'recovered')
      rmSync(segmentDir, { recursive: true, force: true })
      report.outcome = 'recovered'
      report.durationS = durationS
    } catch (e) {
      log.error('recovery', 'recovery failed for meeting', {
        meetingId: meeting.id,
        error: String(e).slice(0, 500),
      })
      try {
        meetings.setMeetingState(meeting.id, 'failed')
      } catch {
        /* keep going */
      }
    }
    reports.push(report)
  }

  if (reports.length) {
    log.info('recovery', 'interrupted meetings processed', {
      recovered: reports.filter((r) => r.outcome === 'recovered').length,
      total: reports.length,
    })
  }
  return reports
}
