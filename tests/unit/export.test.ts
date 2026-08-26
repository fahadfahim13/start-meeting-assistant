import { describe, expect, it } from 'vitest'
import { formatTimestamp, renderTranscript, toMd, toSrt, toVtt } from '../../src/main/pipeline/export'
import type { TranscriptRow } from '../../src/main/db/repositories/transcripts'

const rows: TranscriptRow[] = [
  { id: '1', meeting_id: 'm', speaker_id: 's1', track: 'mic', start_ms: 0, end_ms: 2500, text: 'Hello everyone.', speaker_label: 'You' },
  { id: '2', meeting_id: 'm', speaker_id: 's2', track: 'system', start_ms: 3000, end_ms: 7250, text: 'Hi, thanks for joining.', speaker_label: 'Others' },
  { id: '3', meeting_id: 'm', speaker_id: 's1', track: 'mic', start_ms: 3_661_500, end_ms: 3_665_000, text: 'Wrapping up.', speaker_label: 'You' },
]

describe('formatTimestamp', () => {
  it('renders SRT commas and VTT dots', () => {
    expect(formatTimestamp(3_661_500, ',')).toBe('01:01:01,500')
    expect(formatTimestamp(3_661_500, '.')).toBe('01:01:01.500')
    expect(formatTimestamp(0)).toBe('00:00:00,000')
  })
})

describe('srt', () => {
  it('numbers cues and carries speakers', () => {
    const srt = toSrt(rows)
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\n[You] Hello everyone.')
    expect(srt).toContain('2\n00:00:03,000 --> 00:00:07,250\n[Others] Hi, thanks for joining.')
  })
})

describe('vtt', () => {
  it('starts with the WEBVTT header and uses voice tags', () => {
    const vtt = toVtt(rows)
    expect(vtt.startsWith('WEBVTT\n')).toBe(true)
    expect(vtt).toContain('00:00:03.000 --> 00:00:07.250\n<v Others>Hi, thanks for joining.')
  })
})

describe('md', () => {
  it('merges consecutive same-speaker turns under one heading', () => {
    const md = toMd(
      [rows[0]!, { ...rows[0]!, id: '1b', start_ms: 2600, end_ms: 2900, text: 'Quick note.' }, rows[1]!],
      'Weekly sync',
    )
    expect(md).toContain('# Weekly sync')
    // One "You" heading for two consecutive turns, then Others.
    expect(md.match(/\*\*You\*\*/g)).toHaveLength(1)
    expect(md.indexOf('Quick note.')).toBeGreaterThan(md.indexOf('Hello everyone.'))
    expect(md).toContain('**Others**')
  })
})

describe('renderTranscript', () => {
  it('json round-trips with tracks and speakers intact', () => {
    const parsed = JSON.parse(renderTranscript('json', rows, 't')) as {
      segments: { track: string; speaker: string | null; text: string }[]
    }
    expect(parsed.segments).toHaveLength(3)
    expect(parsed.segments[0]).toMatchObject({ track: 'mic', speaker: 'You', text: 'Hello everyone.' })
  })

  it('txt includes clock times', () => {
    expect(renderTranscript('txt', rows, 't')).toContain('[61:01] You: Wrapping up.')
  })
})
