import { app } from 'electron'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { JobQueue, type QueueEvents } from './queue'
import { extractAudio, type ExtractedTrack } from './stages/extract-audio'
import { transcribeTrack } from './stages/transcribe'
import { alignTurns, diarizationAvailable, diarizeWav } from './stages/diarize'
import { detectCameraPresence, extractKeyframes } from './stages/keyframes'
import { ocrKeyframes } from './stages/ocr'
import { captionKeyframes, vlmAvailable } from './stages/vlm'
import { summarizeMeeting, summarizerAvailable } from './stages/summarize'
import { getSettings } from '@main/db/repositories/settings'
import { resolveInside } from '@main/security/paths'
import * as meetings from '@main/db/repositories/meetings'
import * as transcripts from '@main/db/repositories/transcripts'
import { modelAvailable } from '@main/platform/models'

/**
 * Pipeline wiring: stage registration and the per-meeting work directory.
 *
 * Phase 3 stages: extract → transcribe. The speaker identity story (ADR-007):
 * the mic track IS "You" (certainty from track separation, not inference);
 * the system track is "Others" until Phase 4 diarization splits it.
 */

export function workDirFor(meetingId: string): string {
  const dir = path.join(app.getPath('userData'), 'work', meetingId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function createPipeline(events: QueueEvents): JobQueue {
  const queue = new JobQueue(events)

  queue.registerStage('extract', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (!meeting.has_mic && !meeting.has_system_audio) return 'skipped'

    const mediaPath = resolveInside(app.getPath('userData'), meeting.media_path)
    if (!existsSync(mediaPath)) throw new Error(`media missing: ${meeting.media_path}`)

    ctx.setProgress(5)
    const tracks = await extractAudio({
      mediaPath,
      workDir: workDirFor(meeting.id),
      hasMic: meeting.has_mic === 1,
      hasSystem: meeting.has_system_audio === 1,
    })
    if (tracks.length === 0) throw new Error('audio extraction produced no tracks')
    ctx.setCheckpoint({ tracks })
    return 'done'
  })

  queue.registerStage('transcribe', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    // Same condition extract skips on — an audio-less meeting has nothing to
    // transcribe (found by the synthetic video harness: extract skipped,
    // transcribe then failed on the missing checkpoint).
    if (!meeting.has_mic && !meeting.has_system_audio) return 'skipped'
    if (!modelAvailable('whisper-large-v3-turbo-q5')) {
      throw new Error('whisper model not downloaded')
    }

    // The extract stage's checkpoint carries the track list + silence flags.
    const extractJob = queue.jobsFor(meeting.id).find((j) => j.stage === 'extract')
    const cp = extractJob?.checkpoint ? (JSON.parse(extractJob.checkpoint) as { tracks: ExtractedTrack[] }) : null
    if (!cp || cp.tracks.length === 0) throw new Error('extract checkpoint missing — run extract first')

    // Own checkpoint: which tracks are already transcribed (resume support).
    const done = new Set<string>(
      ctx.job.checkpoint ? (JSON.parse(ctx.job.checkpoint) as { done: string[] }).done : [],
    )

    const toDo = cp.tracks.filter((t) => !done.has(t.track))
    let idx = 0
    for (const track of toDo) {
      if (track.isSilent) {
        // Digital silence — record the skip honestly rather than transcribing it.
        console.log(`[pipeline] ${track.track} track is silent (${track.meanVolumeDb} dB) — skipped`)
      } else {
        const base = idx
        const result = await transcribeTrack({
          wavPath: track.wavPath,
          language: getSettings().language, // ADR-004 default 'en'; user-set in Settings
          threads: queue.threads,
          onProgress: (pct) => ctx.setProgress(Math.round(((base + pct / 100) / toDo.length) * 100)),
        })
        const speakerId =
          track.track === 'mic'
            ? transcripts.ensureSpeaker(meeting.id, 'mic', 'You', true)
            : transcripts.ensureSpeaker(meeting.id, 'system', 'Others', false)
        // Persist FIRST, checkpoint after (plan §10.3 ordering).
        transcripts.replaceTrackSegments(meeting.id, track.track, speakerId, result.language, result.segments)
      }
      done.add(track.track)
      ctx.setCheckpoint({ done: [...done] })
      idx++
    }

    // Work dir stays: the diarize stage still needs system.wav. Cleanup is its job.
    return 'done'
  })

  queue.registerStage('diarize', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    const cleanup = (): void => rmSync(workDirFor(meeting.id), { recursive: true, force: true })

    try {
      // Degradation (Principle 3): no system audio, no models, or a silent
      // system track -> the You/Others split from track separation stands.
      if (meeting.has_system_audio !== 1) return 'skipped'
      if (!diarizationAvailable()) {
        console.warn('[pipeline] diarization models missing - keeping track-based split')
        return 'skipped'
      }
      const extractJob = queue.jobsFor(meeting.id).find((j) => j.stage === 'extract')
      const cp = extractJob?.checkpoint ? (JSON.parse(extractJob.checkpoint) as { tracks: ExtractedTrack[] }) : null
      const systemTrack = cp?.tracks.find((t) => t.track === 'system')
      if (!systemTrack || systemTrack.isSilent) return 'skipped'
      if (!existsSync(systemTrack.wavPath)) {
        console.warn('[pipeline] system.wav gone - diarization skipped (re-run processing to redo)')
        return 'skipped'
      }

      ctx.setProgress(10)
      const turns = diarizeWav(systemTrack.wavPath)
      ctx.setProgress(80)

      const systemSegs = transcripts
        .transcriptFor(meeting.id)
        .filter((r) => r.track === 'system')
        .map((r) => ({ startMs: r.start_ms, endMs: r.end_ms }))
      const assignments = alignTurns(systemSegs, turns)
      const updated = transcripts.applyDiarization(meeting.id, assignments)
      const speakers = new Set(assignments.filter((a) => a !== null))
      console.log(`[pipeline] diarization: ${speakers.size} remote speaker(s), ${updated}/${systemSegs.length} segments attributed`)
      return 'done'
    } finally {
      cleanup()
    }
  })

  queue.registerStage('keyframes', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1 && meeting.has_camera !== 1) return 'skipped'

    const mediaPath = resolveInside(app.getPath('userData'), meeting.media_path)
    if (!existsSync(mediaPath)) throw new Error(`media missing: ${meeting.media_path}`)
    const workDir = workDirFor(`${meeting.id}-frames`)

    try {
      if (meeting.has_screen === 1) {
        const outcome = await extractKeyframes({
          meetingId: meeting.id,
          mediaPath,
          workDir,
          sensitivity: getSettings().keyframeSensitivity,
          onProgress: (pct) => ctx.setProgress(Math.round(pct * 0.9)),
        })
        console.log(
          `[pipeline] keyframes: ${outcome.written} written from ${outcome.selection.totalFrames}s` +
            (outcome.selection.capped ? ' (CAP BOUND - coverage truncated)' : ''),
        )
        ctx.setCheckpoint({ capped: outcome.selection.capped, written: outcome.written })
      }
      if (meeting.has_camera === 1 && meeting.has_screen === 1) {
        // Camera is v:1 only when a screen track occupies v:0.
        const spans = await detectCameraPresence({ meetingId: meeting.id, mediaPath, workDir })
        console.log(`[pipeline] camera presence: ${spans} span(s)`)
      }
      return 'done'
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  queue.registerStage('ocr', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1) return 'skipped'
    const outcome = await ocrKeyframes({ meetingId: meeting.id, onProgress: ctx.setProgress })
    console.log(`[pipeline] ocr: ${outcome.withText}/${outcome.processed} keyframes carry text`)
    return 'done'
  })

  queue.registerStage('vlm', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1) return 'skipped'
    if (!vlmAvailable()) {
      // Degradation: OCR + keyframes still carry the visual story.
      console.warn('[pipeline] VLM models missing - captions skipped')
      return 'skipped'
    }
    const outcome = await captionKeyframes({ meetingId: meeting.id, onProgress: ctx.setProgress })
    console.log(`[pipeline] vlm: ${outcome.captioned}/${outcome.processed} captioned`)
    return 'done'
  })

  queue.registerStage('summarize', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (!summarizerAvailable()) {
      console.warn('[pipeline] summarizer model missing - skipped')
      return 'skipped'
    }
    const hasTranscript = transcripts.transcriptFor(meeting.id).length > 0
    if (!hasTranscript) return 'skipped' // silent/audio-less meetings have nothing to say
    const { degraded } = await summarizeMeeting({ meetingId: meeting.id, onProgress: ctx.setProgress })
    if (degraded) console.warn('[pipeline] summary DEGRADED - prose fallback stored')
    return 'done'
  })

  return queue
}

export const PROCESSING_STAGES = ['extract', 'transcribe', 'diarize', 'keyframes', 'ocr', 'vlm', 'summarize']
