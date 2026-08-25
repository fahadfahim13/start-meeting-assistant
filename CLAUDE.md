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
```

---

## Current state

**Phase 1 capture engine substantially complete.** The app records screen + camera + mic +
system audio into one MKV through the full production path, verified by unattended E2E.
See `PROGRESS.md`.

- Spikes 1, 2 PASSED (B-005, B-006). Spike 3 CPU baseline measured: **0.72x realtime**
  (B-007). Spike 3 Vulkan (B-008) blocked on the user running
  `scripts/install-build-toolchain.ps1` elevated. Spike 4 pending model re-download (M-009).
- Test harnesses: `npm run smoke` (boot+probe), `MEETFROGE_AUTOREC=N` (unattended recording
  E2E), `scripts/sync-test.mjs` (mic-vs-system alignment).
- Known open issue **R-11**: mic lags system audio ~120 ms systematically. Do NOT try
  `-use_wallclock_as_timestamps` — it breaks the recording (M-010).

### Things that will bite you (all learned the hard way — details in MISTAKES.md)

- **Electron produces no stdout on Windows** (M-004). Assert on exit codes and files.
  `--enable-logging` for interactive debugging.
- **`h264_amf` needs an explicit nv12 conversion** (M-001) — on EVERY chain, camera included
  (M-007 sibling). Probe encoders with real encodes.
- **Exclusive devices** (M-007): the renderer preview must release the camera BEFORE
  session:start. `previewsSuspended` in the store handles this — keep it.
- **Ring pre-roll** (M-008): the loopback ring clears on ffmpeg connect. Removing that
  reintroduces a ~400 ms system-track shift.
- **Downloads** (M-009): verify byte count/hash; never trust an exit code read through a pipe.

## Per-phase discipline

A phase is not done until:
- `PROGRESS.md` updated
- new entries appended to `MISTAKES.md`
- new measurements recorded in `docs/benchmarks.md`
- an ADR added to `DECISIONS.md` if a non-obvious choice was made
