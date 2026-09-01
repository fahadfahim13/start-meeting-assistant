# Architecture

How MeetFroge is put together, and why. Decisions are recorded in
[DECISIONS.md](../DECISIONS.md); this document describes the resulting system.

## The one thing to understand first

**Electron is infrastructure here, not a UI shell.**

On Windows, ffmpeg cannot capture desktop audio. It has no WASAPI input backend, and DirectShow
exposes only capture endpoints, not the render endpoints where the system mix lives. Verified on
the reference machine: no Stereo Mix, no virtual audio device, nothing (see
[benchmarks B-002](benchmarks.md)).

Chromium *can* capture it, through WASAPI loopback. So the renderer process holds a real-time
audio data path that feeds the recording. This is unusual and it is the source of several design
constraints — the PCM bridge backpressure design, the Electron version pinning, the loopback
smoke test in CI. Anyone touching capture needs to know this.

## Process topology

```
┌─────────────────────────────────────────────────────────────────────┐
│ ELECTRON MAIN  (Node 22, privileged, never loads remote content)    │
│                                                                     │
│  SessionManager      recording lifecycle                            │
│  JobQueue            resumable, SQLite-backed, single worker        │
│  ProcessSupervisor   spawn / kill / watchdog, argv-only             │
│  Database            better-sqlite3, WAL, FTS5                      │
│  ModelManager        download, SHA-256 verify, tier selection       │
│  CapabilityProbe     real 1s encodes, Vulkan detection              │
│  IpcGateway          allowlisted channels, zod both directions      │
└──────────────┬──────────────────────────────────┬───────────────────┘
               │ contextBridge (sandboxed)        │ child_process
┌──────────────▼───────────────────┐  ┌───────────▼───────────────────┐
│ RENDERER (React, sandboxed)      │  │ WORKERS                       │
│                                  │  │                               │
│  Setup / preview / controls      │  │  ffmpeg       capture, encode │
│  Library / transcript / summary  │  │  ffmpeg       extract, frames │
│                                  │  │  whisper.cpp  transcribe      │
│  ⚠ WASAPI loopback tap           │  │  llama-server VLM, summarize  │
│    getDisplayMedia (audio only)  │  │                               │
│    → AudioWorklet → s16le PCM    │  │ IN-PROCESS (Node addons)      │
│    → contextBridge → main        │  │  sherpa-onnx  VAD, diarize    │
│                                  │  │  tesseract.js OCR (workers)   │
└──────────────────────────────────┘  └───────────────────────────────┘
```

## Module layout

```
src/
├── main/
│   ├── index.ts                  entry, single-instance lock, fuses
│   ├── window.ts                 hardened BrowserWindow factory
│   ├── ipc/
│   │   ├── gateway.ts            channel allowlist + validation
│   │   └── handlers/             one file per domain
│   ├── capture/
│   │   ├── backend.ts            CaptureBackend interface  ← portability seam
│   │   ├── windows.ts            WindowsCaptureBackend
│   │   ├── ffmpeg-builder.ts     argv construction, encoder ladder
│   │   ├── loopback-bridge.ts    PCM ingest, ring buffer, backpressure
│   │   ├── segmenter.ts          chunked output, concat, recovery
│   │   └── sync.ts               A/V offset measurement + correction
│   ├── pipeline/
│   │   ├── queue.ts              resumable job runner
│   │   ├── stages/               extract-audio, vad, transcribe, diarize,
│   │   │                         keyframes, ocr, vlm, summarize
│   │   └── llm/                  server lifecycle, map-reduce
│   ├── db/
│   │   ├── index.ts              connection, pragmas
│   │   ├── migrations/           numbered, forward-only
│   │   └── repositories/         parameterized queries only
│   ├── security/
│   │   ├── paths.ts              allowlist + traversal guard
│   │   ├── crypto.ts             AES-256-GCM + safeStorage key wrap
│   │   └── integrity.ts          binary + model SHA-256 verification
│   └── platform/
│       ├── capability-probe.ts   AMF / Vulkan / encoder detection
│       └── resources.ts          disk, battery, thermal, memory
├── renderer/
│   ├── audio/loopback-worklet.ts AudioWorklet processor
│   ├── features/                 setup, recording, library, transcript, summary
│   ├── components/
│   └── store/                    zustand
├── preload/
│   └── index.ts                  contextBridge surface, nothing else
└── shared/
    ├── schemas/                  zod — single source of truth for IPC, DB, LLM output
    └── types/
```

## Recording data flow

```
Screen  ──ddagrab (D3D11 Desktop Duplication)──┐
         └─fallback→ gdigrab                    │
Camera  ──dshow──────────────────────────────── ┤
Mic     ──dshow──────────────────────────────── ┼──► ffmpeg ──► segment_NNN.mkv
Desktop ──Chromium WASAPI loopback──────────────┘              ├ v:0 screen (h264_amf)
          → AudioWorklet → Float32 → s16le PCM                 ├ v:1 camera (h264_amf)
          → contextBridge → main → ring buffer                 ├ a:0 mic    (opus 64k)
          → ffmpeg stdin                                       └ a:1 system (opus 64k)
```

With the camera overlay on (ADR-017), the camera is decoded once and `split` two ways: a small
rounded copy is composited into `v:0`, and the full raw camera still goes to `v:1`. The stream
count is the same either way, which is what lets a recording fall back to no-overlay mid-flight
and still concatenate.

```
Camera ──dshow──► fps ──split──┬─► scale 480 ───────────────────────────────► v:1 camera
                               └─► scale+crop ─► pad(border) ─► alphamerge ─┐
                                   mask.png ──► scale ─► gray ──────────────┘
                                                                            └► overlay ─► v:0
```

Segments are 5 minutes each and independently playable, so a crash costs at most 5 minutes.
On stop they are concatenated losslessly (`-c copy`).

**The audio track separation is load-bearing.** `a:0` is your microphone; `a:1` is everyone else.
That gives an exact two-way speaker split before any diarization runs, and it is why the pipeline
only needs to diarize the system track. Code that mixes these destroys a core capability
(see [ADR-007](../DECISIONS.md#adr-007--separate-audio-tracks-never-mixed)).

## Analysis pipeline

```
meeting.mkv
│
├─ AUDIO
│   ├─ ffmpeg → mic.wav, system.wav   (16 kHz mono, loudness-normalized)
│   ├─ sherpa-onnx Silero VAD → speech regions
│   │    └─ removes 40–60% of a typical meeting → proportional Whisper speedup
│   ├─ whisper.cpp per region → timestamped segments
│   ├─ sherpa-onnx diarization on the SYSTEM TRACK ONLY
│   └─ merge: mic = "You" (exact), system = S1/S2/S3 (probabilistic)
│
├─ VIDEO
│   ├─ ffmpeg → 1 fps JPEGs, 480 px wide (downscaled inside ffmpeg)
│   ├─ pHash + histogram delta → keyframes (capped; cap is reported when it binds)
│   ├─ tesseract.js OCR on full-resolution re-extracts
│   ├─ llama-server VLM → captions + scene type
│   └─ camera track → presence heuristic
│
└─ FUSION
    └─ map-reduce over ~3k-token chunks, split at speaker turns
         └─ reduce with visual context injected
              └─ zod-validated JSON → repair-prompt retry on failure
```

## Where the efficiency comes from

Each row is a mechanism, not an aspiration:

| Mechanism | Saving |
|---|---|
| Hardware AMF encode | ~35% → ~3% CPU while recording |
| 15 fps default | 50% file size and encode work |
| VAD gating before Whisper | **40–60% of transcription time** — the largest single win |
| Keyframe selection | **~97% of visual analysis** (3600 → ~100 frames) |
| OCR before VLM | ~3× on text-heavy content |
| Vulkan offload | ~2× prompt processing (generation stays bandwidth-bound) |
| Single-worker queue | Avoids memory-bandwidth thrashing |
| Idle model unload | ~3 GB RAM returned after 5 min |
| ffmpeg-side downscaling | ~90% less I/O during frame extraction |
| FTS5 + virtualized lists | O(log n) search, 60 fps on 4000 rows |

## Degradation ladders

Principle 3: degrade, never break. Every capability has a defined fallback chain.

| Capability | Ladder |
|---|---|
| Screen capture | `ddagrab` → `gdigrab` → error |
| Encoding | `h264_amf` → `h264_nvenc` → `h264_qsv` → `libx264 veryfast` → `libx264 ultrafast` @ lower res |
| Desktop audio | native loopback → `electron-audio-loopback` → virtual audio cable → obs-websocket → record without it, warn loudly |
| Transcription | whisper Vulkan → whisper CPU → smaller model |
| Diarization | sherpa-onnx → track-based You/Others split |
| Visual analysis | OCR + VLM → OCR only → keyframes only |
| Summarization | Qwen3-8B → Qwen3-4B → extractive fallback |

## Portability

`CaptureBackend` is the seam. Everything platform-specific lives behind it:

```ts
interface CaptureBackend {
  enumerateDevices(): Promise<DeviceInventory>
  probeCapabilities(): Promise<Capabilities>
  buildCaptureArgs(config: CaptureConfig): string[]
  createSystemAudioSource(): Promise<SystemAudioSource>
}
```

Linux implements this with PipeWire monitor sources and `xdg-desktop-portal`; macOS with
ScreenCaptureKit and the CoreAudio Tap API. The pipeline, database, UI and job queue are already
platform-agnostic.
