# DECISIONS.md — Architecture Decision Records

One entry per non-obvious choice, so the *reasoning* survives even when the conclusion is
later reversed. Format: context → options → decision → consequences → status.

Status values: `accepted` · `superseded by ADR-nnn` · `deprecated`

---

## ADR-001 — Windows-first, Linux later

**Date:** 2026-08-25 · **Status:** accepted

**Context.** The original plan targeted Fedora Linux. The actual development machine is
Windows 11 Pro (WSL2 present but unused). No Linux machine was available to verify against.

**Options.**
1. Fedora-first — cannot be verified from this machine; the highest-risk phase becomes untestable.
2. Cross-platform from day 1 — roughly +3–4 days, doubles the debugging surface on the riskiest code.
3. Windows-first behind a portability seam.

**Decision.** Option 3. All platform-specific code sits behind a `CaptureBackend` interface.

**Consequences.** Fedora becomes a port, not a rewrite. Windows also happens to have the
*easiest* system-audio story of any OS (WASAPI loopback) — Wayland + PipeWire + xdg-desktop-portal
is strictly harder. Hardware acceleration (AMF encode, Vulkan inference) is already verified here.

---

## ADR-002 — Hybrid capture: Chromium loopback + ffmpeg

**Date:** 2026-08-25 · **Status:** accepted

**Context.** Desktop audio is a critical requirement. Verified on this machine: ffmpeg's
DirectShow enumeration finds **no system-audio source** (see MISTAKES.md M-002). ffmpeg has
no WASAPI input backend at all.

**Options.**
1. Pure Electron `MediaRecorder` — simplest, but software VP8/VP9 encode on a 15 W chip,
   poor WebM seeking, no separate audio tracks, and a crash corrupts the file.
2. ffmpeg only + require a virtual audio cable (VB-Cable/VoiceMeeter) — clean architecture,
   but a driver install per machine and it can hijack the default audio device.
3. Drive OBS Studio via obs-websocket — fastest and most robust, but OBS becomes a hard dependency.
4. Hybrid: Chromium captures system audio, ffmpeg captures screen + mic and encodes.

**Decision.** Option 4.

**Consequences.** Electron becomes load-bearing *infrastructure*, not a UI shell — this is the
one architectural oddity in the codebase and must be understood by anyone touching capture.
Electron version pinning becomes safety-critical. The PCM bridge needs its own backpressure
design and DoS hardening. Options 2 and 3 are retained as fallback rungs.

---

## ADR-003 — Keyframe-driven visual analysis, not 1 fps

**Date:** 2026-08-25 · **Status:** accepted

**Context.** The original plan specified frame-by-frame VLM analysis at 1 fps. A 1-hour meeting
is 3600 frames; a small VLM on this iGPU is ~2–5 s/frame, i.e. 3–5 hours of processing per
meeting hour. Infeasible by two orders of magnitude.

**Options.**
1. Literal 1 fps VLM — only viable with a discrete NVIDIA GPU.
2. Fixed coarse interval (1 frame per 5–10 s) — ~500 frames/hour, misses fast slide flips,
   wastes work on static screens.
3. OCR only, no VLM — fastest, but loses scene descriptions and diagram understanding.
4. Change detection → keyframes → OCR on all → VLM on all keyframes.

**Decision.** Option 4. pHash + histogram delta selects 60–120 keyframes per meeting hour.

**Consequences.** ~97% reduction in visual-analysis cost with no practical information loss —
a slide displayed for 4 minutes does not need 240 descriptions. Requires a keyframe cap
(default 150/hour), and the cap must be **reported in the UI** when it binds, per Principle 5.

---

## ADR-004 — Stock Whisper forced to English

**Date:** 2026-08-25 · **Status:** accepted

**Context.** Meetings are mostly English with Bangla words mixed in (user-confirmed).

**Options.**
1. Bangla fine-tuned checkpoint (e.g. bengaliAI whisper-medium) as primary.
2. Auto language detection — Whisper flips language mid-sentence and garbles switch points.
3. Stock `large-v3-turbo` with `-l en`.

**Decision.** Option 3, with a per-meeting language override (`auto` / `en` / `bn`) exposed.

**Consequences.** Bangla words are transliterated or approximated; meeting substance survives.
Forced-English genuinely mangles a heavily-Bangla session, hence the override. The UI must
state mixed-language accuracy limits plainly — expectation-setting is part of the feature,
not a disclaimer bolted on afterwards.

---

## ADR-005 — Zero Python

**Date:** 2026-08-25 · **Status:** accepted

**Context.** The original plan used FastAPI + faster-whisper + pyannote.audio. The project is
to be shipped as a distributable product.

**Options.**
1. Python sidecar with FastAPI — familiar from BizFinder, rich ML ecosystem.
2. Hybrid, Python only for ML via JSON-over-stdio subprocesses.
3. Node + native binaries only.

**Decision.** Option 3. whisper.cpp (binary), sherpa-onnx (official Node addon, Apache-2.0,
no gated token), llama.cpp `llama-server` (binary), tesseract.js, ffmpeg.

**Consequences.** Removes a runtime, an open port, a process manager, and the single worst part
of packaging — bundling Python + PyTorch into a signed installer is multi-GB and fragile.
Dropping pyannote also removes a HuggingFace gated-token dependency. Cost: a smaller ML
experimentation surface if we later want models with no GGUF/ONNX export.

---

## ADR-006 — Post-meeting batch processing

**Date:** 2026-08-25 · **Status:** accepted

**Context.** A 15 W 6-core CPU cannot record and run inference simultaneously without risking
dropped frames.

**Options.**
1. Live transcript during the meeting.
2. Both — rough live view, accurate pass afterwards (~+2 days, needs careful CPU throttling).
3. Post-meeting batch via a resumable job queue.

**Decision.** Option 3. Live transcript deferred to post-1.0.

**Consequences.** Recording stays lightweight (hardware encode, near-zero CPU). Better accuracy:
full context, VAD gating, proper diarization. Directly serves Principle 2 — nothing competes
with capture for CPU.

---

## ADR-007 — Separate audio tracks, never mixed

**Date:** 2026-08-25 · **Status:** accepted

**Context.** How to store mic and system audio.

**Options.**
1. Mixed into one track — smallest, plays anywhere, permanently loses source separation.
2. Composited picture-in-picture video with mixed audio — looks like a normal recording, same loss.
3. Separate tracks in one MKV: `a:0` mic, `a:1` system.

**Decision.** Option 3. Composition happens only at export.

**Consequences.** **This is the highest-leverage design choice in the project.** In a remote
meeting `a:0` is you and `a:1` is everyone else — a free, 100%-accurate two-way speaker split
before diarization runs at all. Diarization then only separates remote speakers from each other,
a far easier problem, and 1:1 meetings need no diarization whatsoever.

---

## ADR-008 — Shippable open-source product

**Date:** 2026-08-25 · **Status:** accepted

**Context.** The stated goal is a real product distributed to users, fully open source.

**Decision.** Build to product quality: documented installer, first-run wizard, hardware
detection with graceful fallbacks, accessibility, security hardening, CI, governance.

**Consequences.** Timeline grows from ~9–11 days (personal-tool estimate) to 26–33 days.
Phases 8–11 (security audit, a11y/i18n, packaging, testing/release) are entirely additional.

---

## ADR-009 — GPL-3.0-or-later

**Date:** 2026-08-25 · **Status:** accepted

**Context.** The app bundles ffmpeg. The gyan full build is GPL because it includes libx264,
which is our CPU encoder fallback — required by Principle 3 for machines without hardware encoders.

**Options.**
1. Apache-2.0 app + LGPL ffmpeg build — permissive reuse, but forces openh264 or
   hardware-only encoding, weakening the fallback ladder.
2. Require users to supply their own ffmpeg — poor UX, breaks the installer story.
3. GPL-3.0-or-later app + full GPL ffmpeg build.

**Decision.** Option 3. Precedent: OBS Studio.

**Consequences.** Bundling GPL ffmpeg with libx264 is straightforward and legal. All other
dependencies are compatible (MIT / Apache-2.0). Gemma models are avoided despite good quality
because their custom license carries use restrictions unsuited to a fully-open project.
Qwen3 (Apache-2.0), SmolVLM2 (Apache-2.0), Moondream2 (Apache-2.0) and Whisper (MIT) are all fine.
Permissive downstream reuse is forgone — not a stated requirement.

---

## ADR-010 — PCM over a named pipe; stdin reserved for control

**Date:** 2026-08-25 · **Status:** accepted

**Context.** Spike 2 proved loopback PCM over ffmpeg stdin (B-006), but that shape leaves no
channel for ffmpeg's `q` command — its only graceful-shutdown mechanism — and a killed ffmpeg
does not write the MKV trailer.

**Options.**
1. PCM on stdin, stop via kill — corrupts the trailer; unacceptable under Principle 2.
2. PCM over localhost TCP — works, but any local process could race ffmpeg to the port.
3. PCM over a Windows named pipe (`\.\pipe\meetfroge-pcm-<random>`), stdin for `q`.

**Decision.** Option 3. Named-pipe default DACL is current-user; the name is random per
session; exactly one client is accepted.

**Consequences.** Stop is graceful and the trailer is always written. The bridge keeps the
ring/backpressure design B-006 validated. Residual: a same-user process could connect first —
same trust boundary as the rest of the app (see SECURITY.md "what this does not protect against").

---

## ADR-011 — node:sqlite instead of better-sqlite3

**Date:** 2026-08-26 · **Status:** accepted

**Context.** The plan specified better-sqlite3 — a native addon that needs either prebuilt
binaries for the exact Electron ABI or a local MSVC toolchain. Electron 44 is new enough that
prebuilds lag, and the reference machine had no toolchain when Phase 2 started.

**Options.**
1. better-sqlite3 — battle-tested, but a native-ABI liability on every Electron upgrade.
2. Wait for the toolchain — blocks Phase 2 on an unrelated install.
3. Node's built-in `node:sqlite` (DatabaseSync) — verified inside Electron 44 on 2026-08-26:
   SQLite 3.53.1, **FTS5 works**, synchronous API, zero compilation.

**Decision.** Option 3, behind a repository layer so a later swap stays cheap.

**Consequences.** No native compilation anywhere in the app; Electron upgrades cannot break
the DB at the ABI level. `node:sqlite` is younger than better-sqlite3 — mitigated by the
repository seam, plain-SQL schema, and the fact that the file format is just SQLite.
Encryption-at-rest via SQLCipher (Phase 8) will need a different vehicle — noted there.
