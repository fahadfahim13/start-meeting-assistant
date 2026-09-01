import { randomUUID } from 'node:crypto'
import { getDb } from '../index'

/**
 * Moments flagged BY THE USER while recording.
 *
 * The value is that they are written at the point of interest — when the person
 * in the meeting knows something matters — rather than reconstructed afterwards
 * from an hour of transcript. They seed the summary and give the player
 * something to jump to.
 */

export interface MarkerRow {
  id: string
  meeting_id: string
  at_ms: number
  label: string | null
  created_at: number
}

export function addMarker(meetingId: string, atMs: number, label: string | null): MarkerRow {
  const row: MarkerRow = {
    id: randomUUID(),
    meeting_id: meetingId,
    at_ms: Math.max(0, Math.round(atMs)),
    label: label && label.trim() ? label.trim().slice(0, 200) : null,
    created_at: Date.now(),
  }
  getDb()
    .prepare('INSERT INTO markers (id, meeting_id, at_ms, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, row.meeting_id, row.at_ms, row.label, row.created_at)
  return row
}

export function markersFor(meetingId: string): MarkerRow[] {
  return getDb()
    .prepare('SELECT * FROM markers WHERE meeting_id = ? ORDER BY at_ms')
    .all(meetingId) as unknown as MarkerRow[]
}

export function deleteMarker(markerId: string): void {
  getDb().prepare('DELETE FROM markers WHERE id = ?').run(markerId)
}
