import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, type InvokeChannel } from '../../src/shared/ipc'

/**
 * IPC boundary battery (plan §13, SECURITY.md §5.3). Generated from the
 * channel REGISTRY — a new channel is covered automatically and cannot be
 * added without passing this battery.
 *
 * The renderer is untrusted after a compromise (T3): every request schema
 * must reject malformed shapes, oversized payloads, and — critically — the
 * id fields that main resolves into filesystem paths must reject anything
 * that is not exactly a UUID (T4: no traversal by id).
 */

const channels = Object.keys(INVOKE_CHANNELS) as InvokeChannel[]

const HOSTILE_IDS = [
  '../../../etc/passwd',
  '..\\..\\windows\\system32\\config\\sam',
  'C:\\Windows\\system32',
  '\\\\attacker\\share\\x',
  'file:stream:$DATA',
  '00000000-0000-0000-0000-00000000000Z', //近-uuid
  "'; DROP TABLE meetings; --",
  '${process.env.PATH}',
  'a'.repeat(10_000),
]

describe('IPC request schemas — hostile input battery', () => {
  for (const channel of channels) {
    const schema = INVOKE_CHANNELS[channel].request

    it(`${channel}: rejects non-object payloads`, () => {
      for (const bad of [null, 42, 'string', [], true]) {
        expect(schema.safeParse(bad).success, `payload ${JSON.stringify(bad)}`).toBe(false)
      }
    })

    it(`${channel}: rejects unknown-shaped garbage without throwing`, () => {
      // Must REJECT or accept-with-strip — never throw uncontrolled.
      expect(() => schema.safeParse({ __proto__: { evil: 1 }, constructor: 'x' })).not.toThrow()
      expect(() => schema.safeParse({ a: { b: { c: [1, 2, 3] } } })).not.toThrow()
    })
  }

  // Every field named like an id that main resolves into a path lookup.
  const ID_CHANNELS: [InvokeChannel, string][] = [
    ['meetings:process', 'meetingId'],
    ['meetings:delete', 'meetingId'],
    ['meetings:setTags', 'meetingId'],
    ['transcript:get', 'meetingId'],
    ['transcript:export', 'meetingId'],
    ['keyframes:get', 'meetingId'],
    ['summary:get', 'meetingId'],
    ['summary:regenerate', 'meetingId'],
    ['qa:get', 'meetingId'],
    ['qa:regenerate', 'meetingId'],
    ['qa:export', 'meetingId'],
    ['summary:export', 'meetingId'],
    ['meetings:setNotes', 'meetingId'],
    ['meetings:getNotes', 'meetingId'],
    ['markers:get', 'meetingId'],
    ['markers:delete', 'markerId'],
    ['transcript:edit', 'segmentId'],
    ['jobs:retry', 'jobId'],
    ['speakers:rename', 'speakerId'],
    ['actionitem:toggle', 'actionItemId'],
  ]

  for (const [channel, field] of ID_CHANNELS) {
    it(`${channel}: ${field} rejects every traversal/injection string`, () => {
      const schema = INVOKE_CHANNELS[channel].request
      for (const hostile of HOSTILE_IDS) {
        const payload: Record<string, unknown> = {
          [field]: hostile,
          // satisfy sibling required fields with plausible values
          format: 'txt',
          displayName: 'x',
          done: true,
          tags: [],
        }
        expect(schema.safeParse(payload).success, `${field}=${hostile.slice(0, 40)}`).toBe(false)
      }
    })
  }

  it('free-text fields are length-bounded (no unbounded payloads)', () => {
    const big = 'x'.repeat(1_000_000)
    expect(INVOKE_CHANNELS['transcript:search'].request.safeParse({ query: big }).success).toBe(false)
    expect(INVOKE_CHANNELS['speakers:rename'].request.safeParse({ speakerId: crypto.randomUUID(), displayName: big }).success).toBe(false)
    expect(
      INVOKE_CHANNELS['meetings:setTags'].request.safeParse({
        meetingId: crypto.randomUUID(),
        tags: Array.from({ length: 100 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false)
  })

  it('session:start rejects device names beyond the length bound', () => {
    const schema = INVOKE_CHANNELS['session:start'].request
    const base = {
      title: 't',
      preset: 'balanced',
      screen: null,
      camera: { dshowName: 'x'.repeat(300) }, // > 256
      microphone: null,
      systemAudio: false,
    }
    expect(schema.safeParse(base).success).toBe(false)
  })
})
