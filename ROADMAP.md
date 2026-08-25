# Roadmap

Direction, not dates. Order reflects priority; anything past v1.0 is provisional.

## v1.0 — Windows

The scope described in `PROGRESS.md`. Ships when all phases are complete and the verification
checklist passes.

- Recording: screen or window, camera, microphone, desktop audio — separate tracks, one MKV
- Hardware-accelerated encoding with a full software fallback ladder
- Transcription with VAD gating and Vulkan acceleration where available
- Speaker identification: exact from track separation, diarized for remote speakers
- Keyframe-driven visual analysis with OCR and vision-model captions
- Map-reduce summarization with key points, decisions and action items
- Meeting library with full-text search across transcripts and on-screen text
- Optional encryption at rest
- Windows installer with a first-run model-download wizard

## v1.1 — Quality of life

- **Live transcript during recording** — deferred from v1.0 (ADR-006) because it competes with
  capture for CPU. Viable on stronger machines with careful throttling.
- Transcript diffing after re-transcription with a different model
- Custom summary templates (standup, interview, client call, lecture)
- Meeting templates that preset devices and quality per meeting type
- Bulk re-processing when a better model becomes available

## v1.2 — Linux

The capture layer already sits behind `CaptureBackend` (ADR-001), so this is a port rather than
a rewrite. The hard part is not the interface — it is that desktop audio and screen capture are
genuinely harder on Linux than on Windows.

- PipeWire monitor sources for desktop audio
- `xdg-desktop-portal` screen capture with Wayland permission handling
- X11 fallback via `x11grab`
- VAAPI hardware encoding
- `.AppImage` and `.rpm` packaging

## v1.3 — macOS

- ScreenCaptureKit for screen capture
- CoreAudio Tap API for system audio (macOS 14.2+)
- VideoToolbox hardware encoding
- Metal acceleration for inference
- Notarized `.dmg`

## Under consideration

Not committed. Listed so the reasoning is visible if they are rejected later.

- **Improved Bangla and code-switched transcription.** The hardest open problem for this project's
  actual usage. Depends on whether a good open code-switched checkpoint appears.
- **Reproducible builds.** Currently listed in SECURITY.md as a known gap.
- **Signed installers.** Blocked on cost versus the $0 constraint — see the open items in
  `PROGRESS.md`.
- **Local semantic search** over transcripts using an embedding model, complementing FTS5.
- **Automatic chapter detection** from the visual timeline plus topic shifts.
- **Meeting-platform awareness** — detecting which app is being captured to improve summaries.
  Explicitly *not* bots that join calls; that would break the local-only model.

## Explicitly out of scope

These are non-goals, not backlog items. They conflict with the product's core premise:

- Cloud sync, accounts, or any server component
- Real-time translation
- Multi-user collaboration or shared workspaces
- Bots that join meetings on your behalf
- Paid tiers, telemetry-driven analytics, or usage tracking
- Mobile clients
