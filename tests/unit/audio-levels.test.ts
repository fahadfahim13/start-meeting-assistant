import { describe, expect, it } from 'vitest'
import { classifyLevel, describeLevel, parseVolumeDetect } from '../../src/shared/audio-levels'

/**
 * The numbers here are not invented — they are the measured values from the
 * recording that produced the "summary and transcript is not working" report
 * (2026-08-31, meeting 50d6d071, 15.2 s, all four tracks present).
 */
const REAL_SYSTEM_TRACK = { meanVolumeDb: -91.0, maxVolumeDb: -91.0 }
const REAL_MIC_TRACK = { meanVolumeDb: -53.5, maxVolumeDb: -24.8 }

describe('classifyLevel', () => {
  it('calls the real captured loopback track digital silence', () => {
    expect(classifyLevel(REAL_SYSTEM_TRACK)).toBe('digital-silence')
  })

  it('does NOT call the real mic track silent — it had signal, just no speech', () => {
    // This is the distinction the old -70 dB mean-only gate could not make.
    expect(classifyLevel(REAL_MIC_TRACK)).toBe('very-quiet')
  })

  it('treats normal speech as ok', () => {
    expect(classifyLevel({ meanVolumeDb: -21.4, maxVolumeDb: -3.1 })).toBe('ok')
  })

  it('needs mean AND max to be equal — a quiet but varying track is not silence', () => {
    // Same mean as the silent track, but a 30 dB spread: something was there.
    expect(classifyLevel({ meanVolumeDb: -91, maxVolumeDb: -61 })).not.toBe('digital-silence')
  })

  it('does not claim silence it could not measure', () => {
    expect(classifyLevel({ meanVolumeDb: null, maxVolumeDb: null })).toBe('ok')
    expect(classifyLevel({ meanVolumeDb: -91, maxVolumeDb: null })).toBe('ok')
  })

  it('a loud transient does NOT rescue a low mean', () => {
    // A −6 dB peak over a −50 dB floor is a door slam, not a conversation.
    // Gating on the peak is what would have called the real failing mic track
    // "ok" (its peak was −24.8 dB) and left the user with no explanation.
    expect(classifyLevel({ meanVolumeDb: -50, maxVolumeDb: -6 })).toBe('very-quiet')
  })
})

describe('parseVolumeDetect', () => {
  it('reads both values out of real ffmpeg stderr', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 000001a835d0b840] n_samples: 1459200',
      '[Parsed_volumedetect_0 @ 000001a835d0b840] mean_volume: -91.0 dB',
      '[Parsed_volumedetect_0 @ 000001a835d0b840] max_volume: -91.0 dB',
    ].join('\n')
    expect(parseVolumeDetect(stderr)).toEqual({ meanVolumeDb: -91, maxVolumeDb: -91 })
  })

  it('returns nulls rather than NaN when volumedetect did not print', () => {
    expect(parseVolumeDetect('some unrelated ffmpeg output')).toEqual({
      meanVolumeDb: null,
      maxVolumeDb: null,
    })
  })

  it('handles a positive-looking zero and decimals', () => {
    expect(parseVolumeDetect('mean_volume: -0.5 dB\nmax_volume: 0.0 dB')).toEqual({
      meanVolumeDb: -0.5,
      maxVolumeDb: 0,
    })
  })
})

describe('describeLevel', () => {
  it('says nothing when the track is fine', () => {
    expect(describeLevel('ok', 'mic')).toBeNull()
    expect(describeLevel('ok', 'system')).toBeNull()
  })

  it('names the endpoint cause for silent system audio (M-019/M-020)', () => {
    const msg = describeLevel('digital-silence', 'system')
    expect(msg).toContain('output device')
    expect(msg).toContain('headphones')
  })

  it('gives the mic its own advice, not the system-audio one', () => {
    expect(describeLevel('digital-silence', 'mic')).toContain('microphone')
    expect(describeLevel('digital-silence', 'mic')).not.toContain('headphones')
  })
})
