# Spikes

Phase 0b de-risking experiments. **Throwaway code** — these do not import from `src/` and are not
part of the shipped application. Their only job is to produce measurements and yes/no answers
before the architecture is committed to.

Every result goes in `docs/benchmarks.md`. Every non-obvious failure goes in `MISTAKES.md`.

| # | Spike | Question it answers | Status |
|---|---|---|---|
| 1 | `01-loopback/` | Can Electron 44 capture non-silent system audio on this machine? | not started |
| 2 | `02-pcm-pipe/` | Can that PCM feed ffmpeg stdin for 5 min without drift or underruns? | not started |
| 3 | `03-whisper-vulkan/` | How fast is whisper.cpp on a Vega 7 iGPU vs CPU? | not started |
| 4 | `04-llama-vulkan/` | How fast is Qwen3-4B on a Vega 7 iGPU vs CPU? | not started |

## Spike 1 is a hard gate

If Electron cannot capture system audio, ADR-002 is invalid and the capture architecture changes.
**Do not begin Phase 1 until spike 1 passes.** The fallback ladder, in order:

1. native `setDisplayMediaRequestHandler` with `audio: 'loopback'`
2. the `electron-audio-loopback` package
3. a virtual audio cable (VB-Cable / VoiceMeeter)
4. driving OBS Studio via obs-websocket
5. recording without system audio, with a prominent warning

## Notes

Spikes 3 and 4 measure hardware this project has not been benchmarked on before. The published
whisper.cpp iGPU speedup was measured on RDNA2; the reference machine is GCN5. **Measure, do not
assume** — and if the measurement contradicts the expectation, say so in `benchmarks.md`.
