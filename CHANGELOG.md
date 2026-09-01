# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Q&A report** — an on-demand FAQ-style briefing generated from the meeting, each answer
  carrying a timestamp that is snapped to a real transcript segment or dropped entirely.
- **Transcript editing** — correct any line; the full-text index is rewritten in the same
  transaction. `docs/risks.md` R-07 had listed this as its mitigation for Bangla-English
  accuracy while it did not exist (M-035).
- **Marked moments** — flag a moment during the recording; shown in the Library and passed to
  the summarizer as the only human-judgement signal in the pipeline.
- **Mid-recording mute** for the microphone and system audio, without stopping or respawning.
- **Independent source toggles** for camera, microphone and system audio, remembering the
  chosen device while off.
- **Choosable recordings folder**, with the transcript, summary and Q&A written beside the
  video as plain files. Existing recordings never move.
- **Live system-audio meter before recording**, so a loopback attached to the wrong output
  device is visible before a meeting rather than after it (M-032).
- Per-meeting notes, summary export, and speaker names remembered across meetings.

### Fixed

- **Window recording produced a zero-byte file.** `h264_amf` refuses frames under 128×128 and
  gdigrab captures a minimised window at its tiny restored size (M-021).
- **A pipeline that produced nothing reported success.** The silence gate measured audio after
  loudness normalisation, reading a −53.5 dB microphone as −19.8 dB (M-023); an empty
  transcription result was written over a good transcript (M-024); re-processing was a no-op
  because checkpoints were never cleared (M-025). Skips now carry a reason that reaches the UI.
- **Scene classification had been wrong since Phase 5** — literal control characters where word
  boundaries were intended (M-026).
- **A recordings folder change orphaned earlier recordings** (M-031).
- Preview enumerated every open window twice a second; capture failures reached no log at all.
- `npm run lint` from 15 errors to 0; `tests/**` is now type-checked.

### Changed

- **File size reduced ~13x** — every preset moved from fixed bitrate to quality-based rate
  control. `high` measures 0.26 GB/hour against 3.40 before, at the same resolution, framerate
  and track count (B-011).

## [0.1.0] — 2026-08-26

First working release. Windows-only, unsigned installer (verify the SHA-256
from SHA256SUMS.txt; SmartScreen will warn).

### Added
- **Recording**: screen/window + camera + microphone + system audio (WASAPI
  loopback — no virtual driver) into one MKV with separate tracks; hardware
  H.264 encode with software fallback ladder; pause/resume; 5-minute
  crash-safe segments with automatic recovery; disk guard; non-suppressible
  recording indicator
- **Transcription**: whisper.cpp large-v3-turbo with built-in silero VAD;
  language override (en/bn/auto); per-track speaker identity — the mic track
  is "You" with certainty, before any diarization runs
- **Diarization**: sherpa-onnx (pyannote + ERes2Net) on the system track only;
  click-to-rename speakers; certain vs probabilistic styling
- **Visual analysis**: perceptual-hash keyframe detection with a reported cap,
  offline OCR, SmolVLM2 scene captions, camera-presence timeline
- **Summaries**: grammar-constrained map-reduce over Qwen3-4B with the visual
  timeline injected; timestamped decisions; checkable action items
- **Library**: playback with synced live-highlighted transcript and universal
  click-to-seek; one search box across speech AND on-screen text; tags; export
  txt/srt/vtt/json/md
- **Settings**: quality preset, language, auto-process, keyframe sensitivity,
  model manager with hash-verified resumable downloads
- **Security**: sandboxed renderer + strict CSP + fuses; registry-generated
  IPC fuzz battery; centralized path-containment guards; SHA-256 manifest
  over all bundled binaries verified at boot; redacting logger; 0 npm audit
  findings
- **Accessibility**: measured WCAG AA palette, keyboard playback shortcuts,
  live regions, light/dark themes, reduced-motion support; UI strings
  externalized (Bangla-ready)

### Known limitations (tracked honestly)
- Mic↔system audio skew ~120 ms (up to ~290 ms under heavy CPU) — R-11
- Encryption-at-rest deferred (ADR-012); use full-disk encryption
- Auto-update, PDF/DOCX export, storage migration: deferred post-release
- Whisper GPU (Vulkan) build pending a local toolchain — CPU transcription
  measured at 0.72× realtime

<!-- Releases will be listed below once published. -->
