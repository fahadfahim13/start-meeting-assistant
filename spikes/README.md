# Spikes

Phase 0b de-risking experiments. **Throwaway code** — these do not import from `src/` and are not
part of the shipped application. Their only job is to produce measurements and yes/no answers
before the architecture is committed to.

Every result goes in `docs/benchmarks.md`. Every non-obvious failure goes in `MISTAKES.md`.

| # | Spike | Question it answers | Status |
|---|---|---|---|
| 1 | `01-loopback/` | Can Electron 44 capture non-silent system audio on this machine? | ✅ **PASS** — B-005 |
| 2 | `02-pcm-pipe/` | Can that PCM feed ffmpeg stdin for 5 min without drift or underruns? | ✅ **PASS 8/8** — B-006 |
| 3 | `03-whisper-vulkan/` | How fast is whisper.cpp on a Vega 7 iGPU vs CPU? | not started |
| 4 | `04-llama-vulkan/` | How fast is Qwen3-4B on a Vega 7 iGPU vs CPU? | not started |

## Spike 1 — gate cleared

Electron 44.0.0 captures the genuine system audio mix: 48 kHz stereo, 336 frames, sample
completeness 1.0031 (no drops), and the 440/660 Hz test tone verified at 6219× and 3286× the
noise floor. ADR-002 stands and the capture architecture is committed to.

```bash
cd spikes/01-loopback
npm install
npm start                          # runs 8s, writes out/result.json, exits 0/1
node verify-tone.js out/captured.pcm
```

**Reading the result: check `out/result.json` and the exit code, not stdout.** Electron is a
GUI-subsystem binary on Windows and prints nothing to the parent shell (MISTAKES.md M-004).

The fallback ladder is retained in case a future Electron upgrade regresses loopback:

1. native `setDisplayMediaRequestHandler` with `audio: 'loopback'` ← in use
2. the `electron-audio-loopback` package
3. a virtual audio cable (VB-Cable / VoiceMeeter)
4. driving OBS Studio via obs-websocket
5. recording without system audio, with a prominent warning

## Notes

Spikes 3 and 4 measure hardware this project has not been benchmarked on before. The published
whisper.cpp iGPU speedup was measured on RDNA2; the reference machine is GCN5. **Measure, do not
assume** — and if the measurement contradicts the expectation, say so in `benchmarks.md`.
