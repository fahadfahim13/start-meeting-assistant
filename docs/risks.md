# Risk register

Live document. Reviewed at the end of each phase. A risk that has been retired keeps its row,
marked `retired`, with the evidence that retired it — so the reasoning stays visible.

**Severity:** 🔴 critical (blocks the product) · 🟠 high (blocks a phase) · 🟡 medium (degrades quality)

---

## Active

### R-01 · Electron loopback audio broken on the pinned version 🔴

**Probability:** medium · **Phase:** 0, 1 · **Status:** open — this is the Phase 0 gate

Desktop audio is a critical requirement and Chromium loopback is the only driver-free way to get
it on Windows. Electron loopback support is version-fragile; 40.1.0 reportedly regressed
desktop-capture audio to silence
([electron#49607](https://github.com/electron/electron/issues/49607)).

**Mitigation.** Phase 0 spike 1 is a hard gate — no app code until it passes. Electron version
pinned exactly. CI smoke test guards against regression on upgrade. Five-rung fallback ladder:
native loopback → `electron-audio-loopback` → virtual audio cable → obs-websocket → record
without system audio and warn loudly.

**Trigger for escalation.** If spike 1 fails, stop and revisit ADR-002 before writing app code.

### R-02 · whisper.cpp Vulkan slow or broken on Vega 7 🟠

**Probability:** medium · **Phase:** 0, 3 · **Status:** open

The published ~12× iGPU speedup was measured on a Radeon 680M (RDNA2). The reference machine has
a Vega 7 (GCN5), two architecture generations older. The speedup may be much smaller, or the
Vulkan path may be unstable.

**Mitigation.** Spike 3 measures it directly rather than assuming. CPU fallback is functional at
~0.3× realtime — a 1-hour meeting would take ~3 hours, which is slow but not broken. If Vulkan
disappoints, drop the default model tier to `medium` or `small` and adjust the first-run
recommendation accordingly.

### R-03 · A/V drift over long recordings 🟠

**Probability:** medium · **Phase:** 1, 2 · **Status:** open

Four independent capture sources (screen, camera, mic, loopback PCM) with different clocks.
Drift accumulates and is most visible at the end of long recordings, where it is also most
expensive to discover.

**Mitigation.** Segmented recording bounds accumulation to 5 minutes. A sync harness measures
offset with a clapper/tone test and applies `-itsoffset` correction. Re-sync at segment
boundaries. Verification requires a 30-minute test, not a 30-second one.

### R-04 · h264_amf failing on other AMD drivers 🟠

**Probability:** medium · **Phase:** 1 · **Status:** partially mitigated

Already failed once on the reference machine via the naive filter chain (MISTAKES.md M-001).
Other driver versions may fail differently, and `ffmpeg -encoders` lists encoders that do not work.

**Mitigation.** Capability probe executes a **real one-second encode** rather than reading the
encoder list. Full fallback ladder down to `libx264`. `capture_profile` records which encoder was
actually used, so quality reports are diagnosable.

### R-05 · PCM pipe underruns causing audio gaps 🟠

**Probability:** medium · **Phase:** 1 · **Status:** open

The renderer's audio thread must never block on ffmpeg stdin. A stall produces gaps or, worse,
shifts everything after it in the timeline.

**Mitigation.** Fixed 4-second ring buffer in main. Overflow drops oldest frames and increments a
visible counter. Underrun inserts silence to preserve timeline alignment — a gap must not shift
subsequent audio. Both conditions surface in the UI rather than failing silently.

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
override. Transcript is editable. **The UI states the limitation plainly** — this is part of the
feature, not a disclaimer. Improving this is tracked in ROADMAP under consideration.

### R-08 · Disk exhaustion 🟡

**Probability:** high · **Phase:** 2, 7 · **Status:** mitigated by design

77.5 GB free on C: is roughly 44 hours at the Balanced preset. D: has only 12.8 GB.

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

*None yet. Risks move here with the evidence that retired them — typically a benchmark ID or a
passing verification step.*
