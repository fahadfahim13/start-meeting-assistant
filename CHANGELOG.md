# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
