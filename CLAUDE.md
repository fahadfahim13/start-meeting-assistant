# CLAUDE.md — MeetFroge briefing

Read this before touching anything. Read `MISTAKES.md` before touching capture or ffmpeg code.
Full specification: `docs/` + the approved plan. This file is the *briefing*, not the docs.

---

## What this is

Local-first desktop app: records meetings (camera + screen + mic + desktop audio),
transcribes, analyzes on-screen content, summarizes. Everything runs on the local machine.

## Hard constraints — do not violate without an ADR

- **Windows-first.** Linux is a later port, behind `CaptureBackend`.
- **Zero Python.** Node + native binaries only. No FastAPI, no PyTorch, no pyannote, no faster-whisper.
- **$0 running cost.** No paid APIs, no subscriptions, no cloud.
- **Fully offline.** No runtime network calls except user-initiated model downloads.
- **GPL-3.0-or-later.** Required because we bundle GPL ffmpeg (libx264 is our CPU encoder fallback).

## Design principles (binding)

1. **Local by default.** Must work fully with the network cable pulled.
2. **The recording is sacred.** Analysis may fail, retry, or be abandoned. The recording must never be lost.
3. **Degrade, never break.** No Vulkan -> CPU. No AMF -> libx264. No VLM -> OCR only. No diarization -> track split.
4. **Efficient by construction.** A 15W laptop is the design target, not the degraded case.
5. **Honest about failure.** Silent truncation and silent fallback are bugs. If coverage was capped, the UI says so.
6. **Open by default.** Standard MKV, standard JSON/SRT, plain SQLite. No lock-in.

---

## Verified hardware profile (measured 2026-08-25 — do not re-derive)

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| CPU | AMD Ryzen 5 5500U, 6C/12T, Zen 2, 15W TDP |
| RAM | 23.3 GB DDR4 dual channel (~35 GB/s effective) |
| GPU | AMD Radeon integrated, PCI `0x164C` (Lucienne, Vega 7, GCN5 / gfx90c) |
| CUDA | **None.** ROCm does **not** support Windows APUs. Vulkan is the only accel path. |
| Vulkan | Present: `AMD Radeon(TM) Graphics`, AMD proprietary driver 22.20.44.08, VK 1.3.217 |
| Disk | C: 77.5 GB free / 328 GB  ·  D: 12.8 GB free |
| ffmpeg | 8.1.1 gyan full build (GPL) |
| dshow devices | `HP TrueVision HD Camera`, `OBS Virtual Camera`, `Microphone Array (AMD Audio Device)` |
| **System audio source** | **NONE.** No Stereo Mix. No virtual-audio-capturer. This is why we use Chromium loopback. |

Implication: inference generation speed is **memory-bandwidth bound**, not compute bound.
Expect ~76 t/s prompt processing and ~10 t/s generation for a 4B Q4 model with Vulkan offload.

---

## Verified-working ffmpeg recipes — use these verbatim

Screen capture + AMD hardware encode. **The nv12 conversion is mandatory** (see MISTAKES.md M-001):

```
ffmpeg -init_hw_device d3d11va \
  -filter_complex "ddagrab=0:framerate=15,hwdownload,format=bgra,format=nv12,hwupload" \
  -c:v h264_amf ...
```

Window capture (ddagrab captures outputs, not windows):

```
ffmpeg -f gdigrab -framerate 15 -i title=<window> -c:v h264_amf ...
```

Software fallback:

```
ffmpeg -init_hw_device d3d11va \
  -filter_complex "ddagrab=0:framerate=15,hwdownload,format=bgra" \
  -c:v libx264 -preset veryfast ...
```

System audio (from the renderer's loopback bridge, over stdin):

```
-f s16le -ar 48000 -ac 2 -thread_queue_size 4096 -i pipe:0
```

---

## Pinned versions — changing these needs a smoke test

| Component | Version | Why pinned |
|---|---|---|
| Electron | **44** exact | Loopback audio is version-fragile; 40.1.0 reportedly regressed to silence |
| Node | 22.13.1 | `.nvmrc` |
| ffmpeg | 8.1.x | Verified recipes above |
| sherpa-onnx | 1.13.6 | Node addon, VAD + diarization |

---

## Invariants — never violate

- Mic and system audio are **never** mixed into one track. `a:0` = mic (you), `a:1` = system (everyone else).
  This is the free, perfect two-way speaker split. Diarization runs on `a:1` **only**.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Always.
- **`shell: false` on every spawn.** No exceptions. argv arrays only. Never interpolate into a command string.
- No renderer-supplied filesystem path ever crosses IPC. The renderer sends IDs; main resolves paths.
- No channel accepts SQL, a command, a module name, or a function name.
- Encoder capability is probed by **running a real 1-second encode**, never by reading `-encoders`.
- Binary paths resolve from app resources via a helper. Never look up `PATH` at runtime.
- Transcript text, OCR text, and LLM output are **never** written to logs.
- Recording indicator is not suppressible by any setting. It is a security control, not a preference.

---

## Commands

```
npm run dev            # Electron + Vite dev
npm run build          # production build
npm run test           # unit + integration
npm run test:e2e       # Playwright
npm run lint           # eslint + prettier
npm run typecheck      # tsc --noEmit
npm run spike:1        # loopback audio spike
npm run spike:2        # PCM -> ffmpeg pipe spike
npm run spike:3        # whisper.cpp Vulkan benchmark
npm run spike:4        # llama.cpp Vulkan benchmark

npm run test:honesty   # synthetic silence/tone -> asserts pipeline outcome CODES
npm run test:qa        # Q&A report content assertions on a real meeting
npm run test:storage   # custom recordings folder, including the reset-to-default reversal
npm run test:features  # transcript edit, speaker-name memory, markers, notes
npm run diagnose:audio # play a known tone, record, prove system audio is captured
```

Every harness that launches the app must go through `scripts/electron-run.mjs` — see M-030.

---

## Current state

**v0.1.0 tagged. All 12 phases core-complete.** See `PROGRESS.md` for the deferred list
(auto-update, encryption-at-rest per ADR-012, storage migration, pdf/docx export,
list virtualization) and `docs/testing.md` for the manual release gates still open
(clean-VM install, Narrator pass, 3-hour recording).

- **206 unit tests** · 14+ E2E/content harnesses (recording, pause, crash recovery, sync,
  transcription content, diarization, visual, summary, Q&A, pipeline honesty, storage root,
  feature self-test, forced-software-encode, packaged smoke) · 0 npm audit findings
- Installer: `npx electron-builder --win` → release/. Packaged smoke:
  `MEETFROGE_SMOKE=1 release/win-unpacked/MeetFroge.exe` (result in %APPDATA%/MeetFroge/out/)
- **CI has never run.** The GitHub account is locked for a billing issue, so every workflow
  exits in seconds without starting. Every result above is from local runs only.
- **The current UI has not been visually reviewed.** Recent work (live system meter, mute
  buttons, Q&A tab, folder picker, transcript editing, markers) is verified by measurement and
  harnesses; nobody has looked at it rendered.

### Things that will bite you (details in MISTAKES.md — 35 entries)

- **Electron: no stdout on Windows** (M-004); packaged failures can be a modal
  Error dialog you cannot see — check window title + child-process tree (M-017).
  `console.*` is banned in `src/main/**` by eslint for this reason (M-022).
- **A stray Electron makes any harness pass without running** — the single-instance
  lock means a second launch exits **0 without booting**. Go through
  `scripts/electron-run.mjs`, which kills strays and asserts on a fresh artefact (M-030).
- **h264_amf refuses frames under 128×128** and gdigrab captures a minimised window at its
  tiny restored size — pad in the filter, never map a video source raw (M-021).
- **h264_amf needs explicit nv12** on EVERY chain (M-001, M-007).
- **Measure before you correct**: `volumedetect` after `loudnorm` reports the normaliser's
  opinion, not the signal — it read a −53.5 dB mic as −19.8 dB (M-023).
- **A stage returning `done` having produced nothing is a bug**, and a write path that
  DELETES before it INSERTS must never be handed an empty set (M-024).
- **Cleanup belongs in a stage that cannot be skipped**, and any "reset for re-run" must clear
  the checkpoint or it resets the paperwork and keeps the wrong answer (M-025).
- **Invisible control characters**: `\b` written through a shell heredoc lands as a literal
  0x08 byte. Never author a regex through a heredoc; `no-control-regex` is not noise (M-026, M-028).
- **A stored row must not depend on mutable settings to be interpreted** — record what was
  true at the time (M-031).
- **A capture path that can fail environmentally needs a LIVE pre-flight readout**, not just a
  post-hoc warning (M-032).
- **Fixed bitrate on screen content is the worst choice** — quality-based encoding is 13×
  smaller for the same picture (M-033, B-011).
- **ffmpeg accepts filter commands on stdin**: `cvolume@mic -1 volume 0`, no space after `c`,
  time field required (M-034).
- **Check that a documented mitigation exists** — R-07 claimed "transcript is editable" for
  two phases while it was not (M-035).
- **Exclusive devices**: previews release before recording (M-007); keep previewsSuspended.
- **asar is read-only** — harness/app writes go to userData when packaged (M-017).
- **Never hand-curate the node_modules closure** in electron-builder files (M-017).
- **probeCapabilities is memoized** — do not add per-call probes back (M-016).
- **Downloads/models**: verify bytes+hash, never existence (M-009, M-013).
- **Do not try wallclock timestamps on the audio inputs** (M-010, R-11).

## Per-phase discipline

A phase is not done until:
- `PROGRESS.md` updated
- new entries appended to `MISTAKES.md`
- new measurements recorded in `docs/benchmarks.md`
- an ADR added to `DECISIONS.md` if a non-obvious choice was made
