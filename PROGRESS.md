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
| 0b · Spike 3 — whisper.cpp Vulkan benchmark | ⬜ | build `-DGGML_VULKAN=1`; Vega 7 is GCN5, **measure, do not assume** |
| 0b · Spike 4 — llama.cpp Vulkan benchmark | ⬜ | expect ~76 t/s prompt, ~10 t/s generation |

**Exit criteria.** Repo committed with all tracking files. All four spikes produce measured
numbers in `docs/benchmarks.md`. **Spike 1 must prove non-silent system audio.** Any failure is
logged in `MISTAKES.md` before proceeding.

---

## Phase 1 — Capture engine (5–6 d) — highest risk

| Task | Status | Notes |
|---|---|---|
| Electron scaffold + hardening + fuses | ⬜ | |
| Typed IPC gateway, zod both directions | ⬜ | |
| Device enumeration + WebRTC↔DirectShow name reconciliation | ⬜ | known sharp edge |
| `CaptureBackend` interface + `WindowsCaptureBackend` | ⬜ | portability seam |
| Capability probe via **real 1 s encodes** | ⬜ | never read `-encoders` (M-001) |
| ffmpeg argv builder + encoder ladder | ⬜ | verified nv12 recipe |
| Loopback PCM bridge (ring buffer, backpressure) | ⬜ | |
| Live preview + dual level meters + pre-flight checklist | ⬜ | |
| A/V sync harness + `-itsoffset` correction | ⬜ | |

## Phase 2 — Recording controls and storage (2.5 d)

| Task | Status | Notes |
|---|---|---|
| Start / pause / resume / stop (segment-based pause) | ⬜ | ffmpeg has no native pause |
| Segmented output + lossless concat | ⬜ | 5 min segments |
| Crash recovery on startup | ⬜ | |
| Disk pre-flight + live guard + auto-stop | ⬜ | |
| SQLite schema, migrations, repositories | ⬜ | |
| Recording indicator (tray + badge + pill) | ⬜ | security control, not a preference |
| Quality presets | ⬜ | |

## Phase 3 — Job queue and transcription (3.5 d)

| Task | Status | Notes |
|---|---|---|
| Resumable job runner with checkpointing | ⬜ | |
| Audio extraction + loudness normalization | ⬜ | |
| sherpa-onnx VAD (padding + merging) | ⬜ | largest single efficiency win |
| whisper.cpp subprocess + progress parsing | ⬜ | |
| Language override (auto/en/bn) | ⬜ | |
| Mic + system transcript merge | ⬜ | |
| Transcript UI (virtualized, search, inline edit) | ⬜ | |
| Export txt / srt / vtt / json / md | ⬜ | |

## Phase 4 — Diarization (1.5 d)

| Task | Status | Notes |
|---|---|---|
| sherpa-onnx diarization on system track only | ⬜ | |
| Overlap-based alignment to Whisper segments | ⬜ | |
| Speaker renaming, certain vs probabilistic UI | ⬜ | |
| Degradation to track-based split | ⬜ | |

## Phase 5 — Visual analysis (3.5 d)

| Task | Status | Notes |
|---|---|---|
| ffmpeg thumbnail extraction | ⬜ | downscale inside ffmpeg |
| pHash + histogram keyframe selection | ⬜ | cap must be reported when it binds |
| tesseract.js worker pool | ⬜ | full-res keyframes, not thumbnails |
| VLM captioning + scene classification | ⬜ | |
| Camera presence timeline | ⬜ | |
| Visual timeline UI synced to transcript | ⬜ | |

## Phase 6 — Summarization (2 d)

| Task | Status | Notes |
|---|---|---|
| `llama-server` lifecycle + token auth + idle unload | ⬜ | 127.0.0.1, ephemeral port |
| Semantic chunking | ⬜ | split at speaker turns |
| Map-reduce + intermediate tier | ⬜ | |
| Visual context injection | ⬜ | |
| zod validation + repair-prompt retry | ⬜ | |
| Action items with click-to-seek | ⬜ | |
| Export md / pdf / docx | ⬜ | |

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
