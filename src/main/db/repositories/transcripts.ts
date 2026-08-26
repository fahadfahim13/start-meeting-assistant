import { randomUUID } from 'node:crypto'
import { getDb } from '../index'

/** Transcript persistence: speakers, segments, FTS index. Parameterized only. */

export interface TranscriptRow {
  id: string
  meeting_id: string
  speaker_id: string | null
  track: 'mic' | 'system'
  start_ms: number
  end_ms: number
  text: string
  speaker_label?: string | null
}

export function ensureSpeaker(meetingId: string, source: 'mic' | 'system', label: string, isCertain: boolean): string {
  const db = getDb()
  const existing = db
    .prepare('SELECT id FROM speakers WHERE meeting_id = ? AND source = ? AND label = ?')
    .get(meetingId, source, label) as unknown as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  db.prepare('INSERT INTO speakers (id, meeting_id, label, source, is_certain) VALUES (?, ?, ?, ?, ?)').run(
    id, meetingId, label, source, isCertain ? 1 : 0,
  )
  return id
}

export function replaceTrackSegments(
  meetingId: string,
  track: 'mic' | 'system',
  speakerId: string,
  language: string,
  segments: { startMs: number; endMs: number; text: string }[],
): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    // Re-transcription replaces the whole track cleanly.
    const old = db
      .prepare('SELECT id FROM transcript_segments WHERE meeting_id = ? AND track = ?')
      .all(meetingId, track) as unknown as { id: string }[]
    for (const o of old) {
      db.prepare('DELETE FROM transcript_fts WHERE segment_id = ?').run(o.id)
    }
    db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ? AND track = ?').run(meetingId, track)

    const insertSeg = db.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, speaker_id, track, start_ms, end_ms, text, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertFts = db.prepare(
      'INSERT INTO transcript_fts (text, meeting_id, segment_id) VALUES (?, ?, ?)',
    )
    for (const s of segments) {
      const id = randomUUID()
      insertSeg.run(id, meetingId, speakerId, track, s.startMs, s.endMs, s.text, language)
      insertFts.run(s.text, meetingId, id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Merged timeline: both tracks interleaved by start time, speaker labels joined. */
export function transcriptFor(meetingId: string): TranscriptRow[] {
  return getDb()
    .prepare(
      `SELECT ts.*, COALESCE(sp.display_name, sp.label) AS speaker_label
       FROM transcript_segments ts
       LEFT JOIN speakers sp ON sp.id = ts.speaker_id
       WHERE ts.meeting_id = ?
       ORDER BY ts.start_ms`,
    )
    .all(meetingId) as unknown as TranscriptRow[]
}

export interface SearchHit {
  meeting_id: string
  segment_id: string
  text: string
  start_ms: number
}

export function searchTranscripts(query: string, limit = 50): SearchHit[] {
  // FTS5 MATCH accepts its own query syntax; the string is bound as a
  // parameter — the user's text never reaches SQL itself. Quotes make any
  // input a phrase query rather than syntax.
  const phrase = `"${query.replace(/"/g, '""')}"`
  return getDb()
    .prepare(
      `SELECT f.meeting_id, f.segment_id, ts.text, ts.start_ms
       FROM transcript_fts f
       JOIN transcript_segments ts ON ts.id = f.segment_id
       WHERE transcript_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(phrase, limit) as unknown as SearchHit[]
}
