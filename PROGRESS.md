# PROGRESS.md

Live phase and task board. Updated at the end of every work session — a phase is not complete
until this file, `MISTAKES.md`, `docs/benchmarks.md` and `DECISIONS.md` are current.

**Status:** ⬜ not started · 🟡 in progress · ✅ done · 🔴 blocked · ⏸ deferred
Blocked and deferred rows **must** carry a reason.

**Estimate:** 26–33 days total. **Started:** 2026-08-25.

---

## Phase 0 — Foundation and de-risking (2.5 d) ⚠ GATE

| Task | Status | Notes |
|---|---|---|
| 0a · `git init`, branch `main` | ✅ | |
| 0a · `LICENSE` (GPL-3.0, full text) | ✅ | fetched from gnu.org, 674 lines |
| 0a · `CLAUDE.md` | ✅ | verified hardware profile + working ffmpeg recipes + invariants |
| 0a · `MISTAKES.md` | ✅ | seeded M-001, M-002, M-003 |
| 0a · `DECISIONS.md` | ✅ | seeded ADR-001 … ADR-009 |
| 0a · `PROGRESS.md` | ✅ | this file |
| 0a · Governance files | ✅ | README, SECURITY (T1–T12 threat model), PRIVACY, CONTRIBUTING, CODE_OF_CONDUCT (Covenant 2.1), CHANGELOG, ROADMAP |
| 0a · `.github/` templates + workflows | ✅ | ci.yml (incl. loopback smoke test + no-telemetry check), codeql.yml, release.yml, dependabot.yml, issue/PR templates |
| 0a · `docs/` tree | ✅ | architecture, benchmarks (**seeded with B-001…B-004 real measurements**), setup, troubleshooting, risks, testing, legal |
| 0a · Repo config files | ✅ | `.gitignore`, `.nvmrc`, `.editorconfig`, `.env.example` |
| 0a · Initial commit | ✅ | 31 files |
| **0b · Spike 1 — Electron loopback audio** | ✅ | **GATE CLEARED.** Electron 44.0.0 captures real system audio. Tone verified at 6219× noise floor, zero dropped frames. See benchmarks B-005 |
| 0b · Spike 2 — PCM → ffmpeg stdin pipe | ✅ | **PASS, 8/8.** 5 min sustained: 0 ring drops, completeness 1.0000, h264_amf hardware encode, mic↔system drift **3 ms and non-accumulating**. B-006 |
| 0b · Spike 3 — whisper.cpp CPU baseline (B-007) | 🟡 | harness + official CPU binary ready; model downloading |
| 0b · Spike 3 — whisper.cpp Vulkan (B-008) | 🔴 | **blocked: needs toolchain install (user must run `scripts/install-build-toolchain.ps1` elevated)** — no official Windows Vulkan binary exists |
| 0b · Spike 4 — llama.cpp Vulkan benchmark | ✅ | **B-009/B-010 measured.** CPU 51.9/6.96, Vulkan 56.3/9.68 t/s. 1-h summary projection: 7.7 min CPU, 6.3 min Vulkan — **both within the 10-min budget** |

**Exit criteria.** Repo committed with all tracking files. All four spikes produce measured
numbers in `docs/benchmarks.md`. **Spike 1 must prove non-silent system audio.** Any failure is
logged in `MISTAKES.md` before proceeding.

---

## Phase 1 — Capture engine (5–6 d) — highest risk

| Task | Status | Notes |
|---|---|---|
| Electron scaffold + hardening | ✅ | electron-vite + React + TS strict; CSP, nav lockdown, permission handler. Fuses land at package time (Phase 10) |
| Typed IPC gateway, zod both directions | ✅ | caught a real bug on first boot (0×0 thumbnails) |
| Device enumeration + WebRTC↔DirectShow name reconciliation | ✅ | pure `reconcile.ts`, unit-tested |
| `CaptureBackend` interface + `WindowsCaptureBackend` | ⏸ | deferred: modules are cleanly separated but the formal interface extraction waits for a second platform (pre-Linux port refactor) |
| Capability probe via **real 1 s encodes** | ✅ | finds h264_amf + libx264 on REF-01 in 5.6 s; cache keyed to ffmpeg version |
| ffmpeg argv builder + encoder ladder | ✅ | per-encoder format chains, 12 unit tests |
| Loopback PCM bridge (ring buffer, backpressure) | ✅ | named pipe (stdin freed for 'q' graceful stop); pre-roll cleared on connect (M-008) |
| Live preview + dual level meters + pre-flight checklist | ✅ | previews release devices before recording (M-007) |
| **E2E: unattended 4-stream recording through the app** | ✅ | `MEETFROGE_AUTOREC` — 28.7 s, 2v+2a, h264_amf, mic↔system 56 ms |
| A/V sync harness (`scripts/sync-test.mjs`) | ✅ | v2 (burst anchored to file creation, per-track localization, degenerate-peak guard). Measured: mic lags system 116–232 ms, direction stable |
| `-itsoffset` correction | ⏸ | deferred to Phase 2 as **R-11**: offset is systematic ~120 ms but wallclock unification broke recording (M-010); ordered fix candidates documented |
| Lint + typecheck + 12 unit tests green | ✅ | |

## Phase 2 — Recording controls and storage (2.5 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| Start / pause / resume / stop (segment-based pause) | ✅ | E2E: 30 s window, 6 s pause → 20.5 s media, 2v+2a intact |
| Segmented output + lossless concat | ✅ | `-map 0` mandatory (M-011: default selection silently drops tracks) |
| Crash recovery on startup | ✅ | **E2E: hard-killed mid-recording → 3/4 segments recovered into a playable 24 s file, all 4 tracks, state 'recovered'** |
| Disk pre-flight + live guard + auto-stop | ✅ | 10 s polling, 5 GB floor |
| SQLite schema, migrations, repositories | ✅ | node:sqlite (ADR-011), full v1 schema, pre-migration backups |
| Recording indicator (tray + badge + pill) | ✅ | tray red during any session; not suppressible (T8). Always-on-top pill → Phase 9 polish |
| Quality presets | ✅ | landed in Phase 1 |

Residual: mic↔system skew grows at pause joins (309 ms over one pause) — folded into **R-11**.

## Phase 3 — Job queue and transcription (3.5 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| Resumable job runner with checkpointing | ✅ | SQLite-backed, single worker, crash-reset at boot, backoff retries, persist-then-checkpoint ordering |
| Audio extraction + loudness normalization | ✅ | 16 kHz mono + EBU R128 + per-track silence detection (silent tracks skipped honestly) |
| VAD | ✅ | **whisper-cli built-in silero** (`--vad`) — no sherpa needed until Phase 4 diarization |
| whisper.cpp subprocess + progress parsing | ✅ | JSON output, `-pp` progress → job progress |
| Language override (auto/en/bn) | 🟡 | plumbing in place (ADR-004 default `en`); per-meeting UI control arrives with settings (Phase 7) |
| Mic + system transcript merge | ✅ | mic="You" (certain), system="Others" until Phase 4; interleaved timeline |
| Transcript UI (search, exports, job badges) | ✅ | Library tab; virtualization + inline edit deferred to Phase 7 polish |
| Export txt / srt / vtt / json / md | ✅ | pure generators, 6 unit tests |
| **E2E: real-speech content assertion** | ✅ | **JFK played through speakers → recorded → pipeline → word-perfect transcript on the system track at correct timestamps. 2/2 phrases found.** |

## Phase 4 — Diarization (1.5 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| sherpa-onnx diarization on system track only | ✅ | prebuilt N-API addon (no toolchain); pyannote seg + eres2net embeddings; JS WAV reader replaces readWave (M-012 — Electron forbids external buffers) |
| Overlap-based alignment to Whisper segments | ✅ | max-overlap, tie→longer turn; 5 unit tests |
| Speaker renaming, certain vs probabilistic UI | ✅ | click-to-rename; mic speakers green/solid (exact), diarized amber/dotted |
| Degradation to track-based split | ✅ | **exercised in production** by M-012: when diarize failed, the You/Others split stood — exactly as designed |
| **E2E: two-voice TTS through the real app** | ✅ | **Speaker 1 / Speaker 2 correctly separated, all 3 stages done. 2/2 voices, correct sentences.** |

Known: whisper segments that straddle a turn change get the dominant speaker (segment-level
alignment). Word-level refinement is a post-1.0 idea.

## Phase 5 — Visual analysis (3.5 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| ffmpeg gray-stream sampling | ✅ | raw 32×32 gray at 1 fps — 1 KB/s, zero image decode in Node |
| pHash + histogram keyframe selection | ✅ | DCT pHash + intersection veto-band (Pearson degenerates on flat histograms — caught by unit test); cap reported when binding; 8 unit tests |
| OCR (tesseract.js, offline, confidence-gated) | ✅ | full-res re-extracts; feeds keyframe FTS |
| VLM captioning + scene classification | ✅ | SmolVLM2 via shared llama-server; free-prose caption + keyword scene inference (M-015: 2B models ignore format instructions) |
| Camera presence timeline | ✅ | luminance/variance heuristic, spans in DB |
| Visual timeline UI | ✅ | thumbnail strip via mf-frame:// protocol (path-contained), click-to-expand with OCR + caption |
| **Deterministic pipeline E2E** | ✅ | **synthetic 6-slide video: keyframes 6/6 at exact boundaries, OCR 6/6 words, VLM 6/6 captions naming the actual slide colors** |

Also hardened en route: modelAvailable() now size-verifies (M-013 — a half-downloaded mmproj
crashed llama-server); transcribe skips audio-less meetings; live-desktop test kept for manual
runs (M-014 — the OS fights focus manipulation, and the user owns the screen).

## Phase 6 — Summarization (2 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| `llama-server` lifecycle + token auth + idle unload | ✅ | built in Phase 5, shared |
| Semantic chunking | ✅ | pure `chunking.ts`, turn-boundary splits, 4 unit tests |
| Map-reduce | ✅ | grammar-constrained JSON (`json_schema` — probed with curl BEFORE building, M-015's rule) + zod defense in depth; intermediate tier deferred until a >15-chunk meeting exists to test on |
| Visual context injection | ✅ | keyframe captions + OCR feed the reduce pass |
| zod validation + retry + honest degraded fallback | ✅ | |
| Action items (checkable, assignee, source timestamp) | ✅ | click-to-seek lands with the Phase 7 player |
| Export md / pdf / docx | ⏸ | summary renders in UI; file exports land with Phase 7's export polish |
| **E2E: full 7-stage pipeline on a real conversation** | ✅ | **"Engineering Hiring & Budget Review Meeting" — correct decisions WITH timestamps, action item attributed to the speaker who actually said it, 5/6 substance terms** |

Honest artifact worth noting: whisper misheard the TTS "job descriptions" as "job discounts";
the summarizer faithfully carried the transcript's error rather than inventing a correction —
exactly the do-not-invent behavior the prompt demands.

## Phase 7 — Library, search, settings (3 d)

| Task | Status | Notes |
|---|---|---|
| Virtualized library + filters | ⬜ | |
| Unified FTS5 search (transcript + OCR) | ⬜ | distinctive capability |
| Detail view + synced playback | ⬜ | |
| Settings groups | ⬜ | |
| Storage migration with verification | ⬜ | D: has only 12.8 GB |
| Bulk operations + tags | ⬜ | |

## Phase 8 — Security hardening and audit (2 d)

| Task | Status | Notes |
|---|---|---|
| CSP, navigation lockdown, permission handler, fuses | ⬜ | |
| Path traversal guards | ⬜ | |
| Binary + model integrity verification | ⬜ | |
| Optional AES-256-GCM at rest (safeStorage/DPAPI) | ⬜ | |
| Log redaction layer | ⬜ | |
| IPC fuzz tests, CodeQL, audit, SBOM | ⬜ | |

## Phase 9 — Accessibility, i18n, polish (2 d)

| Task | Status | Notes |
|---|---|---|
| Keyboard navigation + focus management | ⬜ | |
| ARIA + live regions | ⬜ | |
| Screen-reader pass (transcript, library) | ⬜ | |
| Contrast audit, reduced motion, themes | ⬜ | |
| String externalization (i18next) | ⬜ | Bangla-ready |
| Empty / loading / error states, onboarding | ⬜ | |

## Phase 10 — Packaging and first-run (3 d)

| Task | Status | Notes |
|---|---|---|
| electron-builder NSIS installer | ⬜ | |
| Reproducible binary bundling, pinned hashes | ⬜ | |
| First-run wizard + tier recommendation | ⬜ | ~4.7 GB model download |
| Fallback ladders verified without AMF / without Vulkan | ⬜ | |
| Auto-update with signature verification | ⬜ | |
| Clean-VM install test | ⬜ | |

## Phase 11 — Testing, docs, release (2.5 d)

| Task | Status | Notes |
|---|---|---|
| Coverage targets met | ⬜ | 80% unit, 70% integration, 85% capture/pipeline |
| Performance budget assertions in CI | ⬜ | |
| E2E critical paths | ⬜ | |
| Manual test matrix executed | ⬜ | |
| User docs + troubleshooting | ⬜ | |
| THIRD_PARTY_NOTICES, SBOM, v1.0.0 release | ⬜ | |

---

## Open items (non-blocking)

| Item | Status | Notes |
|---|---|---|
| Windows code signing | ⏸ | Deferred to Phase 10. Recommendation: ship unsigned for v1.0 (conventional for OSS, genuinely $0). |
| Recording consent framing | ⏸ | Needs user confirmation. `docs/legal.md` + first-run acknowledgement. |
| Bangla UI localization | ⏸ | Infrastructure in Phase 9; shipping a translation for v1.0 is a separate call. |
