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

---

## M-010 — use_wallclock_as_timestamps on the audio inputs breaks the whole recording

**Date:** 2026-08-25  **Area:** capture/sync  **Cost:** ~30 min, one broken test recording
**Symptom:** after adding `-use_wallclock_as_timestamps 1` to the mic and pipe inputs to unify
their clocks, the system-audio track came out EMPTY (sync harness: snr -Infinity), while the
same command without the flag records all four streams correctly.
**Cause:** wallclock stamps put the audio inputs at epoch-scale timestamps while ddagrab video
stays 0-based. The muxer cannot interleave streams ~1.7 billion seconds apart; the system
track never received a usable packet.
**Fix:** reverted. The underlying mic↔system offset (~120 ms systematic, occasional outliers,
mic always lagging — measured runs: 119 / 232 / 127 / 116 ms) is documented as risk R-11 and
deferred to Phase 2, where the candidates are a measured static `-itsoffset` on the system
input, `audio_buffer_size` reduction, and `aresample=async=1`.
**Verified:** revert → sync harness immediately back to 116.1 ms with all tracks present.
**Rule:** never change the timestamp DOMAIN of a subset of inputs feeding one muxer. Align
clocks either for every input or for none. And a sync "fix" that has not been re-measured is
not a fix (the harness caught this in one run).

---

## M-011 — Lossless concat silently dropped the camera and system-audio tracks

**Date:** 2026-08-26  **Area:** capture/finalize  **Cost:** one E2E cycle
**Symptom:** the first segmented-pipeline E2E produced a final file with 1 video + 1 audio
track. The segments contained all four.
**Cause:** `ffmpeg -f concat -i list -c copy out.mkv` without `-map` uses default stream
selection: ONE "best" video stream and ONE "best" audio stream. The camera track and the
system-audio track were discarded without any warning or error.
**Fix:** `-map 0` on the concat command.
**Verified:** E2E re-run — 2 video + 2 audio tracks in the final file; crash-recovery E2E
confirms the same through the recovery path.
**Rule:** any ffmpeg invocation that must preserve ALL streams needs an explicit `-map 0`.
Default stream selection is lossy by design. And E2E checks must assert track COUNTS, not
just success — that assertion is what caught this.

---

## M-012 — sherpa-onnx readWave fails inside Electron: "External buffers are not allowed"

**Date:** 2026-08-26  **Area:** pipeline/diarization  **Cost:** one E2E cycle to find, isolated in one more
**Symptom:** diarization worked perfectly in plain Node (spike 05), then threw
`External buffers are not allowed` inside the Electron app. The stage's degradation path
correctly skipped it and kept the You/Others split — the failure was graceful, but the
feature was silently absent.
**Cause:** Electron's V8 memory cage forbids `napi_create_external_buffer`. sherpa-onnx's
`readWave()` returns samples through an external buffer. Everything else in the addon —
constructing the diarizer, `process()` consuming a plain `Float32Array` — is fine.
**Fix:** read the WAV ourselves (a 30-line RIFF chunk-walker producing a normal
`Float32Array`) and call `process()` with that. Verified inside real Electron: 2 speakers,
correct turns, 10.1 s for 29 s of audio.
**Verified:** `/tmp/sherpa-check` harness — `readWave` throws, manual parse + `process()`
returns the full turn list. Then the app-level E2E.
**Rule:** a native addon that passes in plain Node can still fail inside Electron — test
native addons IN Electron before integrating, and when one fails, isolate WHICH call is
affected before replacing the whole dependency. One 30-line reader saved the addon.
Also (again, see M-shell history): never write Windows paths with backslashes inside
bash-heredoc'd JS — two escaping layers eat them. Forward slashes work everywhere.

---

## M-013 — "Model available" meant "file exists", so a half-downloaded model crashed the stage

**Date:** 2026-08-26  **Area:** pipeline/models  **Cost:** one E2E cycle
**Symptom:** the VLM stage reported the models available and started llama-server, which
exited 1 during startup. The mmproj file was 120 MB of an expected 592 MB — still downloading.
**Cause:** `modelAvailable()` checked `existsSync` only. A file being written IS a file that
exists. This is M-009's lesson (a download is done when the byte count matches, not when a
file appears) resurfacing at the CONSUMER side of the same data.
**Fix:** the model registry now carries the exact expected byte size per model, and both
`modelAvailable()` and `resolveModel()` verify it — a partial file reports unavailable with a
logged reason, and the stage skips honestly instead of failing. Phase 7's manager adds SHA-256.
**Verified:** re-run with the mmproj still partial — vlm job state 'skipped', not 'failed'.
**Rule:** existence is not integrity. Every artifact both produced and consumed asynchronously
needs its validity CHECKED at the consumer, not assumed from presence — the producer's
verification does not protect a consumer that can run mid-write.

---

## M-014 — Windows denies focus to background launches: the E2E recorded the wrong window

**Date:** 2026-08-26  **Area:** testing/visual  **Cost:** one E2E cycle
**Symptom:** the slideshow E2E opened its browser page mid-recording, but the keyframes showed
the pre-existing foreground window; OCR faithfully read an editor screen. Change detection
"failed" with 2 keyframes because the screen genuinely never changed.
**Cause:** Windows foreground-lock: a process launched from the background may not steal focus
from the active window. `start /max page.html` opened the slideshow BEHIND everything.
**Fix:** invert the ordering — open the slideshow foreground FIRST, then launch the app, which
minimizes itself once recording starts (MEETFROGE_MINIMIZE hook) so the previous foreground
window (the slides) returns to front.
**Rule:** a screen-capture test must control what owns the screen, and the OS actively fights
focus manipulation. Arrange the stage before the camera rolls instead of trying to swap props
mid-shot. Also: when a visual assertion fails, look at WHAT was captured before doubting the
detector — the OCR text named the actual foreground window and diagnosed the whole failure.

---

## M-015 — A 2B VLM ignores format instructions: the parser found nothing in perfect answers

**Date:** 2026-08-26  **Area:** pipeline/vlm  **Cost:** one pipeline cycle + a curl session
**Symptom:** the vlm job finished 'done' with 0 captions. Debugging the endpoint directly
showed the model answering PERFECTLY — it described "ALPHA" and "slide 1 of 6" accurately —
but in free prose, ignoring the requested `TYPE:`/`CAPTION:` two-line format entirely.
The parser required those markers and extracted null from a correct answer.
**Cause:** SmolVLM2-2.2B does not follow multi-field output-format instructions. Format
compliance is a capability that small models often lack; the parser assumed it.
**Fix:** ask ONE thing ("describe this screenshot in one or two sentences") and treat the
whole reply as the caption; infer the scene type from caption keywords instead of requesting
it as a field. No second image call — image encoding dominates cost (1 382 prompt tokens per
frame).
**Verified:** curl probe first (isolates model-vs-code), then the synthetic pipeline run.
**Rule:** with small models, the OUTPUT CONTRACT is part of the model choice — validate that
the model actually honors your format before building a parser on it, and when a stage
returns "success with zero results", suspect the parser before the model. Also: per-item
catch-and-continue loops need a visible error counter; 6 silent failures looked like 'done'.

---

## M-016 — A cache guard caused a probe storm: 20 s recordings captured 2 s

**Date:** 2026-08-26  **Area:** capture/probe  **Cost:** ~1 h of instrumented bisecting
**Symptom:** with MEETFROGE_FORCE_ENCODER=libx264, a 20 s E2E produced a 1.5-2 s recording
with all four tracks intact. Standalone reproductions of the identical ffmpeg graph — plain,
segmented, and with a fed named pipe — all held realtime, refusing to reproduce it.
**Cause:** watching segment-file creation live gave the smoking gun: ffmpeg spawned ~20 s
AFTER the session started. The forced-encoder cache guard (added to stop the forced ladder
from poisoning the disk cache) bypassed caching entirely, so probeCapabilities() re-ran the
full ~6 s probe suite on EVERY call — and the session path calls it three times (validate,
start, spawnRun). ~18 s of serialized probing pushed the spawn to just before the stop timer.
The freeze theory, the muxer theory and the encoder-throughput theory were all wrong; the
recording was fine — it just started late.
**Fix:** in-memory memoization for the process lifetime (disk cache still skipped under
force). This also fixed a LATENT real bug: any cache-invalid first run (fresh install, ffmpeg
update) paid 3x probes before its first recording.
**Verified:** forced-libx264 E2E now records 18.6/20 s with 2v+2a. The E2E ok-gate was also
tightened to require >= 60% of the requested duration — the original bug PASSED the old gate.
**Rule:** when output is truncated, check WHEN the producer started before theorizing about
why it stalled. And an E2E that asserts "some output exists" will bless a recording that
missed 90% of the meeting — assert against the REQUESTED quantity.

---

## M-017 — Hand-whitelisting node_modules broke the packaged app with an invisible Error dialog

**Date:** 2026-08-26  **Area:** packaging  **Cost:** ~1.5 h of bisecting through wrong theories
**Symptom:** the packaged app "hung": no logs, no smoke output, no crash, process alive
forever. Dev build worked perfectly. Fuse theories (asar integrity, then all fuses) were
bisected and disproven. The give-away came from process inspection: a SINGLE process (no
GPU/renderer children) whose main window title was "Error" — Electron's native module-load
failure dialog, modal, waiting for a click nobody could give.
**Cause:** the electron-builder `files` list used `!node_modules/**` plus a hand-picked
whitelist of six packages. Their TRANSITIVE dependencies (tesseract.js alone pulls ~10) were
excluded, so the packaged main died at require(). Also stacked on M-017a: the smoke harness
originally wrote into `app.getAppPath()/out` — read-only inside asar.
**Fix:** delete the hand-curation; electron-builder computes the production dependency
closure itself. Harness output moved to userData when packaged.
**Verified:** packaged win-unpacked smoke: exit 0, h264_amf probed, 10 screens enumerated.
**Rule:** never hand-curate a dependency closure a tool already computes — you will maintain
it wrong exactly once. And for a GUI-subsystem app, "hangs silently" often means "a modal
dialog is showing where no one can see it": check the WINDOW TITLE and child-process tree
before theorizing. Dev-vs-packaged behavioral differences come from the package, not the code
— bisect the package inputs.

---

## M-019 — Two active audio outputs: playback and loopback landed on different endpoints

**Date:** 2026-08-26  **Area:** capture/audio  **Cost:** two "inconclusive" sync runs during the
final verification sweep
**Symptom:** the sync harness reported "burst not found in the system track" while the MIC
track clearly heard the burst acoustically — sound played audibly, loopback recorded 23.6 s of
pure digital zeros.
**Cause:** the user plugged in headphones mid-evening (the endpoint registry showed Headphone
going from "unplugged" in the morning scan to ACTIVE now). With two active render endpoints,
the tone played through one while Chromium's WASAPI loopback captured the other. Every
component behaved correctly; the topology changed underneath them. Timing matched exactly:
diarization passed at 21:10, sync failed at 21:35.
**Fix:** the harness now counts active render endpoints up front and warns with instructions
instead of failing mysteriously. The production app already carries the right defence — the
pre-flight System level meter shows silence BEFORE recording starts, and
troubleshooting.md documented this exact scenario in advance.
**Rule:** an audio pipeline's ground truth includes the ENDPOINT TOPOLOGY, which the user can
change at any moment by plugging in a cable. Diagnostics that compare an acoustic path (mic)
against a digital path (loopback) can localize this in one look — the mic hearing what
loopback misses says "wrong endpoint", not "broken capture".
