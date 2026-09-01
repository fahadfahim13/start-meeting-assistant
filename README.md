# MeetFroge

**A local-first meeting recorder, transcriber, visual analyzer and summarizer.**

Records your meetings — camera, screen, microphone and desktop audio — then transcribes them,
reads what was on screen, and writes you a summary. Everything runs on your own machine.
No cloud, no accounts, no API keys, no subscription.

> **Status: 0.1.0 alpha.** The full loop works — record, transcribe, diarize, analyze the
> screen, summarize, search — verified by automated end-to-end tests with content assertions.
> Windows-only, unsigned installer. See [PROGRESS.md](PROGRESS.md) for what is deferred.

---

## Why

Meeting recorders either send your conversations to someone else's server, charge a monthly fee,
or both. MeetFroge does neither. Your meetings are yours: recorded to standard MKV, transcribed
locally, indexed in a plain SQLite database on your disk.

## What it does

- **Records everything at once** — screen or window, camera, your microphone, and the audio from
  the meeting itself, in a single file with separate tracks.
- **Transcribes locally** with Whisper, hardware-accelerated where possible.
- **Knows who spoke.** Your microphone track is you; the system-audio track is everyone else.
  That split is exact, not a guess. Remote speakers are then separated from each other.
- **Reads your screen.** Detects when the screen actually changed — a new slide, a different app —
  and runs OCR and a vision model on those moments, so you can search a meeting by text that was
  only ever on a slide.
- **Summarizes** into key points, decisions and action items, each linked back to the moment it
  was said.
- **Answers the questions you would have asked.** On request it turns a meeting into a short
  Q&A briefing — what was decided, who is doing what, what is still open — each answer linked to
  the moment it came from.
- **Lets you fix what it misheard.** Click any line in the transcript to correct it; the search
  index follows the correction. This matters most for mixed Bangla-English speech, which every
  open model garbles at the switch points.
- **Mark a moment while it happens.** One button during the recording flags the bit that
  mattered, so you are not hunting for it in an hour of transcript later. Marked moments are
  fed to the summarizer.
- **Mute either audio track mid-recording** without stopping, and turn the camera, microphone
  and system audio on or off independently before you start.
- **Keeps it all searchable** across every meeting you have ever recorded.
- **Writes plain files next to the video** — transcript as `.md`/`.srt`/`.json`, plus the
  summary and the Q&A report — in a folder you choose. Nothing is locked inside the app.

## Privacy

This is the point of the project, so it is stated precisely:

1. **No telemetry.** Not opt-out — absent. There is no analytics code in this repository, and CI
   fails if any is added.
2. **No runtime network calls**, except model downloads you explicitly start.
3. **All processing is local.** Pull the network cable and everything still works.
4. **Recording is always visible** and cannot be hidden by any setting.
5. **Crash logs stay on your disk** and are never transmitted.

Encryption at rest is deferred (see [ADR-012](DECISIONS.md)) — full-disk encryption
(BitLocker) covers that threat more completely, and [PRIVACY.md](PRIVACY.md) is specific
about limits rather than vague about guarantees.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 20H2+ | Windows 11 |
| CPU | 4 cores | 6+ cores |
| RAM | 8 GB | 16 GB+ |
| Disk | 15 GB free | 50 GB+ |
| GPU | none (CPU fallback) | any Vulkan-capable GPU, discrete or integrated |

Models are downloaded on first run (~4.7 GB). The app works without a GPU — just slower.

Linux and macOS are planned; the capture layer is already isolated behind an interface for that.
See [ROADMAP.md](ROADMAP.md).

## Install

Not yet released. Once available, download the installer from
[Releases](https://github.com/fahadfahim13/start-meeting-assistant/releases).

The installer is currently unsigned, so Windows SmartScreen will warn on first run
("More info" → "Run anyway"). Verify the SHA-256 checksum published with each release.

## Build from source

```bash
git clone https://github.com/fahadfahim13/start-meeting-assistant.git
cd meetfroge
nvm use          # Node 22.13.1
npm ci
npm run dev
```

Full setup, including building whisper.cpp and llama.cpp with Vulkan, is in
[docs/setup.md](docs/setup.md).

## How it is built

| Layer | Tool |
|---|---|
| Shell | Electron 44 (pinned) + React + TypeScript |
| Recording | ffmpeg — Desktop Duplication capture, hardware H.264 encode |
| Desktop audio | Chromium WASAPI loopback → PCM → ffmpeg |
| Transcription | whisper.cpp with built-in silero VAD |
| Diarization | sherpa-onnx (pyannote + ERes2Net) |
| OCR | tesseract.js |
| Vision + summary | llama.cpp `llama-server` — SmolVLM2, Qwen3-4B |
| Storage | SQLite (Node's built-in `node:sqlite`) with FTS5 |

No Python, no PyTorch, no cloud services. Architecture and the reasoning behind each choice are
in [docs/architecture.md](docs/architecture.md) and [DECISIONS.md](DECISIONS.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

If you are touching the capture engine, read [MISTAKES.md](MISTAKES.md) first. It records the
non-obvious failures already discovered, so you do not have to rediscover them.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[GPL-3.0-or-later](LICENSE).

MeetFroge bundles ffmpeg built with libx264 (GPL), which is the CPU encoding fallback for
machines without hardware encoders. See [ADR-009](DECISIONS.md#adr-009--gpl-30-or-later) for
the full reasoning. Third-party licenses are listed in `THIRD_PARTY_NOTICES.md`, generated at
build time.
