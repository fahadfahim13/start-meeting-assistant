/**
 * One classifier for "was there actually any sound on this track?".
 *
 * Two subsystems ask that question — the capture session right after stop, and
 * the extract stage before transcription — and they MUST agree. When they
 * disagreed the result was the failure this module exists to prevent: a
 * recording whose system track was bit-exact digital silence sailed through
 * every gate, whisper returned no segments, the stage reported `done`, and the
 * user was told "No summary yet — it appears after processing finishes" forever
 * (MISTAKES.md M-023).
 *
 * Pure: no Electron, no fs, no ffmpeg. The ffmpeg call lives at the call sites;
 * this file only interprets numbers, so it is unit-testable.
 */

export type AudioLevel = 'digital-silence' | 'very-quiet' | 'ok'

export interface TrackLevels {
  /** volumedetect mean_volume in dBFS, null when it could not be measured. */
  meanVolumeDb: number | null
  /** volumedetect max_volume in dBFS, null when it could not be measured. */
  maxVolumeDb: number | null
}

/**
 * Measured on REF-01 from a real failed recording: a loopback track that
 * captured nothing reports mean −91.0 dB AND max −91.0 dB. Mean equal to max is
 * the signature — a constant signal, i.e. every sample identical, i.e. zeros.
 * Real room noise on the same recording read mean −53.5 / max −24.8, a 29 dB
 * spread. Any genuine audio has a spread; silence has none.
 */
const SILENCE_SPREAD_DB = 0.5
const SILENCE_MEAN_DB = -80

/**
 * Below this mean there is signal, but no SUSTAINED speech.
 *
 * Mean, not peak, is the discriminator. Conversational speech recorded at a
 * sane input level sits around −20 to −30 dBFS mean; the failing recording's
 * mic track measured −53.5 dB mean with a −24.8 dB peak — occasional transients
 * (a keystroke, a chair) over a floor of nothing, and whisper found zero
 * segments in it. Gating on the peak too would have called that track "ok",
 * which is exactly the false reassurance this module exists to stop.
 */
const QUIET_MEAN_DB = -45

export function classifyLevel(levels: TrackLevels): AudioLevel {
  const { meanVolumeDb: mean, maxVolumeDb: max } = levels
  // Unmeasurable is not silent. Claiming silence we did not observe would be
  // the same dishonesty in the other direction — let the audio through.
  if (mean === null || max === null) return 'ok'
  if (Math.abs(mean - max) < SILENCE_SPREAD_DB && mean < SILENCE_MEAN_DB) return 'digital-silence'
  if (mean < QUIET_MEAN_DB) return 'very-quiet'
  return 'ok'
}

/**
 * Parse `mean_volume:`/`max_volume:` out of ffmpeg's volumedetect stderr.
 *
 * NOTE for callers: volumedetect must come BEFORE any loudnorm in the filter
 * chain. Measuring after normalisation reports the normalised level and makes
 * every quiet track look fine — that was M-023.
 */
export function parseVolumeDetect(stderr: string): TrackLevels {
  const read = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s*(-?[\\d.]+) dB`).exec(stderr)
    const v = m ? parseFloat(m[1]!) : NaN
    return Number.isFinite(v) ? v : null
  }
  return { meanVolumeDb: read('mean_volume'), maxVolumeDb: read('max_volume') }
}

/**
 * A sentence a user can act on, or null when the track is fine.
 *
 * The system-audio wording names the real cause deliberately: M-019 and M-020
 * both traced loopback silence to the output endpoint, not to the app — a
 * headphone plugged in mid-meeting moves the render session to a different
 * device and the loopback stream that was already open keeps capturing zeros.
 */
export function describeLevel(level: AudioLevel, track: 'mic' | 'system'): string | null {
  if (level === 'ok') return null
  if (track === 'system') {
    return level === 'digital-silence'
      ? 'System audio recorded pure silence. Check that sound was actually playing on your default output device — plugging in headphones mid-meeting moves the loopback to a different endpoint.'
      : 'System audio was very quiet — other people in the call may not be transcribed.'
  }
  return level === 'digital-silence'
    ? 'The microphone recorded pure silence. Check that the right microphone is selected and not muted in Windows.'
    : 'The microphone was very quiet — your speech may not be transcribed. Move closer or raise the input level.'
}
