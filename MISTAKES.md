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

---

## M-020 — Loopback captured pure zeros when the render session started after capture

**Date:** 2026-08-26  **Area:** capture/audio + testing  **Cost:** a long evening of layered diagnosis
**Symptom:** the sync harness's system track was 23 s of exact digital zeros while the MIC
heard the burst acoustically. Meanwhile spike 1 (bare loopback) and an app recording with a
CONTINUOUS pre-started tone both captured sound perfectly. Same machine, same minute.
**Cause (layered):** first the real dual-endpoint condition (M-019, headphones), then — after
defaults were realigned programmatically via IPolicyConfig — the remaining trigger was the
harness's own pattern: it fired a single 0.6 s burst SECONDS AFTER loopback capture began.
A render session opening mid-capture did not reach this loopback stream; a session already
playing when capture starts is delivered reliably.
**Fix:** harness v3 — a 30 s burst TRAIN whose player starts BEFORE the app; v4 — whole-
envelope cross-correlation within ±half-period so the periodic train cannot alias to the
wrong repetition. The harness now measures every run.
**Verified:** sys-track burst snr went from 0.0 to 12 930.
**Rule:** to test loopback, have the render session ALIVE before capture starts. And when a
signal-injection test fails, A/B the injection pattern itself (continuous vs late one-shot)
before blaming the capture stack — three "capture bugs" here were one injection-pattern bug.

---

## R-11 escalation note (2026-08-26, harness v4 measurements)

Three same-build runs: **+1098 ms, −695 ms, −370 ms** — the mic↔system start offset varies by
±1 s AND flips sign between runs (ffmpeg input-open racing). A static itsoffset cannot fix
this. End-PTS difference tracks it only loosely (−112 ms vs −370 ms measured on one file), so
post-hoc file-based correction is also insufficient. Impact: cross-track interleaving order in
the merged transcript can jitter by ~1 s; each track is internally accurate, and summaries /
action items (sentence-level) are unaffected. Proper fix is a capture-graph redesign giving
both audio paths one clock — scoped as future work in docs/risks.md R-11.

---

## M-021 — h264_amf refuses frames under 128×128, so window capture died at frame 0

**Date:** 2026-08-31  **Area:** capture/ffmpeg  **Cost:** two recordings lost outright, ~40 min
**Symptom:** two window-source recordings ended `state='failed'` with `duration_ms` and
`media_bytes` NULL and zero pipeline jobs. The only trace was in ffmpeg's stderr:
`[vost#0:0/h264_amf] Terminating thread with return code -1313558101` … `frame= 0 … Conversion
failed!`. The same app recording a full screen worked perfectly, minutes apart.
**Cause (two, compounding):**
1. `h264_amf` will not initialise below **128×128**. It reports `encoder->Init() failed with
   error 5`, which ffmpeg surfaces as the uninformative `-22 (Invalid argument)`.
   Measured on REF-01: 128×128 OK, 320×126 FAIL, 126×240 FAIL, 160×120 FAIL. libx264 encodes
   every one of those sizes, so this is an AMF limit, not an h264 limit.
2. gdigrab captures a **minimised** window at its tiny restored-down size — a collapsed Slack
   window measured **181×25**. The builder mapped gdigrab's output straight to the encoder
   (`-map 1:v`) with no filter, so nothing stood between a 181×25 frame and AMF.
   One undersized video source therefore killed all four tracks.

**Not the cause:** the missing `format=nv12`, which was the first suspicion. Verified: a
full-desktop `gdigrab → h264_amf` chain with raw BGRA and no explicit format encodes fine
(`frame=29`, exit 0) — ffmpeg's auto-inserted conversion handles it. The size was the whole bug.

**Fix:** every video source now goes through a filter chain; `gdigrabFilter()` pads up to the
AMF floor and to even dimensions in one expression, `pad=ceil(max(iw,128)/2)*2:ceil(max(ih,128)/2)*2`
(commas escaped for the filter parser). **Pad, not scale** — upscaling a 181×25 strip would
silently produce a distorted frame and call it success. The raw `N:v` mapping is gone from the
builder entirely, so no future source can reach an encoder unfiltered.
Two supporting fixes landed with it: the capability probe now exercises gdigrab through the
**encoder production actually picks** (it probed `gdigrab → libx264` while production ran
`gdigrab → h264_amf`, certifying a chain nobody runs), and `session.start()` re-resolves a
window's title from its stable `window:<HWND>:<n>` id immediately before spawning, because
gdigrab matches `title=` exactly and a browser spinner or unread badge changes it.

**Verified:** the full production-shape argv (dshow mic + gdigrab window + h264_amf + segment
muxer) against the same minimised window: before, `frame= 0` and `Conversion failed!`; after,
`frame=75`, `seg_000.mkv` written, video stream 182×128 with the audio track intact.
Pinned by `tests/unit/ffmpeg-builder.test.ts` — "pads a window chain up to the h264_amf floor
instead of mapping it raw", which asserts no bare `N:v` map survives for any video source.

**Rule:** a hardware encoder has a **minimum** frame size, not just a format and an even-pixel
requirement — and any capture source whose dimensions the user controls (a window, a region)
can go below it. Normalise size at the filter, never assume the source is sane. And when an
encoder fails, read its own error (`encoder->Init() failed with error 5` at `-loglevel verbose`)
before believing ffmpeg's generic errno.

---

## M-022 — console.* in the main process is a black hole, so two dead recordings logged nothing

**Date:** 2026-08-31  **Area:** tooling/observability  **Cost:** made M-021 far harder to find
**Symptom:** two recordings failed completely and `%APPDATA%/MeetFroge/logs/` contained exactly
one line for the whole day: `binary integrity: ok`. There was no record that a recording had
even been attempted, let alone why it died.
**Cause:** M-004 established that Electron on Windows is a GUI-subsystem binary whose stdout
goes nowhere, and the rule was applied to *tests*. It was never applied to the app's own
diagnostics. `session.ts` reported every failure through `console.error`/`console.warn` — and so
did `queue.ts`, `recovery.ts`, `llm/server.ts`, `capability-probe.ts`. `src/main/log.ts`, the
one thing that writes to a file, was used almost nowhere in the capture path.
**Fix:** every capture failure path now goes through `log.*` with structured context
(`meetingId`, `encoder`, `trackLayout`, `stderrTail`), plus a `session finalized` success line —
a known-good baseline is what makes the next failure readable. ffmpeg's stderr tail is now
retained on the session (`lastStderrTail`) *before* the run object is torn down, because the
finalize `catch` previously ran after `run` was already null and had nothing left to report.
**A second bug found while verifying this:** `log.write()` spread the caller's `extra` object
**after** the envelope fields, so a call passing `{ level: 'very-quiet' }` overwrote the log
level and emitted a line claiming `"level":"very-quiet"`. Any filter over these logs would
silently miss it. Fixed structurally — `extra` is now spread first, so the envelope always wins.
**Verified:** a 12 s run now produces `ffmpeg spawned` → `audio track carries no usable signal`
(with the measured dB values) → `session finalized` (with duration, bytes, segment count), all
at their correct levels.
**Rule:** in a GUI-subsystem process, `console.*` is equivalent to deleting the message. Enforce
it mechanically rather than by discipline (`no-console` for `src/main/**`), and never let a
structured-log envelope be overwritable by its own payload.

---

## M-023 — the silence gate measured the audio after normalising it, so nothing was ever silent

**Date:** 2026-08-31  **Area:** pipeline/audio  **Cost:** the entire "summary and transcript is
not working" report
**Symptom:** a recording completed with all four tracks, every pipeline stage reported success
or a bare `skipped`, and the user got an empty transcript and no summary with no error anywhere.
The extract checkpoint claimed the microphone track was at `-19.8 dB` and "not silent".
**Cause:** `extract-audio.ts` ran `-af loudnorm=I=-16:TP=-1.5:LRA=11,volumedetect`.
volumedetect measured the **normalised** signal. loudnorm's whole job is to drag everything to
−16 LUFS, so a near-silent track arrives at the meter looking healthy. Measured on the actual
failing file:

| filter order | mic mean | system mean |
|---|---|---|
| `loudnorm,volumedetect` (was) | **−19.8 dB** | −91.0 dB |
| `volumedetect,loudnorm` (now) | **−53.5 dB** | −91.0 dB |

A 33.7 dB lie about the microphone. The −70 dB threshold could only ever catch bit-exact
digital silence, which is why the loopback track (a true all-zeros stream, mean == max == −91)
was the only thing it ever flagged.
**Fix:** volumedetect moved to the front of the chain, and `max_volume` is now parsed alongside
`mean_volume`. A single classifier in `src/shared/audio-levels.ts` is shared by the capture
session and the extract stage so the two can never disagree: mean within 0.5 dB of max and
below −80 dB means digital silence (the M-020 signature — no spread means every sample is
identical); mean below −45 dB means very quiet, still transcribed but recorded as the
explanation if nothing comes back. Mean, not peak, is the discriminator — the real failing mic
track peaked at −24.8 dB, so any peak-based gate would have called it fine.
**Verified:** `tests/unit/audio-levels.test.ts` pins the real measured values from meeting
`50d6d071`; the classifier calls the loopback track `digital-silence` and the mic track
`very-quiet`, and a live 12 s recording now surfaces "The microphone was very quiet" to the user
at stop instead of an empty transcript an hour later.
**Rule:** measure before you correct. A meter placed after a normaliser reports the
normaliser's opinion, not the signal's. And one classifier shared by every consumer — a
threshold duplicated across two subsystems will drift until they disagree about the same file.

---

## M-024 — a stage reported `done` having produced nothing, and re-running it destroyed the old result

**Date:** 2026-08-31  **Area:** pipeline/transcription  **Cost:** the user-visible half of
"summary and transcript is not working"; latent data loss
**Symptom:** two meetings finished with `extract: done`, `transcribe: done`, `diarize: skipped`,
`summarize: skipped` — no failures anywhere — and **zero rows** in `transcript_segments`. The
Library showed "No transcript yet — processing may still be running", which was false: processing
had finished. Pressing anything the UI offered changed nothing.
**Cause (three, stacked):**
1. `whisper-cli` exits **0** when it recognises nothing. `transcribe.ts` maps its JSON and then
   filters empty text, so `segments` is legitimately `[]`, and the stage returned `'done'`.
2. `pipeline/index.ts` handed that empty array straight to
   `transcripts.replaceTrackSegments()`, which **deletes the track's existing rows and then
   inserts nothing**. So a re-run that recognised nothing did not merely fail to improve the
   transcript — it deleted a previously good one. Latent data loss, not just a bad status.
3. `summarize` then returned a bare `'skipped'` for "no transcript", and the queue had no way to
   record a reason for a skip, so nothing downstream could explain the emptiness. In the UI
   `skipped` shared a CSS bucket with `pending`, so a finished pipeline looked like a stuck one
   indefinitely.
**Fix:** `replaceTrackSegments` is now guarded by `segments.length > 0`. `StageOutcome` was
widened to `'done' | 'skipped' | { state, code?, detail? }` — the bare form keeps existing stages
compiling, the object form lets a stage explain itself — and every bare `return 'skipped'` in the
pipeline now carries a code (`PIPELINE_NO_AUDIO`, `PIPELINE_AUDIO_SILENT`, `PIPELINE_NO_SPEECH`,
`PIPELINE_NO_TRANSCRIPT`, `PIPELINE_NO_VIDEO`, `PIPELINE_MODEL_MISSING`,
`PIPELINE_WORKDIR_MISSING`). Transcribe returns `PIPELINE_AUDIO_SILENT` when every track was
digitally silent and `PIPELINE_NO_SPEECH` when audio was present but unintelligible — different
causes send the user to different fixes. Codes reach the renderer, `skipped` got its own badge
class, and each reason renders as a sentence rather than an enum name.
Also fixed here: a missing whisper model used to `throw`, burning three retries with exponential
backoff before landing on `failed`, while `diarize` and `vlm` skipped honestly for the identical
condition. It now skips too.
**Verified:** `npm run test:honesty` — a new deterministic harness that synthesises media and
asserts on outcome CODES, with no microphone, speakers, or window focus involved (M-014):

| case | media | required outcome |
|---|---|---|
| silence | video + two `anullsrc` tracks | `extract` **and** `transcribe` skip with `PIPELINE_AUDIO_SILENT` |
| tone | video + two loud 440 Hz tracks | `extract` runs; `transcribe` skips with `PIPELINE_NO_SPEECH` |

Both cases additionally assert that no stage reports `done` alongside zero segments. ALL PASS.
**Rule:** exit code 0 is not a result. A stage that can legitimately produce nothing must
distinguish "succeeded and produced nothing" from "succeeded and produced something", and say
which. And a write path that DELETES before it INSERTS must never be handed an empty set — make
the guard structural, not a convention, because the empty case is exactly the one nobody tests.

---

## M-025 — cleanup lived in a stage that could skip, so re-processing had nothing to work from

**Date:** 2026-08-31  **Area:** pipeline/lifecycle  **Cost:** made every broken meeting
permanently unfixable
**Symptom:** re-processing a meeting that had produced no transcript did nothing at all — the
stages ran and returned instantly, and the result was identical.
**Cause (two independent bugs that only bit together):**
1. `enqueue()` and `retry()` reset `state`, `attempts`, `error_code` and `progress` but **not
   `checkpoint`**. Transcribe's checkpoint records which tracks it has already handled, so a
   re-run read `{"done":["mic","system"]}`, found nothing left to do, and returned `done` in
   milliseconds without transcribing anything. Re-running was a no-op *precisely* for the
   meetings that needed it.
2. Even with that fixed, the audio was gone: `diarize` deleted the whole work directory in an
   unconditional `finally`, which ran on all four of its skip paths too. A meeting with no system
   audio — which never needed diarization at all — still lost `mic.wav` and `system.wav`.
**Fix:** `enqueue` and `retry` now clear `checkpoint`; `resetInterrupted()` deliberately does
**not**, because that path is crash-resume and a stage that persisted half its work should not
redo it. Three paths, three intents, commented as such. Cleanup moved out of `diarize` into a new
terminal `publish` stage appended to `PROCESSING_STAGES`, which runs last on every path whatever
happened upstream — the queue picks pending jobs in insertion order, so "appended last" is
"terminal" by construction. Transcribe additionally returns `PIPELINE_WORKDIR_MISSING` rather
than a cryptic failure when it finds the WAVs already gone.
**Verified:** `npm run test:honesty` shows `publish:done` on every run including the all-skipped
silence case; re-processing a meeting now re-runs extract and repopulates the checkpoint.
**Rule:** teardown belongs in a stage that cannot be skipped, never in one that can. And any
"reset for re-run" must invalidate every piece of memoised progress, or it resets the paperwork
while preserving the wrong answer.

---

## M-026 — invisible backspace bytes killed the scene classifier, and lint had been saying so all along

**Date:** 2026-08-31  **Area:** pipeline/visual  **Cost:** every keyframe misclassified since
Phase 5; found only while clearing unrelated lint noise
**Symptom:** `npm run lint` reported six `no-control-regex` errors in `vlm.ts`. They looked like
a pedantic rule complaining about a deliberate escape, and had been living in the "15 known lint
errors" pile for days.
**Cause:** the source contained literal **BACKSPACE bytes (0x08)** where `\b` word boundaries
were intended — invisible in every editor, and rendered as `\b` when read back with a text tool,
so the file looked correct. `JSON.stringify` on the line is what finally showed it.
On top of that the alternation was never grouped, so even with real `\b` the regex would still
have been wrong: `\ba|b|c\b` binds the boundaries to the first and last alternative only.

Actual behaviour of `/\x08slide|presentation|powerpoint|deck\x08/i`:

| caption | matched? | correct? |
|---|---|---|
| `a slide about budget` | **no** | should be `slide` |
| `the deck` | **no** | should be `slide` |
| `powerpointless nonsense` | **yes** | false positive |
| `this presentation` | yes | correct, but by accident |

Every one of the six keyword groups had a dead first entry and a dead last entry, and its middle
entries matched inside longer words. The `keyframes 6/6 · VLM 6/6` E2E still passed because it
asserts on the *caption*, never on the scene type.
**Fix:** grouped, boundaried regexes — `\b(?:slide|presentation|powerpoint|deck)\b`. The keyword
table and `parseReply` moved into a new pure `stages/vlm-scene.ts`, because the logic lived in a
module that imports `electron` and therefore could not be unit-tested at all — the same reason it
stayed broken. `tests/unit/vlm-scene.test.ts` now asserts no control character survives in any
pattern, that every pattern is grouped, and that the first and last keyword of a group both match
while `powerpointless` does not.
**Verified:** `npm run lint` clean (0 errors, from 15), 8 new unit tests, 137 total green.
**Rule:** a lint error you have decided to live with is a finding you have decided not to read.
`no-control-regex` exists because control characters are invisible — the one class of bug you
cannot review your way out of. And logic that cannot be imported without Electron cannot be
tested, which is not a testing gap but a design one: extract the pure part.

---

## M-027 — "off" and "not chosen" were the same value, so Refresh silently turned the camera back on

**Date:** 2026-08-31  **Area:** renderer/capture setup  **Cost:** found while building the
toggles the user asked for; would have shipped as a confusing recording
**Symptom:** the only way to turn the camera off was to pick "None" in its dropdown. Doing so
discarded which camera had been selected, and pressing "Refresh devices" afterwards turned the
camera back on with the first non-virtual device.
**Cause:** `Selection` stored `cameraDeviceId: string | null`, where `null` meant BOTH "off" and
"nothing selected yet". `refreshDevices()` then filled the gap with
`sel.cameraDeviceId ?? inv.cameras.find(...)`, which cannot distinguish a deliberate "off" from
an empty initial state — so a hardware re-enumeration silently overrode a user decision.
**A second, worse bug in the same two lines:** `buildConfig` mapped an unreconciled device
(`dshowName === null`, which `reconcile.ts` returns rather than guessing) to `null` as well. The
dropdown appended " — unavailable to recorder" to the label, but nothing blocked recording and no
validation fired, so a user could record believing their microphone was on and get a file with no
mic track and no explanation.
**Fix:** `cameraEnabled` / `microphoneEnabled` booleans alongside the ids. "Off" keeps the device,
so switching back on restores it; `refreshDevices()` no longer touches the toggles, and seeds
`cameraEnabled` exactly once from `QUALITY_PROFILES[preset].cameraEnabledDefault` — a field that
had existed since Phase 1 and was read nowhere. The silent downgrade is now surfaced by
`enabledButUnavailable()` as a blocking-looking error in the preview panel, and `select()`
re-validates on a 400 ms debounce so `session:validate`'s existing correct warnings are actually
seen rather than waiting for a "Check setup" press nobody makes.
`buildConfig` and the Selection type moved to a new pure `capture-config.ts`, because `store.ts`
imports `api`, which touches `window` at module load — the mapping that decides whether a track
gets recorded could not be imported by a test at all. Same root cause as M-026.
**Verified:** `tests/unit/source-toggles.test.ts` — nine cases covering each toggle, the
remembers-the-device property, mic+system together, every-audio-source-off, and the
enabled-but-unavailable report. `tests/unit/ffmpeg-builder.test.ts` pins the argv side, including
mic-off making system audio `a:0`. Live 12 s recording with all sources on still yields 2 video +
2 audio tracks.
**Rule:** a nullable id cannot carry an on/off decision as well. When one value has to mean two
things, one of them will be inferred wrongly by something that only knows about the other. And a
capability the user can switch on must fail loudly when it cannot be delivered — a config that
silently drops a track the user believes is recording is the same silent-fallback bug as M-023,
one layer up.

---

## M-028 — the model writes its own plumbing into the prose, and the invisible-escape bug came straight back

**Date:** 2026-08-31  **Area:** pipeline/qa  **Cost:** caught on the first real run
**Symptom:** the first Q&A report generated from a real meeting rendered
`"...positions in the next quarter. t=19400"` as an answer, with a perfectly good `0:19` seek
button sitting right next to it. A later pair ended `"...requiring clarification. t=null"`.
**Cause:** the prompt tells the model to carry the nearest `[t=...]` value into the `t` FIELD.
qwen3-4b does that — and also writes the marker into the sentence. The instruction is ambiguous
about where the value belongs, and no amount of prompt wording makes that reliably unambiguous,
so the cleanup has to be structural rather than persuasive.
**Fix:** `cleanAnswer()` in the pure `qa-support.ts` strips a leading-or-bracketed `t=<digits>`
or `t=null` and repairs the spacing, applied to both the question and the answer before storage.
Pinned by tests using the exact strings the real run produced.
**The part worth recording:** the first version of that regex was written as
`/\[?\bt\s*=\s*\d+\]?/gi` through a shell heredoc, and the `\b` arrived in the file as a literal
**0x08 backspace byte** — the identical failure documented in M-026 barely an hour after writing
it, in the code fixing a different bug. The unit test caught it; `no-control-regex` would have
too. The rewrite avoids the escape entirely, using `(?<![a-z])`, because a lookbehind cannot be
mistyped into an invisible character.
**Verified:** `npm run test:qa` on a real 20-segment meeting — 6 content assertions including
"no t= marker leaked into an answer" and "no duplicate questions". `npm run test` includes 5
`cleanAnswer` cases. Zero control characters in the file, asserted directly.
**Rule:** a model told to put a value in a field will often put it in the prose as well; strip
machine markers from generated text as a matter of course rather than trusting the instruction.
And never author a regex through a shell heredoc — write the file directly, or use a construct
that has no backslash escape to lose.

---

## M-029 — the idle unloader could kill a model mid-answer

**Date:** 2026-08-31  **Area:** pipeline/llm  **Cost:** none observed yet; found while reading
the lifecycle for the Q&A stage
**Symptom:** none reproduced — this is a latent race found by inspection, recorded because the
window is real and the failure would have looked like a model bug.
**Cause:** `IDLE_UNLOAD_MS` is 5 minutes and `chat()`'s `AbortSignal.timeout` is 10 minutes, and
`touchIdle()` was called when a request STARTED. A completion running longer than five minutes —
precisely the big reduce pass on a 15 W laptop — would have its own llama-server killed out from
under it and fail with a fetch error that named nothing.
**Fix:** an `inFlight` counter; the idle timer re-arms instead of unloading while any request is
outstanding, and `touchIdle()` now also runs when a request FINISHES so the clock starts from the
end. The 5-minute idle window is kept — RAM matters more here than a warm model.
Alongside it: llama-server's stderr, previously discarded entirely, is kept in a bounded 40-line
ring and written to the log **only** on a startup failure or a non-zero exit, so
`"did not become healthy in time"` finally carries a reason. Startup lines are load and config
diagnostics, not prompts, so this does not breach the no-model-output-in-logs invariant.
**Verified:** typecheck plus a real Q&A generation against a live server; the guard is
inspection-level, and the stderr ring is exercised on every start.
**Rule:** a timeout that can fire during the operation it is timing must know the operation is
still running. Any idle-unload, cache-evict or reap timer needs an in-flight count, not just a
last-touched timestamp.

---

## M-030 — a stray Electron makes every harness pass without running anything

**Date:** 2026-08-31  **Area:** tooling/testing  **Cost:** a schema migration that silently did
not apply, and three "successful" harness runs that never booted
**Symptom:** after adding migration v3, three consecutive `MEETFROGE_SMOKE=1` runs exited **0**
and the database was still at schema version 2. The migration SQL was present in the built
bundle, the runner was correct, and `out/smoke.json` was five days old — but nothing in the
output said so, because the exit code said success.
**Cause:** `app.requestSingleInstanceLock()` in `src/main/index.ts`. A second launch does not
boot: it hands off to the running instance and **quits with exit code 0**. Six stray
`electron.exe` processes left behind by earlier harness runs were holding the lock, so every new
launch was a no-op that reported success.
This is not specific to the smoke test. Every harness in `scripts/` asserts on exit codes and
output files, and any of them will pass vacuously while a stray instance exists — the same shape
as M-004, where a log-grep assertion would have passed forever.
**Fix:** `scripts/electron-run.mjs` — one entry point that kills stray `electron.exe` and
`llama-server.exe` first, deletes the expected artefact, runs the app, and then requires that
artefact to exist **with an mtime after the launch**. A stale or missing file fails with a message
naming the single-instance lock as the likely cause, so the next person does not spend the same
half hour. `pipeline-honesty-test.mjs` and `qa-test.mjs` go through it.
**Verified:** killing the strays and re-running took the database from schema 2 to 3 with
`meetfroge.db.pre-v3.bak` written; `npm run test:qa` still passes through the new runner.
**Rule:** a single-instance application cannot report success by exiting 0 — the exit code
belongs to whichever process actually held the lock. Assert on a **freshly written artefact**,
never on the exit code alone, and clear strays before launching. The generalisation of M-004:
if a test's success signal can be produced without the code under test running, it is not a test.

---

## M-031 — a "custom" marker orphaned every recording made under a folder the user later changed

**Date:** 2026-08-31  **Area:** storage  **Cost:** caught by the bulk-delete run, before any real
recording was affected
**Symptom:** deleting all meetings reported `56 deleted, 1 failed`, and the failure was:
```
PathEscapeError: path escapes its root: custom recordings folder is not configured: synthetic_b86b534c.mkv
```
That meeting had been recorded into a chosen folder; the setting was afterwards reset to the
default. It was then **unplayable and undeletable** — every path that touches it, including
`meetings:delete`, refused to resolve it.
**Cause:** `meetings.media_root` stored the *marker* `'custom'` and resolution looked the real
folder up from **the current setting**. So the row was not self-sufficient: its meaning depended
on a value the user is explicitly invited to change. Reset the folder, or point it somewhere new,
and every recording made under the old one loses its root. The containment guard behaved
perfectly — it refused to guess, which is the only reason this surfaced as an error rather than
as a deletion in the wrong directory.
**Fix:** `media_root` now stores `'userData'` or the **absolute folder that was in force when the
recording was made**. The row resolves on its own, forever, whatever the setting becomes.
Containment is unchanged: `media_path` is still relative, `resolveInside` still contains it, and
the root comes from SQLite (written by main) rather than from the renderer, so trusting it is not
an escalation.
**Verified:** `npm run test:storage` — records into a chosen folder, asserts `media_root` is the
real path and `media_path` is still relative, **then resets the setting to the default** and
asserts the row still points at the real file and still deletes cleanly. That reversal is the
case the marker got wrong, and it is now the centre of the test.
**Rule:** a stored row must not depend on mutable global configuration to be interpreted. If a
setting can change, anything already written under it has to record what was true at the time —
"which folder was this saved to" is part of the record, not a lookup. Second lesson: the bulk
operation found this, not the unit tests. Running a destructive path over *every* row exercises
combinations no fixture contains.

---

## M-032 — the System meter read zero until Record was pressed, so a dead loopback was invisible

**Date:** 2026-08-31  **Area:** capture/audio + UX  **Cost:** real meetings recorded without the
other participant's voice
**Symptom:** the user reported "the voice of the person I'm in the meeting with didn't come".
Investigation found the capture path itself is fine — a tone played through the default output
device is captured cleanly (system track mean −18.9 dB, the 600–900 Hz band at −24.1 dB, both
audio tracks present in one recording). The failure was environmental and, crucially,
**undetectable in advance**.
**Cause:** `systemLevel` was only ever written by a `setInterval` created inside `store.start()`.
Before recording, the System meter was hard-wired to zero. This machine has **three active render
endpoints** (Headphones, Headset, Speaker); if Windows sends the meeting to one and the loopback
attaches to another (M-019), or the render session opens after capture (M-020), the system track
is silence — and there was no way to find that out until the meeting was over. The post-recording
warning added in M-023 tells you afterwards; nothing told you before.
**Fix:** the loopback now runs as a **pre-record preview**, so the System bar moves while the
meeting plays and a flat bar is visible before anything is lost. Two deliberate details:
- `start()` **reuses** the preview stream instead of opening a second one. That removes a
  transition rather than adding one, and means the loopback is already flowing when ffmpeg opens
  the pipe (M-020's ordering, for free).
- The preview is NOT torn down by `previewsSuspended`. That guard exists for the camera and
  microphone, which are exclusive devices (M-007); a loopback is not one, and here the stream is
  deliberately handed to the recording.
The panel says what a flat bar means, in words: sound is going to a different output device than
the one being captured.
**Verified:** `scripts/audio-diagnose.mjs` — plays a known two-tone signal through the default
output, records through the real app, and reports each track's level plus a band-pass check that
the tone specifically arrived. It answers "is system audio working" with a measurement instead of
a guess.
**Rule:** a capture path that can fail for environmental reasons needs a live pre-flight readout,
not only a post-hoc warning. If the only way to discover a setup problem is to lose a recording,
the feature is not finished — and "it works in my test" is not an answer to "it did not work in
my meeting".

---

## M-033 — constant bitrate on a static screen: 3.40 GB/h for content worth 0.26

**Date:** 2026-08-31  **Area:** capture/encoding  **Cost:** ~13x the storage every recording
**Symptom:** the user asked whether the video files could be smaller. A 15-second `high`-preset
recording was 15.4 MB — **3.40 GB per hour**.
**Cause:** every preset specified a fixed bitrate (`-b:v 6000k` at `high`). A meeting screen is
nearly static, so constant bitrate spends megabits per second re-encoding frames that did not
change; the encoder is not allowed to spend less when there is nothing happening.
**Fix:** quality-based rate control on every encoder — `-rc cqp -qp_i N -qp_p N` for h264_amf,
`-rc constqp` for NVENC, `-global_quality` for QSV, `-crf` for libx264. Presets now carry a
quantizer instead of a bitrate.

Measured on REF-01, the same 8 s of real screen capture, video only:

| setting | GB/hour |
|---|---|
| CBR 6000k @30fps (was `high`) | 2.45 |
| CBR 3000k @15fps (was `balanced`) | 1.31 |
| **QP 26 @30fps** | **0.53** |
| QP 30 @15fps | 0.25 |
| QP 34 @10fps | 0.13 |

End to end through the app, `high` preset, 1080p30 screen + camera + two audio tracks:
**3.40 GB/h -> 0.26 GB/h.** Same resolution, same framerate, same quality target.
**Verified:** a real 15 s recording measured at 1127 KB with all four tracks intact, against
15.4 MB before.
**Rule:** for screen content, fixed bitrate is close to the worst possible choice — it pays the
maximum price for the cheapest frames. Quality-based encoding lets a static screen cost what a
static screen is worth. And a size estimate derived from a nominal bitrate is fiction once the
encoder stops targeting one: measure, and say in the UI that it is an estimate.

---

## M-034 — a live ffmpeg filter can be commanded over the stdin already used for 'q'

**Date:** 2026-08-31  **Area:** capture/ffmpeg  **Cost:** none — this is the finding that made
mid-recording mute cheap instead of a capture-graph rewrite
**Context:** the user asked to mute the microphone and system audio **during** a recording. The
obvious approaches are both bad: removing an input means segments carry different streams and the
lossless concat can no longer join them (M-011), and routing the microphone through the renderer
to gain a mute point is a capture-graph redesign.
**Finding:** ffmpeg's interactive mode accepts a filter command on stdin — the same pipe already
used to send `q` for a graceful stop. Give each audio track a NAMED volume filter
(`[0:a]volume@mic=1[amic]`) and one line mutes it live.

The exact form matters and is not obvious:

```
cvolume@mic -1 volume 0     <- works
c volume@mic -1 volume 0    <- "at least 3 arguments were expected, only 0 given"
cvolume@mic volume 0        <- "only 1 given"  (the time field is not optional)
```

`c` must NOT be followed by a space, and the `-1` time field is required.
**Verified:** a steady tone went from −21.1 dB to −91.0 dB mid-run with no respawn; then in the
real app, a recording's system track measured −20.1 dB before the mute and −91.0 dB after, while
the untouched microphone track was unaffected and the file still concatenated with all tracks.
**Rule:** before redesigning around a limitation, check whether the tool already exposes a
control channel. And when a CLI documents a command format, test the exact spacing — ffmpeg's own
error message was the thing that revealed the required time field.
