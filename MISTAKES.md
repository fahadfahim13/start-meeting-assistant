# MISTAKES.md

A running log of things that broke, why, and the rule that prevents the next instance.

**Read this before touching capture or ffmpeg code.**

Capture-engine work is a long sequence of subtle, expensive-to-rediscover failures.
This file exists so each one is paid for exactly once.

## Entry format

```
## M-NNN — one-line title
**Date:** YYYY-MM-DD  **Area:** subsystem  **Cost:** time lost or impact
**Symptom:** what was actually observed
**Cause:** the real mechanism
**Fix:** what resolved it
**Verified:** the exact command or test proving the fix
**Rule:** the generalizable lesson  <- this is the part that matters
```

The `Rule` line is the point of the entry. A fix without a rule will be rediscovered.

---

## M-001 — h264_amf rejects ddagrab output directly

**Date:** 2026-08-25  **Area:** capture/ffmpeg  **Cost:** ~1h
**Symptom:** `SubmitInput() failed with error 18`, `Error submitting video frame to the encoder`,
0 frames encoded, "Output file is empty".
**Cause:** `ddagrab` emits BGRA D3D11 surfaces. AMF requires NV12. The formats are incompatible
and the error message names neither of them.
**Fix:** insert an explicit format conversion between capture and encode:
`hwdownload,format=bgra,format=nv12,hwupload`
**Verified:**
```
ffmpeg -init_hw_device d3d11va \
  -filter_complex "ddagrab=0:framerate=15,hwdownload,format=bgra,format=nv12,hwupload" \
  -c:v h264_amf -t 2 -f null -
# exit 0, no errors
```
Failing form for comparison:
```
ffmpeg -init_hw_device d3d11va -filter_complex "ddagrab=0:framerate=15" \
  -c:v h264_amf -t 2 -f null -
# SubmitInput() failed with error 18
```
**Rule:** never assume a hwaccel filter's output pixel format matches the encoder's input format.
Probe encoder support by **running a real 1-second encode**, never by reading `ffmpeg -encoders`.
`h264_amf` is listed as available on this machine and still fails on the naive path.

---

## M-002 — ffmpeg cannot capture desktop audio on Windows

**Date:** 2026-08-25  **Area:** capture/audio  **Cost:** architecture change (ADR-002)
**Symptom:** `ffmpeg -list_devices true -f dshow -i dummy` lists only
`Microphone Array (AMD Audio Device)`. No Stereo Mix, no `virtual-audio-capturer`,
no system-audio source of any kind.
**Cause:** ffmpeg has no WASAPI input backend. DirectShow exposes only *capture* endpoints,
not the *render* endpoints where the system mix lives. This is not a configuration problem —
the capability does not exist.
**Fix:** system audio is captured by Chromium's WASAPI loopback in the Electron renderer,
converted to s16le PCM in an AudioWorklet, and piped to ffmpeg stdin.
**Verified:** device enumeration above; architecture documented in ADR-002.
**Rule:** desktop audio is an OS-API problem, not an ffmpeg flag. Verify device availability
on the actual target machine before designing around it. "PipeWire has monitor sources"
does not generalize to Windows.

---

## M-003 — getDisplayMedia({video:false, audio:true}) throws on Windows

**Date:** 2026-08-25  **Area:** capture/audio  **Cost:** documented pre-emptively from research
**Symptom:** `NotSupportedError`, or a stream containing no audio track.
**Cause:** Chromium requires a video track to be requested for loopback audio to be attached.
Audio is not independently requestable from a display-capture source.
**Fix:** request `{video: true, audio: true}`, then immediately `.stop()` and discard the
video track, keeping only the audio track.
**Verified:** spike 1 on 2026-08-25. The `{video:true, audio:true}` + discard-video pattern
returns 1 video track and 1 audio track; the audio track carries the real system mix
(benchmarks B-005).
**Rule:** loopback audio rides along with a display capture; it is not a standalone source.
Also: Electron loopback is version-fragile (40.1.0 reportedly regressed to silence) —
pin the Electron version exactly and guard it with a CI smoke test.

---

## M-004 — Electron produces no stdout to the parent shell on Windows

**Date:** 2026-08-25  **Area:** tooling/CI  **Cost:** ~20 min, and would have silently
broken the CI smoke test
**Symptom:** `npm start` and `electron .` both exited 0 with **zero bytes** of captured output.
The app had in fact run correctly the whole time — it created its output directory, captured
1.29 MB of PCM and wrote `result.json`. None of its `console.log` output reached the terminal.
**Cause:** the Electron launcher on Windows is a GUI-subsystem binary. It is not attached to
the parent console, so main-process stdout and stderr go nowhere when spawned from a shell.
**Fix:** do not rely on stdout for spike or test results. Write results to a file
(`out/result.json`) and communicate pass/fail through the **process exit code**. For interactive
debugging, `electron . --enable-logging` routes output to the console.
**Verified:**
```bash
./node_modules/.bin/electron .     # exit 0, no stdout at all
cat out/result.json                # the actual result was here the whole time
```
**Rule:** on Windows, a GUI-subsystem process cannot be observed through stdout. Any automated
check involving Electron must assert on **exit codes and files**, never on captured console
output. This directly affects the loopback smoke test in `.github/workflows/ci.yml` — it asserts
via `--assert-non-silent` setting the exit code, which is correct; a log-grep assertion there
would have passed vacuously forever.

---

## M-005 — MKV exposes no per-stream duration, so naive drift measurement reports nothing

**Date:** 2026-08-25  **Area:** capture/verification  **Cost:** ~15 min, and produced a
**false FAIL** on an otherwise perfect recording
**Symptom:** spike 2 produced a flawless 60 s recording — 3 correct tracks, hardware encoded,
zero dropped PCM frames — and then reported `driftUnder100ms: false`.
**Cause:** `ffprobe -show_streams` returns `duration: null` for every stream in a Matroska file.
Matroska stores duration once at the container level, not per track. The drift calculation
therefore compared `null` values, `null < 100` evaluated false, and the verdict failed.
**Fix:** measure each track's end from the presentation timestamp of its **last packet**:
```bash
ffprobe -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 file.mkv | tail -1
```
Also account for the video track legitimately ending up to one frame interval earlier than
audio — at 15 fps that is 66.7 ms, which would otherwise look like drift.
**Verified:** on the same 60 s file — v:0 last PTS 59.933 (899 packets = exactly 15.000 fps),
a:0 59.997 (2999 packets), a:1 59.994 (3001 packets). Real mic↔system drift: **3 ms**.
**Rule:** never measure container-level properties per stream without checking that the
container actually stores them. And when a verification step fails on output that looks correct,
**suspect the measurement before suspecting the system** — a false FAIL that gets "fixed" by
loosening the threshold hides the real signal forever.

---

## M-006 — libopus warns "Queue input is backward in time" on dshow mic capture

**Date:** 2026-08-25  **Area:** capture/audio  **Cost:** none yet, but unresolved
**Symptom:** during a 5-minute recording, ffmpeg emitted **582** occurrences of
`[libopus @ ...] Queue input is backward in time` (~1.9 per second). Only one encoder
instance address appears in the log, so it is one stream, not both.
**Cause:** almost certainly the DirectShow microphone input. DirectShow device timestamps
jitter and can step backward; libopus notices and re-orders. The `pipe:0` input cannot be the
source - raw s16le carries no timestamps at all, so ffmpeg synthesises them from the byte count
at the declared 48 kHz, which is monotonic by construction.
**Impact measured, not assumed:** none observable. Zero ffmpeg errors, exactly 15 000 mic
packets for 300 s of 20 ms Opus frames, and 3 ms mic-to-system drift that did not grow between
the 60 s and 300 s runs.
**Fix:** not applied yet. Candidates for Phase 1, to be tested rather than guessed:
- `-use_wallclock_as_timestamps 1` on the dshow input
- `-af aresample=async=1` to absorb jitter by resampling
- `-fflags +genpts`
**Verified:** `grep -c "backward in time" out/ffmpeg.log` -> 582, alongside a clean verdict
in `out/result.json`.
**Rule:** a high-frequency warning that provably costs nothing is still a signal - record it
with its measured impact instead of silencing it. Do not add a suppression flag before knowing
which input is responsible, or the real defect gets hidden the day it starts to matter.

---

## M-007 — Camera preview starves ffmpeg: the recording dies with a misleading encoder error

**Date:** 2026-08-25  **Area:** capture/devices  **Cost:** ~40 min of hypothesis testing
**Symptom:** full-app E2E recording failed with `[vost#0:1/h264_amf] Task finished with error
code: -22 (Invalid argument)` on the CAMERA stream and "Nothing was written into output file".
Every isolated reproduction PASSED: camera→AMF solo, dual AMF sessions, dual AMF + real camera
in one graph, with MKV output. Only the full app failed.
**Cause:** the renderer's camera preview (getUserMedia) was still holding the camera when
ffmpeg's dshow input opened it. Cameras are EXCLUSIVE devices. The dshow input delivered zero
frames, the camera encoder was flushed empty at stop ('q') and died with EINVAL, and the MKV
muxer — interleaving by dts across all streams — wrote nothing at all because one stream never
produced a packet. One held device silently poisoned the entire four-stream recording.
**Fix:** two-part. (1) Preview effects tear down when recording starts. (2) A
`previewsSuspended` store flag set BEFORE `session:start` is invoked, with a 300 ms yield for
React effect cleanup — keying teardown on the post-spawn `recording` state releases the device
too late.
**Verified:** `MEETFROGE_AUTOREC=30` E2E — before: 0-byte file, exit 1. After: 4 streams,
28.7 s, hardware encoded, exit 0.
**Rule:** an exclusive device may have at most ONE owner, and ownership must be handed over
*before* the next owner opens it, not merely "around the same time". Also: when an encoder
error appears only in composition and never in isolation, look for a resource the composition
holds and the isolation does not.

---

## M-008 — Loopback ring pre-roll shifts the system-audio track

**Date:** 2026-08-25  **Area:** capture/sync  **Cost:** caught by the E2E drift check
**Symptom:** mic↔system end divergence of 407 ms in the app E2E, versus 3 ms in spike 2.
**Cause:** the renderer starts loopback BEFORE `session:start` so PCM is flowing when ffmpeg
opens the pipe. Those early frames sat in the ring and were flushed to ffmpeg on connect —
prepending audio that predates every other input's t=0, shifting the whole system track.
Spike 2 never saw this because its ffmpeg read the pipe immediately.
**Fix:** clear the ring at the moment ffmpeg connects. The stream then starts from "now",
aligned with the other inputs to within one frame (20 ms).
**Verified:** E2E divergence 407 ms → 56 ms, inside the 100 ms budget.
**Rule:** a buffer that exists to absorb jitter must not also carry HISTORY across a
lifecycle boundary. On attach, start clean.

---

## M-009 — Piped exit codes reported a truncated 2.5 GB download as success

**Date:** 2026-08-25  **Area:** tooling/downloads  **Cost:** one wasted benchmark run
**Symptom:** the Qwen model download task "completed, exit 0", but llama-bench failed with
`failed to load model`. The file was 1.66 GB of an expected 2.50 GB — truncated at 67%.
**Cause:** two stacked mistakes. (1) `curl --max-time 3000` hit its own timeout mid-transfer.
(2) The command was `curl ... | tail -1; echo EXIT=$?` — `$?` captured **tail's** exit code,
not curl's, so the timeout (exit 28) was invisible.
**Fix:** re-run with curl unpiped, capture `$?` directly, and compare the byte count against
the `content-length` from a HEAD request before declaring success.
**Verified:** HEAD reports 2 497 280 736 bytes; the check now compares against that exactly.
**Rule:** an exit code read after a pipeline belongs to the LAST command in it. And a download
is not "done" when the process exits — it is done when the byte count (better: the hash)
matches the expected value. This is precisely why the app's model manager (Phase 7 spec)
verifies size and SHA-256 before marking any model usable; this incident is the evidence.
