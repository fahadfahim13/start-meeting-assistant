# Spike 3 — whisper.cpp CPU vs Vulkan

**Question:** how fast is whisper.cpp transcription on this machine's Vega 7 (GCN5) iGPU
compared to CPU-only?

This is the single biggest open performance question in the project. The published "12× iGPU
speedup" (whisper.cpp 1.8.3) was measured on a **Radeon 680M — RDNA2, two architecture
generations newer** than this machine's Vega 7. If it transfers, transcription runs at ~3–4×
realtime and the product feels responsive. If it does not, transcription runs at ~0.3× realtime
and a 1-hour meeting takes ~3 hours. **Measure, do not assume.**

## Status

| Measurement | Binary | Status |
|---|---|---|
| B-007 CPU baseline | official `whisper-bin-x64.zip` v1.9.2 | runnable now |
| B-008 Vulkan | **must be built from source** — no official Windows Vulkan release ([#3673](https://github.com/ggml-org/whisper.cpp/issues/3673)) | blocked on toolchain |

The Vulkan build needs VS 2022 Build Tools + CMake + Vulkan SDK:

```powershell
# elevated:
pwsh -ExecutionPolicy Bypass -File ..\..\scripts\install-build-toolchain.ps1
```

Then:

```bash
git clone https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
cd /tmp/whisper.cpp
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
# copy build/bin/Release/* into bin-vulkan/
```

## Setup (CPU baseline)

```bash
mkdir -p bin-cpu models samples
curl -L -o bin-cpu/whisper-cpu.zip \
  https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip
cd bin-cpu && unzip -o whisper-cpu.zip && cd ..

curl -L -o samples/jfk.wav \
  https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav

curl -L -C - -o models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

npm run bench:cpu
```

## Method notes

- Benchmark audio is jfk.wav looped to 10 minutes. Real speech, deterministic, no external
  account needed. Looped speech is fine for **throughput** measurement (the encoder runs on
  fixed 30 s windows regardless); it says nothing about accuracy, which is Phase 3's concern.
- 10 minutes amortizes model-load time so the realtime factor is honest. A 30-second test would
  overweight the fixed startup cost.
- The harness greps whisper's startup output for the backend actually in use — the binary
  **falls back to CPU silently** if Vulkan is unavailable, which would otherwise produce a fake
  "Vulkan" number that is really a CPU number.
- CPU-vs-Vulkan caveat: the two binaries are different builds (official CPU release vs local
  Vulkan build), so compiler differences are a confound. If the Vulkan result is surprising,
  cross-check by running the Vulkan build with `-ng` (GPU disabled) as the CPU baseline instead.

## Reading the result

`out/result-cpu.json` and `out/result-vulkan.json`. Key number: `realtimeFactor` — audio
seconds transcribed per wall-clock second. 1.0 = realtime. Product implications at 0.3× vs 3×
are night and day; see `docs/risks.md` R-02.
