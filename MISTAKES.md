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
**Verified:** pending spike 1.
**Rule:** loopback audio rides along with a display capture; it is not a standalone source.
Also: Electron loopback is version-fragile (40.1.0 reportedly regressed to silence) —
pin the Electron version exactly and guard it with a CI smoke test.
