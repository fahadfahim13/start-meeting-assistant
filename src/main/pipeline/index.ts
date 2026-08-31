import { app } from 'electron'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { JobQueue, type QueueEvents } from './queue'
import { extractAudio, type ExtractedTrack } from './stages/extract-audio'
import { transcribeTrack } from './stages/transcribe'
import { alignTurns, diarizationAvailable, diarizeWav } from './stages/diarize'
import { detectCameraPresence, extractKeyframes } from './stages/keyframes'
import { ocrKeyframes } from './stages/ocr'
import { captionKeyframes, vlmAvailable } from './stages/vlm'
import { summarizeMeeting, summarizerAvailable } from './stages/summarize'
import { generateQaReport, persistQaReport, qaAvailable, type ChunkNotesLike } from './stages/qa'
import { getSettings } from '@main/db/repositories/settings'
import * as meetings from '@main/db/repositories/meetings'
import * as transcripts from '@main/db/repositories/transcripts'
import { modelAvailable } from '@main/platform/models'
import { log } from '@main/log'
import { resolveMedia } from '@main/platform/storage'
import { getDb } from '@main/db'
import { renderQa, renderTranscript, summaryToMd, type SummaryExport } from './export'

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

/**
 * Write the human-readable artefacts next to the .mkv.
 *
 * The point is that the recordings folder is useful WITHOUT the app: an .srt
 * sits beside the video so any player picks it up, the .md reads like notes,
 * and the .json is there for whatever comes next (Principle 6, open by
 * default). Returns how many files were written.
 *
 * Logs counts only — never a filename, because the filename embeds the
 * user-supplied meeting title.
 */
function writeSidecars(meeting: meetings.MeetingRow): number {
  const mediaPath = resolveMedia(meeting)
  const base = mediaPath.replace(/\.mkv$/i, '')
  const rows = transcripts.transcriptFor(meeting.id)
  let written = 0

  const put = (suffix: string, content: string): void => {
    if (!content.trim()) return
    writeFileSync(`${base}${suffix}`, content, 'utf8')
    written++
  }

  if (rows.length > 0) {
    put('.md', renderTranscript('md', rows, meeting.title))
    put('.srt', renderTranscript('srt', rows, meeting.title))
    put('.json', renderTranscript('json', rows, meeting.title))
  }

  const db = getDb()
  const summaryRow = db
    .prepare('SELECT content FROM summaries WHERE meeting_id = ? AND is_current = 1')
    .get(meeting.id) as unknown as { content: string } | undefined
  if (summaryRow) {
    try {
      const summary = JSON.parse(summaryRow.content) as SummaryExport
      const actionItems = (
        db
          .prepare('SELECT text, assignee, source_ms FROM action_items WHERE meeting_id = ?')
          .all(meeting.id) as unknown as { text: string; assignee: string | null; source_ms: number | null }[]
      ).map((a) => ({ text: a.text, assignee: a.assignee, t: a.source_ms }))
      put('.summary.md', summaryToMd(summary, meeting.title, actionItems))
    } catch {
      /* an unparseable summary simply gets no sidecar */
    }
  }

  const qaRow = db
    .prepare('SELECT content FROM qa_reports WHERE meeting_id = ? AND is_current = 1')
    .get(meeting.id) as unknown as { content: string } | undefined
  if (qaRow) {
    try {
      const parsed = JSON.parse(qaRow.content) as {
        pairs?: { q: string; a: string; t: number | null }[]
        degraded?: boolean
      }
      put('.qa.md', renderQa('md', parsed.pairs ?? [], meeting.title, parsed.degraded ?? false))
    } catch {
      /* likewise */
    }
  }

  return written
}

export function createPipeline(events: QueueEvents): JobQueue {
  const queue = new JobQueue(events)

  queue.registerStage('extract', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (!meeting.has_mic && !meeting.has_system_audio) {
      return { state: 'skipped', code: 'PIPELINE_NO_AUDIO' }
    }

    // resolveMedia contains the path within whichever root this meeting was
    // recorded under (userData, or the folder the user chose).
    const mediaPath = resolveMedia(meeting)
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

    // Levels only — never the audio, never any text.
    log.info('pipeline', 'audio extracted', {
      meetingId: meeting.id,
      tracks: tracks.map((t) => ({ track: t.track, level: t.level, meanDb: t.meanVolumeDb })),
    })

    if (tracks.every((t) => t.level === 'digital-silence')) {
      return {
        state: 'skipped',
        code: 'PIPELINE_AUDIO_SILENT',
        detail: tracks.map((t) => `${t.track}: ${t.meanVolumeDb ?? '?'} dB`).join(', '),
      }
    }
    return 'done'
  })

  queue.registerStage('transcribe', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    // Same condition extract skips on — an audio-less meeting has nothing to
    // transcribe (found by the synthetic video harness: extract skipped,
    // transcribe then failed on the missing checkpoint).
    if (!meeting.has_mic && !meeting.has_system_audio) {
      return { state: 'skipped', code: 'PIPELINE_NO_AUDIO' }
    }
    // A missing model is a SKIP, not a failure. diarize and vlm already treat
    // the identical condition that way; transcribe used to throw and burn three
    // retries with exponential backoff before landing on 'failed'.
    if (!modelAvailable('whisper-large-v3-turbo-q5')) {
      return { state: 'skipped', code: 'PIPELINE_MODEL_MISSING', detail: 'whisper-large-v3-turbo-q5' }
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
    // The work dir is deleted once processing finishes, so a re-run reaching
    // this point with no WAVs must say so instead of failing cryptically.
    const missing = toDo.filter((t) => !existsSync(t.wavPath))
    if (toDo.length > 0 && missing.length === toDo.length) {
      return {
        state: 'skipped',
        code: 'PIPELINE_WORKDIR_MISSING',
        detail: 'intermediate audio was cleaned up',
      }
    }

    const results: { track: string; level: string; segments: number }[] = []
    let idx = 0
    for (const track of toDo) {
      if (track.level === 'digital-silence' || !existsSync(track.wavPath)) {
        results.push({ track: track.track, level: track.level, segments: 0 })
      } else {
        const base = idx
        const result = await transcribeTrack({
          wavPath: track.wavPath,
          language: getSettings().language, // ADR-004 default 'en'; user-set in Settings
          threads: queue.threads,
          onProgress: (pct) => ctx.setProgress(Math.round(((base + pct / 100) / toDo.length) * 100)),
        })
        // NEVER replace with an empty set. replaceTrackSegments deletes the
        // track's existing rows before inserting, so a re-run that recognises
        // nothing used to DESTROY a previously good transcript (M-024).
        if (result.segments.length > 0) {
          const speakerId =
            track.track === 'mic'
              ? transcripts.ensureSpeaker(meeting.id, 'mic', 'You', true)
              : transcripts.ensureSpeaker(meeting.id, 'system', 'Others', false)
          // Persist FIRST, checkpoint after (plan §10.3 ordering).
          transcripts.replaceTrackSegments(meeting.id, track.track, speakerId, result.language, result.segments)
        }
        results.push({ track: track.track, level: track.level, segments: result.segments.length })
      }
      done.add(track.track)
      ctx.setCheckpoint({ done: [...done], results })
      idx++
    }

    // Whisper exiting 0 having recognised nothing is not success. This is the
    // exact path that reported `done`, wrote no rows, and left the user with an
    // empty Library and no error anywhere (M-024).
    const heard = results.reduce((n, r) => n + r.segments, 0)
    if (heard === 0 && transcripts.transcriptFor(meeting.id).length === 0) {
      const detail = results.map((r) => `${r.track}: ${r.level}`).join(', ')
      log.warn('pipeline', 'transcription recognised no speech', { meetingId: meeting.id, results })
      // "Nothing was recorded" and "something was recorded but it wasn't
      // speech" send the user to two different fixes, so distinguish them.
      const allSilent = results.length > 0 && results.every((r) => r.level === 'digital-silence')
      return {
        state: 'skipped',
        code: allSilent ? 'PIPELINE_AUDIO_SILENT' : 'PIPELINE_NO_SPEECH',
        detail,
      }
    }

    // Work dir stays until the terminal 'publish' stage — diarize still needs
    // system.wav, and so does a re-run.
    return 'done'
  })

  queue.registerStage('diarize', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    // NOTE: this stage used to delete the whole work dir in an unconditional
    // `finally`, including on every skip path — so mic.wav/system.wav vanished
    // even when nothing had been done with them and a re-run had nothing to
    // work from. Cleanup now belongs to the terminal 'publish' stage (M-025).

    // Degradation (Principle 3): no system audio, no models, or a silent
    // system track -> the You/Others split from track separation stands.
    if (meeting.has_system_audio !== 1) {
      return { state: 'skipped', code: 'PIPELINE_NO_AUDIO', detail: 'no system-audio track to diarize' }
    }
    if (!diarizationAvailable()) {
      return { state: 'skipped', code: 'PIPELINE_MODEL_MISSING', detail: 'diarization models' }
    }
    const extractJob = queue.jobsFor(meeting.id).find((j) => j.stage === 'extract')
    const cp = extractJob?.checkpoint ? (JSON.parse(extractJob.checkpoint) as { tracks: ExtractedTrack[] }) : null
    const systemTrack = cp?.tracks.find((t) => t.track === 'system')
    if (!systemTrack) {
      return { state: 'skipped', code: 'PIPELINE_NO_AUDIO', detail: 'system track was not extracted' }
    }
    if (systemTrack.level === 'digital-silence') {
      return { state: 'skipped', code: 'PIPELINE_AUDIO_SILENT', detail: 'system track is silent' }
    }
    if (!existsSync(systemTrack.wavPath)) {
      return { state: 'skipped', code: 'PIPELINE_WORKDIR_MISSING', detail: 'system.wav was cleaned up' }
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
    log.info('pipeline', 'diarization complete', {
      meetingId: meeting.id,
      speakers: speakers.size,
      attributed: updated,
      segments: systemSegs.length,
    })
    return 'done'
  })

  queue.registerStage('keyframes', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1 && meeting.has_camera !== 1) {
      return { state: 'skipped', code: 'PIPELINE_NO_VIDEO' }
    }

    const mediaPath = resolveMedia(meeting)
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
        log.info('pipeline', 'keyframes selected', {
          meetingId: meeting.id,
          written: outcome.written,
          fromSeconds: outcome.selection.totalFrames,
          capped: outcome.selection.capped,
        })
        ctx.setCheckpoint({ capped: outcome.selection.capped, written: outcome.written })
      }
      if (meeting.has_camera === 1 && meeting.has_screen === 1) {
        // Camera is v:1 only when a screen track occupies v:0.
        const spans = await detectCameraPresence({ meetingId: meeting.id, mediaPath, workDir })
        log.info('pipeline', 'camera presence detected', { meetingId: meeting.id, spans })
      }
      return 'done'
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  queue.registerStage('ocr', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1) return { state: 'skipped', code: 'PIPELINE_NO_VIDEO' }
    const outcome = await ocrKeyframes({ meetingId: meeting.id, onProgress: ctx.setProgress })
    log.info('pipeline', 'ocr complete', {
      meetingId: meeting.id,
      withText: outcome.withText,
      processed: outcome.processed,
    })
    return 'done'
  })

  queue.registerStage('vlm', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (meeting.has_screen !== 1) return { state: 'skipped', code: 'PIPELINE_NO_VIDEO' }
    if (!vlmAvailable()) {
      // Degradation: OCR + keyframes still carry the visual story.
      return { state: 'skipped', code: 'PIPELINE_MODEL_MISSING', detail: 'SmolVLM2' }
    }
    const outcome = await captionKeyframes({ meetingId: meeting.id, onProgress: ctx.setProgress })
    log.info('pipeline', 'vlm captions complete', {
      meetingId: meeting.id,
      captioned: outcome.captioned,
      processed: outcome.processed,
    })
    return 'done'
  })

  queue.registerStage('summarize', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (!summarizerAvailable()) {
      return { state: 'skipped', code: 'PIPELINE_MODEL_MISSING', detail: 'qwen3-4b' }
    }
    const hasTranscript = transcripts.transcriptFor(meeting.id).length > 0
    if (!hasTranscript) {
      // This is the skip the user actually experienced as "No summary yet",
      // forever, on a pipeline that had finished.
      return { state: 'skipped', code: 'PIPELINE_NO_TRANSCRIPT' }
    }
    const { degraded, notes } = await summarizeMeeting({
      meetingId: meeting.id,
      onProgress: ctx.setProgress,
    })
    if (degraded) log.warn('pipeline', 'summary degraded - prose fallback stored', { meetingId: meeting.id })
    // Persist the map notes for the on-demand Q&A stage (ADR-015). Written
    // AFTER the summary is durably stored, per the checkpoint ordering rule.
    ctx.setCheckpoint({ notes })
    return 'done'
  })

  /**
   * Q&A report — registered but deliberately NOT in PROCESSING_STAGES.
   *
   * The user asked for a button, not another automatic step: on a 15 W laptop a
   * report nobody opened is minutes of inference for nothing. `qa:regenerate`
   * enqueues this stage alone.
   *
   * It reads summarize's checkpoint rather than the transcript, so it costs one
   * llama call. When that checkpoint is gone (an older meeting, or a re-run that
   * cleared it) generateQaReport falls back to the stored summary.
   */
  queue.registerStage('qa', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')
    if (!qaAvailable()) {
      return { state: 'skipped', code: 'PIPELINE_MODEL_MISSING', detail: 'qwen3-4b' }
    }
    if (transcripts.transcriptFor(meeting.id).length === 0) {
      return { state: 'skipped', code: 'PIPELINE_NO_TRANSCRIPT' }
    }

    const summarizeJob = queue.jobsFor(meeting.id).find((j) => j.stage === 'summarize')
    let notes: ChunkNotesLike[] | null = null
    if (summarizeJob?.checkpoint) {
      try {
        notes = (JSON.parse(summarizeJob.checkpoint) as { notes?: ChunkNotesLike[] }).notes ?? null
      } catch {
        notes = null
      }
    }

    const { pairs, degraded } = await generateQaReport({
      meetingId: meeting.id,
      notes,
      onProgress: ctx.setProgress,
    })
    persistQaReport(meeting.id, pairs, degraded)
    log.info('pipeline', 'qa report generated', {
      meetingId: meeting.id,
      pairs: pairs.length,
      degraded,
      fromNotes: notes !== null,
    })
    return 'done'
  })

  /**
   * Terminal stage: the only place intermediate audio is deleted (M-025).
   *
   * Cleanup used to live in diarize's unconditional `finally`, which ran on
   * every skip path too - so a meeting whose diarize skipped for any reason
   * lost mic.wav and system.wav before anything else could use them, and
   * re-processing had nothing to work from. A stage that always runs last,
   * whatever happened upstream, is the honest home for teardown.
   *
   * It also writes the sidecar files, which is why it must run after summarize
   * and (when asked for) qa: those artefacts have to be committed first.
   */
  queue.registerStage('publish', async (ctx) => {
    const meeting = meetings.getMeeting(ctx.job.meeting_id)
    if (!meeting) throw new Error('meeting not found')

    let sidecars = 0
    if (getSettings().writeSidecarFiles) {
      try {
        sidecars = writeSidecars(meeting)
      } catch (e) {
        // A sidecar is a convenience. Failing to write one must never fail the
        // meeting, whose recording and database rows are already safe.
        log.warn('publish', 'sidecar files could not be written', {
          meetingId: meeting.id,
          error: String(e).slice(0, 200),
        })
      }
    }

    rmSync(workDirFor(meeting.id), { recursive: true, force: true })
    rmSync(workDirFor(meeting.id + '-frames'), { recursive: true, force: true })
    log.info('publish', 'meeting published', { meetingId: meeting.id, sidecars })
    return 'done'
  })

  return queue
}

// 'publish' is terminal by construction: the queue picks pending jobs in
// insertion order, so whatever is appended last runs last.
export const PROCESSING_STAGES = [
  'extract',
  'transcribe',
  'diarize',
  'keyframes',
  'ocr',
  'vlm',
  'summarize',
  'publish',
]
