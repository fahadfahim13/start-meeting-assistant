import type { TranscriptRow } from '@main/db/repositories/transcripts'

/**
 * Transcript export generators (plan §8.3.4). Pure functions — path handling
 * and file writing stay in the IPC handler.
 */

export type TranscriptFormat = 'txt' | 'srt' | 'vtt' | 'json' | 'md'

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** SRT: HH:MM:SS,mmm · VTT: HH:MM:SS.mmm */
export function formatTimestamp(ms: number, sep: ',' | '.' = ','): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const frac = Math.floor(ms % 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(frac, 3)}`
}

function clockTime(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(m)}:${pad(s)}`
}

export function toTxt(rows: TranscriptRow[]): string {
  return rows.map((r) => `[${clockTime(r.start_ms)}] ${r.speaker_label ?? r.track}: ${r.text}`).join('\n') + '\n'
}

export function toSrt(rows: TranscriptRow[]): string {
  return (
    rows
      .map(
        (r, i) =>
          `${i + 1}\n${formatTimestamp(r.start_ms)} --> ${formatTimestamp(r.end_ms)}\n` +
          `${r.speaker_label ? `[${r.speaker_label}] ` : ''}${r.text}`,
      )
      .join('\n\n') + '\n'
  )
}

export function toVtt(rows: TranscriptRow[]): string {
  return (
    'WEBVTT\n\n' +
    rows
      .map(
        (r) =>
          `${formatTimestamp(r.start_ms, '.')} --> ${formatTimestamp(r.end_ms, '.')}\n` +
          `${r.speaker_label ? `<v ${r.speaker_label}>` : ''}${r.text}`,
      )
      .join('\n\n') +
    '\n'
  )
}

export function toJson(rows: TranscriptRow[]): string {
  return JSON.stringify(
    {
      version: 1,
      segments: rows.map((r) => ({
        startMs: r.start_ms,
        endMs: r.end_ms,
        speaker: r.speaker_label ?? null,
        track: r.track,
        text: r.text,
      })),
    },
    null,
    2,
  )
}

/** Markdown: speaker-grouped, readable — consecutive same-speaker turns merge. */
export function toMd(rows: TranscriptRow[], title: string): string {
  const lines: string[] = [`# ${title}`, '']
  let lastSpeaker: string | null = null
  for (const r of rows) {
    const speaker = r.speaker_label ?? r.track
    if (speaker !== lastSpeaker) {
      lines.push('', `**${speaker}** · ${clockTime(r.start_ms)}`, '')
      lastSpeaker = speaker
    }
    lines.push(r.text)
  }
  return lines.join('\n') + '\n'
}

export function renderTranscript(format: TranscriptFormat, rows: TranscriptRow[], title: string): string {
  switch (format) {
    case 'txt':
      return toTxt(rows)
    case 'srt':
      return toSrt(rows)
    case 'vtt':
      return toVtt(rows)
    case 'json':
      return toJson(rows)
    case 'md':
      return toMd(rows, title)
  }
}
