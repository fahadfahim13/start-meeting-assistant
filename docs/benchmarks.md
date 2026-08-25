# Benchmarks

Every measured number, with the command that produced it and the date. Appended to as work
proceeds. **Nothing in this file is estimated** — estimates belong in the plan, measurements
belong here.

Purpose: prevent guessing about performance later, and provide the evidence base for the
first-run wizard's model-tier recommendations.

---

## Reference machine — `REF-01`

| | |
|---|---|
| Label | `REF-01` |
| OS | Windows 11 Pro 10.0.26200 |
| CPU | AMD Ryzen 5 5500U — 6C/12T, Zen 2, 15 W TDP |
| RAM | 23.3 GB DDR4 dual channel (~35 GB/s effective) |
| GPU | AMD Radeon integrated, PCI `0x164C` (Lucienne, Vega 7, GCN5 / gfx90c) |
| Vulkan | `AMD Radeon(TM) Graphics`, AMD proprietary driver 22.20.44.08, VK 1.3.217 |
| Disk | C: 77.5 GB free / 328 GB · D: 12.8 GB free |
| ffmpeg | 8.1.1 gyan full build (GPL) |
| Node | 22.13.1 |

All measurements below are on `REF-01` unless stated otherwise.

---

## Capture and encoding

### B-001 — Screen capture and encoder path viability

**Date:** 2026-08-25 · **Method:** 2-second encode to `-f null -`, checking exit status and stderr.

| Path | Result | Notes |
|---|---|---|
| `ddagrab` → `h264_amf` (direct) | ❌ **FAIL** | `SubmitInput() failed with error 18`, 0 frames. See MISTAKES.md M-001 |
| `ddagrab` → `hwdownload,format=bgra,format=nv12,hwupload` → `h264_amf` | ✅ **PASS** | exit 0, clean. **This is the production recipe** |
| `gdigrab` → `h264_amf` | ✅ **PASS** | exit 0. Simpler; used for window capture |
| `ddagrab` → `hwdownload,format=bgra` → `libx264 -preset ultrafast` | ✅ **PASS** | exit 0, benign non-monotonic DTS warning. Software fallback |

Commands:

```bash
# FAIL
ffmpeg -init_hw_device d3d11va -filter_complex "ddagrab=0:framerate=15" \
  -c:v h264_amf -t 2 -f null -

# PASS — production recipe
ffmpeg -init_hw_device d3d11va \
  -filter_complex "ddagrab=0:framerate=15,hwdownload,format=bgra,format=nv12,hwupload" \
  -c:v h264_amf -t 2 -f null -

# PASS
ffmpeg -f gdigrab -framerate 15 -i desktop -c:v h264_amf -t 2 -f null -

# PASS — software fallback
ffmpeg -init_hw_device d3d11va \
  -filter_complex "ddagrab=0:framerate=15,hwdownload,format=bgra" \
  -c:v libx264 -preset ultrafast -t 2 -f null -
```

**Conclusion.** Hardware H.264 encoding works on `REF-01`, but only with an explicit NV12
conversion. Encoder availability must be probed by executing a real encode — `ffmpeg -encoders`
lists `h264_amf` on this machine and the naive path still fails.

### B-002 — Available capture devices

**Date:** 2026-08-25 · **Command:** `ffmpeg -list_devices true -f dshow -i dummy`

| Device | Type |
|---|---|
| `HP TrueVision HD Camera` | video |
| `OBS Virtual Camera` | none (registered but inactive) |
| `Microphone Array (AMD Audio Device)` | audio |

**No system-audio source exists.** No Stereo Mix, no `virtual-audio-capturer`. This measurement
is the basis for ADR-002. See MISTAKES.md M-002.

### B-003 — Available encoders

**Date:** 2026-08-25 · **Command:** `ffmpeg -encoders`

Present and relevant: `h264_amf`, `hevc_amf`, `av1_amf`, `libx264`, `libx265`.
Also listed but unusable on this hardware: `h264_nvenc`, `h264_qsv` and their variants — ffmpeg
lists all compiled-in encoders regardless of hardware. Reinforces B-001's conclusion.

### B-004 — Vulkan devices

**Date:** 2026-08-25 · **Command:** `vulkaninfo --summary`

| Device | Type | Driver | API |
|---|---|---|---|
| GPU1 · `AMD Radeon(TM) Graphics` | integrated | AMD proprietary 22.20.44.08 | 1.3.217 |
| GPU0 · `Microsoft Direct3D12 (AMD Radeon Graphics)` | integrated | Dozen / Mesa 26.3.0-devel | 1.2.358 |
| GPU2 · `Microsoft Direct3D12 (Basic Render Driver)` | CPU | Dozen / Mesa | 1.2.358 |

**Conclusion.** A real hardware Vulkan device is present (GPU1). whisper.cpp and llama.cpp
Vulkan offload are viable. GPU0 and GPU2 are D3D12 mapping layers and must not be selected —
device selection has to target the native AMD driver explicitly.

---

## Pending measurements

To be filled by Phase 0b spikes. **Do not populate from estimates.**

| ID | Measurement | Status | Expectation (to be confirmed or refuted) |
|---|---|---|---|
| B-005 | Electron 44 loopback audio: non-silent capture | ⬜ spike 1 | Works; this is the hard gate |
| B-006 | PCM → ffmpeg stdin: drift over 5 min, underrun count | ⬜ spike 2 | < 100 ms drift, zero underruns |
| B-007 | whisper.cpp `large-v3-turbo`, CPU, 10 min audio | ⬜ spike 3 | ~0.3× realtime |
| B-008 | whisper.cpp `large-v3-turbo`, Vulkan, 10 min audio | ⬜ spike 3 | 3–4× realtime — **but measured on RDNA2; Vega 7 is GCN5, may differ substantially** |
| B-009 | llama.cpp Qwen3-4B Q4_K_M, CPU: prompt / generation t/s | ⬜ spike 4 | ~34 / ~10 t/s |
| B-010 | llama.cpp Qwen3-4B Q4_K_M, Vulkan: prompt / generation t/s | ⬜ spike 4 | ~76 / ~10 t/s (generation is bandwidth-bound, offload does not help it) |
| B-011 | Recording CPU and RAM at Balanced preset | ⬜ Phase 1 | < 15% CPU, < 400 MB RAM |
| B-012 | VAD speech ratio on real meeting audio | ⬜ Phase 3 | 40–60% silence removed |
| B-013 | Keyframe count for a 20-slide, 30-minute deck | ⬜ Phase 5 | 18–25 keyframes |
| B-014 | tesseract.js OCR, 1080p keyframe | ⬜ Phase 5 | 1–2 s/frame |
| B-015 | VLM caption, SmolVLM2-2B, Vulkan | ⬜ Phase 5 | 3–5 s/keyframe |
| B-016 | Full pipeline, 1 h meeting, end to end | ⬜ Phase 6 | < 40 min |

---

## Recording method

When adding an entry:

1. State the machine label. If it is not `REF-01`, add a machine profile block above.
2. Give the **exact command**, copy-pasteable.
3. Give the raw result, not a rounded summary.
4. State what it means for the design — a number without a conclusion is not useful.
5. If it contradicts an expectation, say so explicitly and open a `MISTAKES.md` entry if the
   expectation came from an assumption rather than a measurement.
