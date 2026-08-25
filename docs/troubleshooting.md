# Troubleshooting

Diagnostic bundles: **Settings → Logs → Copy diagnostic bundle.** It contains timings, error
codes, ffmpeg arguments with paths redacted, and job state. It contains **no meeting content** —
transcript, OCR and model output are never logged.

---

## Recording

### No desktop audio — only my microphone was recorded

The most common and most important failure. Work through it in order:

1. **Check the pre-flight level meter.** If the system meter did not move while audio was
   playing, capture never started; the recording is not the problem.
2. **Is anything actually playing?** Loopback captures the system mix. Genuine silence is not an
   error.
3. **Did the output device change mid-recording?** Connecting Bluetooth headphones can silently
   move the audio endpoint. The logs record a gap when this is detected.
4. **Is an app holding the device in exclusive mode?** Some DAWs and games bypass the system mix
   entirely and cannot be captured. This is a Windows limitation, not a bug we can fix.
5. **Check the Electron version** in the diagnostic bundle. Loopback support is version-fragile;
   the app pins Electron 44 deliberately.

Related: [MISTAKES.md](../MISTAKES.md) M-002, M-003.

### Recording failed to start

Check the error code in the message:

| Code | Meaning | Action |
|---|---|---|
| `CAPTURE_ENCODER_FAILED` | Every encoder in the ladder was rejected | Update the GPU driver; force `libx264` in Advanced settings |
| `DEVICE_IN_USE` | Camera or microphone held by another app | Close the other app (Teams, Zoom and browsers commonly hold the camera) |
| `DEVICE_NOT_FOUND` | Selected device disappeared | Re-select in Setup; Windows regenerates device IDs across some driver updates |
| `STORAGE_LOW` | Below the disk floor | Free space or change the recording directory |

### Recording is choppy or dropping frames

Check which encoder was used — Settings → Meeting details → Capture profile. If it says
`libx264`, hardware encoding was unavailable and the CPU is doing the work. Update the GPU driver,
or lower the quality preset. On a low-power laptop, the Efficient preset at 720p10 is designed
for exactly this case.

Also check whether processing jobs were running during the recording. They should not be —
processing is post-meeting by design — but a manually retried job can overlap.

### The recording stopped by itself

Almost always disk space. Check the logs for `STORAGE_FULL`. The app stops cleanly and finalizes
what it has rather than corrupting the file.

### The app crashed mid-recording — did I lose everything?

No. Recording is segmented into 5-minute chunks, each independently playable. On next launch the
app finds orphaned segments and offers to recover them. You lose at most the final incomplete
segment.

---

## Processing

### Transcription is extremely slow

Check whether Vulkan acceleration is active: Settings → System → Capabilities. If it says CPU
only, transcription runs at roughly 0.3× realtime — a 1-hour meeting takes about 3 hours.

Options: update the GPU driver so Vulkan is detected, or switch to a smaller Whisper model
(Settings → Processing → Model tier). `medium` is roughly 3× faster than `large-v3-turbo` with a
modest accuracy cost.

### Transcription mangles Bangla, or switches language mid-sentence

Expected and documented. The default forces English, which keeps Bangla words transliterated but
preserves meeting substance. For a heavily Bangla meeting, set the per-meeting language override
to `bn` or `auto` and re-transcribe.

Code-switched Bengali-English is the hardest case for every open ASR model. See
[ADR-004](../DECISIONS.md#adr-004--stock-whisper-forced-to-english).

### Speaker labels are wrong

"You" comes from the microphone track and is exact. Remote speaker labels (Speaker 1, Speaker 2)
come from diarization and are probabilistic — the UI renders them differently for that reason.

If remote speakers are merged or split incorrectly, set the expected speaker count in
Settings → Transcription and re-run diarization. Overlapping speech and poor audio both degrade it.

### Too few or too many keyframes

Adjust Settings → Processing → Keyframe sensitivity (Sensitive / Balanced / Sparse).

If the UI reports that the keyframe cap was reached, coverage was truncated — raise the cap or
increase the threshold. The app tells you when this happens rather than silently dropping frames.

### The summary is generic or missed things

- Check that transcription completed successfully first. A poor transcript yields a poor summary.
- Long meetings are summarized by map-reduce; very long ones add an intermediate tier and lose
  some detail by construction.
- Try a larger model (Settings → Processing → Summarizer), or regenerate with a custom
  instruction focused on what you care about.

### A job failed and will not retry

Jobs retry 3 times with backoff, then stop. Retry manually from the meeting detail view. If it
fails again, check the error code in the diagnostic bundle. Downstream stages that do not depend
on the failed one still run — a failed VLM stage does not block summarization.

---

## Models

### Model download fails or is corrupted

Downloads are SHA-256 verified; a mismatch deletes the file rather than using it. Retry from
Settings → Models. Downloads resume rather than restarting.

If it fails repeatedly, check available disk space — the accelerated tier needs about 4.7 GB.

### Vulkan not detected despite having a supported GPU

1. Update the GPU driver from the vendor, not Windows Update.
2. Run `vulkaninfo --summary`. Confirm a **native vendor driver** appears, not only the Microsoft
   D3D12 mapping layers (shown as "Dozen").
3. Re-probe: Settings → System → Re-detect capabilities.

---

## Reporting a problem

Include the diagnostic bundle, what you expected, what happened, and the meeting duration and
quality preset. Use the issue templates.

For anything security-related, do **not** open a public issue — see [SECURITY.md](../SECURITY.md).
