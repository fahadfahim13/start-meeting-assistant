import { randomUUID } from 'node:crypto'
import { getDb } from '../index'

/**
 * Meetings + segments repository. Parameterized statements only — no string
 * interpolation into SQL, ever.
 */

export type MeetingState = 'recording' | 'paused' | 'finalizing' | 'ready' | 'failed' | 'recovered'

export interface MeetingRow {
  id: string
  title: string
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  state: MeetingState
  media_path: string
  /** Which root media_path is relative to: 'userData' or 'custom'. */
  media_root: string
  media_bytes: number | null
  capture_profile: string
  has_screen: number
  has_camera: number
  has_mic: number
  has_system_audio: number
  /** Free-text notes the user typed themselves. */
  notes: string | null
}

export interface SegmentRow {
  id: string
  meeting_id: string
  seq: number
  path: string
  started_at: number
  duration_ms: number | null
  bytes: number | null
  finalized: number
}

export function createMeeting(input: {
  id: string
  title: string
  mediaPath: string
  /** Root mediaPath is relative to; new recordings follow the current setting. */
  mediaRoot: string
  captureProfile: object
  hasScreen: boolean
  hasCamera: boolean
  hasMic: boolean
  hasSystemAudio: boolean
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO meetings
        (id, title, started_at, state, media_path, media_root, capture_profile,
         has_screen, has_camera, has_mic, has_system_audio, created_at, updated_at)
       VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.title,
      now,
      input.mediaPath,
      input.mediaRoot,
      JSON.stringify(input.captureProfile),
      input.hasScreen ? 1 : 0,
      input.hasCamera ? 1 : 0,
      input.hasMic ? 1 : 0,
      input.hasSystemAudio ? 1 : 0,
      now,
      now,
    )
}

export function setMeetingState(id: string, state: MeetingState): void {
  getDb().prepare('UPDATE meetings SET state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), id)
}

export function finalizeMeeting(id: string, mediaPath: string, bytes: number, durationMs: number): void {
  const now = Date.now()
  getDb()
    .prepare(
      `UPDATE meetings SET state = 'ready', media_path = ?, media_bytes = ?,
         duration_ms = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(mediaPath, bytes, durationMs, now, now, id)
}

export function getMeeting(id: string): MeetingRow | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as unknown as MeetingRow | undefined
}

/** Meetings a crash left in a non-terminal state — the recovery scan input. */
export function findInterrupted(): MeetingRow[] {
  return getDb()
    .prepare(`SELECT * FROM meetings WHERE state IN ('recording', 'paused', 'finalizing')`)
    .all() as unknown as MeetingRow[]
}

export function addSegment(input: { meetingId: string; seq: number; path: string; startedAt: number }): string {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO segments (id, meeting_id, seq, path, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.meetingId, input.seq, input.path, input.startedAt)
  return id
}

export function finalizeSegment(id: string, bytes: number, durationMs: number | null): void {
  getDb()
    .prepare('UPDATE segments SET finalized = 1, bytes = ?, duration_ms = ? WHERE id = ?')
    .run(bytes, durationMs, id)
}

export function segmentsFor(meetingId: string): SegmentRow[] {
  return getDb()
    .prepare('SELECT * FROM segments WHERE meeting_id = ? ORDER BY seq')
    .all(meetingId) as unknown as SegmentRow[]
}

/**
 * The user's own notes on a meeting.
 *
 * The column has existed since the v1 schema and nothing ever read or wrote it
 * — a place to record what the transcript cannot, like why a decision was made
 * or what to do about it.
 */
export function setNotes(meetingId: string, notes: string): void {
  getDb()
    .prepare('UPDATE meetings SET notes = ?, updated_at = ? WHERE id = ?')
    .run(notes.slice(0, 20_000), Date.now(), meetingId)
}
