# Development setup

## Prerequisites

| | Version | Check |
|---|---|---|
| Node | 22.13.1 (see `.nvmrc`) | `node -v` |
| npm | 10.x | `npm -v` |
| Git | any recent | `git --version` |
| Visual Studio Build Tools | 2022, "Desktop development with C++" | needed for `better-sqlite3` and `sherpa-onnx` native addons |
| CMake | 3.20+ | only if building whisper.cpp / llama.cpp from source |
| Vulkan SDK | 1.3+ | only if building with Vulkan support |

```bash
git clone https://github.com/fahadfahim13/start-meeting-assistant.git
cd meetfroge
nvm use
npm ci        # npm ci, not npm install — the lockfile is authoritative
npm run dev
```

## Bundled binaries

MeetFroge ships three native binaries. In development they are fetched into `resources/bin/`
(gitignored) and verified against `binaries.lock.json`:

```bash
npm run fetch:binaries
```

| Binary | Source | Notes |
|---|---|---|
| `ffmpeg` | gyan.dev full build (GPL) | includes libx264, AMF, ddagrab |
| `whisper-cli` | ggml-org/whisper.cpp | official release has **no Vulkan build for Windows** |
| `llama-server` | ggml-org/llama.cpp | official releases include Vulkan |

### Building whisper.cpp with Vulkan

There are no official Windows Vulkan binaries for whisper.cpp
([ggml-org/whisper.cpp#3673](https://github.com/ggml-org/whisper.cpp/issues/3673)). Two options:

**Community build** — [`jerryshell/whisper.cpp-windows-vulkan-bin`](https://github.com/jerryshell/whisper.cpp-windows-vulkan-bin).
Convenient, but verify the checksum and understand you are trusting a third-party build.

**From source** — preferred for anything shipped:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

Verify the Vulkan backend is actually in use — the binary falls back to CPU silently if not:

```bash
./build/bin/whisper-cli -m models/ggml-large-v3-turbo-q5_k.bin -f sample.wav 2>&1 | grep -i vulkan
```

> **Note for AMD integrated graphics.** The reported ~12× iGPU speedup was measured on a
> Radeon 680M (RDNA2). The reference machine has a Vega 7 (GCN5), which is an older
> architecture. **Measure on your own hardware** — see [benchmarks.md](benchmarks.md) B-007/B-008.
> Do not assume the published figure transfers.

### Selecting the right Vulkan device

`vulkaninfo --summary` on the reference machine lists three devices, two of which are Microsoft
D3D12 mapping layers ("Dozen"). Inference must target the **native AMD driver** device, not the
mapping layer. Set `GGML_VK_VISIBLE_DEVICES` if auto-selection picks wrong.

## Models

Downloaded on first run through the app. For development:

```bash
npm run fetch:models -- --tier accelerated
```

| Model | File | Size |
|---|---|---|
| Whisper large-v3-turbo | `ggml-large-v3-turbo-q5_k.bin` | ~570 MB |
| Qwen3-4B-Instruct | `qwen3-4b-instruct-q4_k_m.gguf` | ~2.5 GB |
| SmolVLM2-2B + mmproj | `smolvlm2-2b-q4_k_m.gguf` + `mmproj-*.gguf` | ~1.5 GB |
| sherpa-onnx VAD + segmentation + embedding | `.onnx` | ~110 MB |
| Tesseract English | `eng.traineddata` | ~15 MB |

All are SHA-256 verified against `models.lock.json` before use. A mismatch deletes the file.

## Dev staging for the transcription pipeline (Phase 3+)

The app resolves binaries from `resources/bin/` and models from
`%APPDATA%\meetfroge\models\` (override with `MEETFROGE_MODELS_DIR`). Stage them once:

```bash
# whisper-cli + DLLs (official CPU release; Vulkan build replaces it when available)
mkdir -p resources/bin
cp spikes/03-whisper-vulkan/bin-cpu/Release/whisper-cli.exe resources/bin/
cp spikes/03-whisper-vulkan/bin-cpu/Release/*.dll resources/bin/

# models — hardlink to avoid duplicating 550 MB on the same volume
mkdir -p "$APPDATA/meetfroge/models"
ln -f spikes/03-whisper-vulkan/models/ggml-large-v3-turbo-q5_0.bin "$APPDATA/meetfroge/models/"
curl -L -o "$APPDATA/meetfroge/models/ggml-silero-v5.1.2.bin" \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

VAD is whisper-cli's built-in silero integration (`--vad`), so Phase 3 needs no sherpa-onnx;
sherpa arrives in Phase 4 for diarization.

### Diarization models (Phase 4)

`sherpa-onnx-node` ships prebuilt N-API binaries (no toolchain needed). Its native DLLs live in
`node_modules/sherpa-onnx-win-x64` and must be on `PATH` before the addon loads — the diarize
stage handles that. **Packaging note (Phase 10): `.node`/`.dll` files cannot load from asar —
`sherpa-onnx-*` needs `asarUnpack`.**

```bash
cd "$APPDATA/meetfroge/models"
curl -L -o seg.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
tar xjf seg.tar.bz2 && mv sherpa-onnx-pyannote-segmentation-3-0/model.onnx pyannote-segmentation-3-0.onnx && rm -rf sherpa-onnx-pyannote-segmentation-3-0 seg.tar.bz2
# note: "recongition" is the real (misspelled) tag name in the sherpa-onnx repo
curl -L -o 3dspeaker-eres2net-base.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
```

Standalone check without the app: `node spikes/05-diarize/diarize-test.cjs <16k-mono.wav>`.

## E2E harnesses

All write JSON verdicts to `out/` and communicate via exit codes (M-004):

| Command | Proves |
|---|---|
| `node scripts/smoke.mjs` | boot, probe, enumeration, crash recovery report |
| `MEETFROGE_AUTOREC=30 electron .` | unattended 4-stream recording → `out/e2e.json` |
| `MEETFROGE_AUTOREC=30 MEETFROGE_AUTOPAUSE=1 electron .` | pause/resume path |
| `node scripts/sync-test.mjs` | mic↔system alignment (tone burst, cross-correlation) |
| `node scripts/transcribe-test.mjs` | **full pipeline with real speech** — asserts the transcript CONTENT |
| `MEETFROGE_SEGTIME=8` + kill + `MEETFROGE_SMOKE=1` relaunch | crash recovery (see docs/testing.md) |

## Environment overrides

Copy `.env.example` to `.env`. There are no secrets — the app makes no authenticated network
calls. The useful ones for development:

```bash
LOG_LEVEL=debug
MEETFROGE_FORCE_ENCODER=libx264   # test the software fallback ladder
MEETFROGE_DISABLE_VULKAN=1        # test the CPU inference path
MEETFROGE_DATA_DIR=D:\meetfroge   # relocate data off the system drive
```

## Running the spikes

Phase 0 spikes are standalone and live in `spikes/`. They do not import app code.

```bash
npm run spike:1   # Electron loopback audio — the hard gate
npm run spike:2   # PCM → ffmpeg stdin pipe, drift measurement
npm run spike:3   # whisper.cpp Vulkan vs CPU benchmark
npm run spike:4   # llama.cpp Vulkan vs CPU benchmark
```

Record every result in [benchmarks.md](benchmarks.md), and log every non-obvious failure in
[MISTAKES.md](../MISTAKES.md).

## Common setup problems

**`better-sqlite3` fails to build.** Install Visual Studio Build Tools 2022 with the "Desktop
development with C++" workload, then `npm rebuild better-sqlite3`.

**`h264_amf` fails with `SubmitInput() failed with error 18`.** Expected on the naive filter
chain — the NV12 conversion is mandatory. See [MISTAKES.md](../MISTAKES.md) M-001.

**Loopback audio records silence.** Check the Electron version first — it is pinned to 44 for
exactly this reason, and 40.1.0 reportedly regressed. See MISTAKES.md M-003.

**Vulkan not detected.** Update the GPU driver. Confirm with `vulkaninfo --summary` that a native
vendor driver is listed, not just the Microsoft D3D12 mapping layers.

More in [troubleshooting.md](troubleshooting.md).
