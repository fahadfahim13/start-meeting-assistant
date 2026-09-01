# Risk register

Live document. Reviewed at the end of each phase. A risk that has been retired keeps its row,
marked `retired`, with the evidence that retired it — so the reasoning stays visible.

**Severity:** 🔴 critical (blocks the product) · 🟠 high (blocks a phase) · 🟡 medium (degrades quality)

---

## Active

### R-04 · h264_amf failing on other AMD drivers 🟠

**Probability:** medium · **Phase:** 1 · **Status:** partially mitigated

Already failed once on the reference machine via the naive filter chain (MISTAKES.md M-001).
Other driver versions may fail differently, and `ffmpeg -encoders` lists encoders that do not work.

**Mitigation.** Capability probe executes a **real one-second encode** rather than reading the
encoder list. Full fallback ladder down to `libx264`. `capture_profile` records which encoder was
actually used, so quality reports are diagnosable.

### R-06 · WebRTC ↔ DirectShow device name mismatch 🟡

**Probability:** high · **Phase:** 1 · **Status:** open

`enumerateDevices()` and `ffmpeg -list_devices` do not use identical device name strings, and
Windows regenerates `deviceId` values across some driver updates.

**Mitigation.** Reconciliation table built from both sources, fuzzy fallback matching, and an
explicit user re-selection prompt when reconciliation fails. Devices remembered by both `deviceId`
and label.

### R-07 · Banglish transcription accuracy disappoints 🟡

**Probability:** high · **Phase:** 3 · **Status:** accepted, mitigated by expectation-setting

Code-switched Bengali-English is the hardest case for every open ASR model. Whisper flips
language mid-sentence and garbles switch points.

**Mitigation.** Default `-l en` keeps meeting substance intact (ADR-004). Per-meeting language
override. **Transcript is editable** — click any line to correct it; the search index follows the
correction and the line is marked as edited. That claim was in this entry from the start and was
**untrue until 2026-09-01**; see MISTAKES.md M-035. **The UI states the limitation plainly** —
this is part of the feature, not a disclaimer. Improving the model side is tracked in ROADMAP
under consideration.

### R-08 · Disk exhaustion 🟡

**Probability:** high · **Phase:** 2, 7 · **Status:** mitigated by design

77.5 GB free on C: is roughly **67 hours** at the Balanced preset — measured at 1.148 GB/hour
in [B-006](benchmarks.md), better than the 1.75 GB/h originally planned because meeting screens
are mostly static. D: has only 12.8 GB, so relocating storage there is a trap worth guarding.

**Mitigation.** Pre-flight estimate shown before recording ("≈ 6.2 hours available"). Live monitor
with a hard floor and clean auto-stop. Retention policy. "Keep transcript, delete video" option.
Storage migration with checksum verification.

### R-09 · Thermal throttling on a 15 W chip 🟡

**Probability:** high · **Phase:** 3, 9 · **Status:** mitigated by design

Sustained inference on a 15 W U-series part throttles, making processing times unpredictable.

**Mitigation.** Single-worker job queue by default. Thread count capped at `cores - 2`.
"Pause processing on battery" defaults on. Thermal backoff reduces thread count under sustained
high temperature. Jobs schedulable for idle time.

### R-10 · Solo-maintainer bus factor 🟡

**Probability:** — · **Phase:** all · **Status:** mitigated by process

**Mitigation.** ADRs preserve reasoning. `MISTAKES.md` preserves debugging cost. High coverage
targets on capture and pipeline. Documented setup including the awkward parts (Vulkan builds,
native addons). This is why the tracking files exist at all.

---

## Open items requiring a decision

| Item | Phase | Note |
|---|---|---|
| Windows code signing | 10 | Unsigned installers trigger SmartScreen. Recommendation: ship unsigned for v1.0 — conventional for open-source tools and genuinely $0. Azure Trusted Signing (~$10/mo) or an OV cert ($200–400/yr) are the alternatives. This is the only place where "$0" and "polished product" genuinely conflict. |
| Recording consent framing | 2, 10 | Always-visible indicator is the baseline control. Needs a first-run acknowledgement and `legal.md`. Awaiting user confirmation on framing. |
| Bangla UI localization | 9 | i18n infrastructure is built in regardless; shipping a translation for v1.0 is a separate call. |

---

## Retired

### R-02 · whisper.cpp Vulkan on Vega 7 🟠 → retired 2026-08-26

**Was:** the published ~12× iGPU speedup came from RDNA2; GCN5 might deliver far less, or the
Vulkan path might be unstable.

**Retired by:** [benchmarks B-008](benchmarks.md). Measured **2.144× realtime (2.98× over
CPU)** on the same 600 s audio, backend confirmed (`using Vulkan0 backend`), output
word-perfect. A 1-hour meeting lands at ~12–17 min with VAD — inside budget. The 12× did not
transfer (correct instinct), but the path is solid. Achieved with zero compilation: llama.cpp's
`ggml-vulkan.dll` loads into whisper.cpp's official build via ggml's dynamic-backend system.

**Residual:** the DLL pairing couples two releases' ggml ABIs — pin together, re-verify on
bumps via the backend's device line.

### R-01 · Electron loopback audio broken on the pinned version 🔴 → retired 2026-08-25

**Was:** desktop audio is a critical requirement and Chromium loopback is the only driver-free way
to get it on Windows. Electron loopback support is version-fragile; 40.1.0 reportedly regressed
desktop-capture audio to silence
([electron#49607](https://github.com/electron/electron/issues/49607)). This was the Phase 0 hard
gate — if it failed, ADR-002 was invalid and the capture architecture would have changed.

**Retired by:** [benchmarks B-005](benchmarks.md). Electron 44.0.0 (Chromium 152.0.7977.54)
captured 336 frames / 645 120 samples of real system audio at 48 kHz stereo with a sample
completeness of 1.0031 — no dropped frames. Goertzel analysis confirmed the captured stream
contains the 440 Hz and 660 Hz test tones at 6 219× and 3 286× the noise floor, with every other
probed frequency at floor. The capture is the genuine system mix.

**Residual risk, still guarded.** This validates Electron 44.0.0 only. The version is pinned,
Dependabot ignores `electron`, and the CI loopback smoke test asserts non-silent capture on every
PR. The five-rung fallback ladder (native loopback → `electron-audio-loopback` → virtual audio
cable → obs-websocket → record without system audio) remains documented in
[architecture.md](architecture.md) in case a future upgrade regresses.

---

### R-03 · A/V drift over long recordings 🟠 → retired 2026-08-25

**Was:** four independent capture sources (screen, camera, mic, loopback PCM) with different
clocks. Drift accumulates and is most visible at the end of long recordings, where it is also
most expensive to discover.

**Retired by:** [benchmarks B-006](benchmarks.md). Mic-to-system-audio divergence measured
**3 ms at 60 seconds and 3 ms at 300 seconds** — five times the duration, identical divergence.
Drift is bounded, not accumulating. An accumulating error would have shown roughly 15 ms at
300 s. Video landed 64 ms behind audio against a 66.7 ms frame interval, i.e. within one frame,
which is the expected bound rather than drift. Measured frame rate 14.997 against a 15.000
target (0.02% error).

**Residual risk.** Only the mic-plus-system-plus-screen combination has been measured, and only
to 5 minutes. Camera capture adds a fourth clock and is untested. The 3-hour case in the manual
test matrix (docs/testing.md) still needs running. Segmented recording remains in the design as
defence in depth: it bounds any future accumulation to one 5-minute segment regardless.

---

### R-05 · PCM pipe underruns causing audio gaps 🟠 → retired 2026-08-25

**Was:** the renderer's audio thread must never block on ffmpeg stdin. A stall produces gaps
or, worse, shifts everything after it in the timeline.

**Retired by:** [benchmarks B-006](benchmarks.md). Over a sustained 5-minute recording the
bridge delivered 15 058 frames / 57 822 720 bytes at a completeness of **1.0000** with **zero
ring-buffer drops**. Thirteen backpressure events occurred and were absorbed by the 4-second
ring exactly as designed — the mechanism was genuinely exercised rather than merely present.

**Residual risk.** Backpressure was exercised 13 times in 5 minutes under light system load.
Heavy load (transcription running concurrently, disk contention) has not been tested, though
ADR-006 makes that combination unlikely by design since processing is post-meeting. The drop
counter must surface in the UI so a future regression is visible rather than silent.

---

### R-11 · Mic ↔ system-audio relative start offset (VARIABLE ±1 s) 🟠 — escalated 2026-08-26

**Added:** 2026-08-25 · **Phase:** 2 · **Status:** open, measured, bounded

Each ffmpeg input's t=0 is its own open moment, so the mic (dshow) and system (named-pipe PCM)
tracks carry a relative offset. Measured by the sync harness (tone burst, digital vs acoustic
path, cross-correlation): **119 / 232 / 127 / 116 ms across four runs — mic always lags.**
Direction is stable; magnitude clusters at ~120 ms with occasional outliers suspected to be
correlation echo artifacts rather than real variance.

**Impact.** Transcript merging attributes words across the two tracks with up to ~0.2 s skew —
marginal at sentence granularity, visible at word granularity. Not a recording-integrity issue.

**Why not already fixed.** The obvious unification (`-use_wallclock_as_timestamps 1` on both
audio inputs) breaks the recording outright — see MISTAKES.md M-010.

**2026-08-26 harness-v4 re-measurement (reliable at last):** +1098 / −695 / −370 ms across
three same-build runs — variable AND sign-flipping (ffmpeg input-open race), so every static
or post-hoc correction candidate is dead. End-PTS difference tracks it only loosely (−112 vs
−370 ms on one file). Each track is internally accurate; summaries and action items are
unaffected; only cross-track interleaving order can jitter ~1 s.

**Actual fix (future work, scoped):** one clock for both audio paths — e.g. main-process-owned
system-audio writing with wall timestamps plus wallclock-stamped mic in a separate audio-only
ffmpeg process, muxed with video at finalize. A capture-graph redesign, not a flag.
