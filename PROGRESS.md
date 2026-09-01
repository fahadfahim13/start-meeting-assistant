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
| 0b · Spike 3 — whisper.cpp Vulkan (B-008) | ✅ | **measured 2.144× realtime (2.98× vs CPU) — with ZERO toolchain**: llama.cpp's ggml-vulkan.dll loads into whisper's official build via ggml dynamic backends. The app bundle already ships it |
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

## Phase 7 — Library, search, settings (3 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| Playback + synced transcript | ✅ | `mf-media://` protocol with real HTTP 206 Range slices (video seeking requires it); click-to-seek from segments, keyframes and action items; live current-segment highlight |
| Unified FTS5 search (transcript + OCR) | ✅ | one box searches speech AND on-screen text across all meetings; hits open the meeting pre-seeked |
| Settings | ✅ | quality preset, transcription language (ADR-004 override — now actually wired into the pipeline), auto-process, keyframe sensitivity; model status table with ok/missing/corrupt |
| Tags + delete | ✅ | tag chips + filter-by-eye; delete with size-stated confirmation, cascading media/frames/FTS cleanup |
| Virtualized list | ⏸ | matters at scale; deferred to Phase 9 polish (current lists render fine < 100 meetings) |
| Storage migration with verification | ⏸ | deferred post-1.0 — D: has 12.8 GB free, migration is copy+verify+repath and deserves unhurried testing |
| Bulk multi-select operations | ⏸ | single-meeting operations shipped; multi-select deferred to Phase 9 |

Player Range-handler verified by build + boot smoke; interactive seek behavior needs a manual
dev-mode pass (listed in the manual test matrix).

## Phase 8 — Security hardening and audit (2 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| CSP, navigation lockdown, permission handler | ✅ | landed Phase 1; re-audited. Fuses apply at package time (Phase 10) |
| Path traversal guards | ✅ | centralized `resolveInside`/`isInside` + 10-case traversal battery (incl. the root-as-prefix sibling trap); wired into protocols and pipeline |
| Binary integrity verification | ✅ | SHA-256 manifest of all 35 bundled binaries, verified at boot — fatal packaged, warning in dev. Models already size-verified (M-013) |
| Encryption at rest | ⏸ | **deferred post-1.0 by ADR-012** — node:sqlite has no SQLCipher path, and media-only encryption would be half-measure theater; BitLocker guidance stands in PRIVACY.md |
| Log redaction layer | ✅ | structured JSON logger: userData/home paths redacted at the WRITER, `content()` wrapper reduces meeting text to a length, 7-day retention |
| IPC fuzz battery | ✅ | generated from the channel registry — 70 tests: hostile ids (traversal/SQL/UNC/oversize) rejected on every id field, payload shape + length bounds enforced |
| Dependency audit | ✅ | **0 vulnerabilities** after vitest 4 upgrade (all 5 findings were dev-only vite-chain) |
| Mechanical invariant audit | ✅ | grep-proven: zero `shell:true`, zero SQL interpolation, sandbox/contextIsolation/nodeIntegration intact, no renderer path crosses IPC |

CodeQL + SBOM run in CI (configured Phase 0); first live run happens when the repo is pushed.

## Phase 9 — Accessibility, i18n, polish (2 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| Keyboard navigation + focus management | ✅ | playback shortcuts (space/K, J/L/arrows ±5 s, up/down speed — announced in the player's aria-label); universal `:focus-visible` rings; all interactive elements are real buttons |
| ARIA + live regions | ✅ | job progress announced via `aria-live` sr-only region; labeled search inputs, lists, meters (Phase 1), recording state assertive |
| Screen-reader pass | 🟡 | structural work done; a live Narrator pass is in the manual release matrix (Phase 11) — cannot be honestly claimed from code alone |
| Contrast audit, reduced motion, themes | ✅ | **all 11 palette pairs computed ≥ 5.16:1 (AA)** — measured, not eyeballed; global `prefers-reduced-motion` kill; light theme via `prefers-color-scheme` |
| String externalization | ✅ | dependency-free typed dictionary in i18next resource shape — 88 strings swept from all 3 UI files; Bangla = translate one object |
| Empty / loading / error states | ✅ | present across views; real onboarding is Phase 10's first-run wizard |

## Phase 10 — Packaging and first-run (3 d) — ✅ CORE COMPLETE

| Task | Status | Notes |
|---|---|---|
| electron-builder NSIS installer | ✅ | asarUnpack for native addons, GPL license page, fuses via afterPack; asar-integrity fuse OFF pending builder support verification (documented in after-pack.cjs) |
| Binary bundling, pinned hashes | ✅ | ffmpeg/ffprobe/whisper/llama + DLLs (37 files) hashed in bin.manifest.json, verified fatally at packaged boot |
| Model manager + download flow | ✅ | registry pins sha256+bytes+URL for all 8 models; host-allowlisted resumable downloads, hash-gated before use, Settings UI with progress/cancel/Download-all (this is the first-run flow — the Settings banner appears whenever models are missing) |
| Fallback ladders verified | ✅ | `MEETFROGE_FORCE_ENCODER=libx264` E2E: **18.6/20 s, all 4 tracks on pure software encode**; `MEETFROGE_DISABLE_VULKAN` wired for LLM CPU path |
| **Packaged-app smoke** | ✅ | **win-unpacked + asar + fuses + bundled bin: exit 0, encoders probed, screens enumerated** — found and fixed M-017 (broken dep closure) and the asar-readonly harness path |
| Auto-update | ⏸ | deferred to first public release — needs a GitHub repo to publish to; `publish: null` for now |
| Clean-VM install test | ⏸ | **needs the user**: run `release/MeetFroge Setup 0.1.0.exe` on a machine/VM without dev tools — listed in the Phase 11 manual matrix |

## Phase 11 — Testing, docs, release (2.5 d) — ✅ v0.1.0

| Task | Status | Notes |
|---|---|---|
| Test suite | ✅ | 105 unit tests (schemas/fuzz/paths/algorithms), 10+ E2E harnesses with CONTENT assertions; formal coverage measurement deferred with the CI's first live run |
| E2E critical paths | ✅ | record → transcribe → diarize → visual → summary all verified end-to-end, plus crash recovery, pause, forced-software-encode and packaged smoke |
| Manual test matrix | 🟡 | release gates listed in docs/testing.md — **clean-VM install, Narrator pass and the 3-hour recording need a human**; REF-01 rows exercised throughout development |
| User docs | ✅ | README, troubleshooting, setup, legal — current |
| THIRD_PARTY_NOTICES + checksums | ✅ | generator script; SHA256SUMS.txt alongside the installer |
| Performance budget CI assertions | ⏸ | budgets documented and manually verified during development (1.148 GB/h, realtime encode, 0.72× CPU whisper); CI assertion harness deferred to the repo's first push |
| **v0.1.0 tag** | ✅ | honest alpha versioning — deferred items tracked, not hidden |

---

## Post-v0.1.0 repair — reported 2026-08-31 ("summary and transcript is not working")

Driven by four real recordings made on 2026-08-31. Full plan and evidence in the approved
repair plan; root causes in MISTAKES.md M-021/M-022/M-023.

### Phase A — recording correctness | ✅ done, verified

| Task | Status | Notes |
|---|---|---|
| A1 · every video source goes through a filter chain; gdigrab pads to the h264_amf 128×128 floor | ✅ | M-021. Window capture died at `frame= 0`; a minimised window is captured at 181×25 and AMF refuses it. Verified with the full production argv: `frame=75`, 182×128, audio intact |
| A2 · gdigrab probed through the encoder production actually picks | ✅ | was `gdigrab → libx264` while production ran `gdigrab → h264_amf`. `probeVersion` on `CapabilitiesSchema` invalidates every stale cache structurally |
| A3 · window title re-resolved from its stable source id at start | ✅ | gdigrab matches `title=` exactly; a spinner or unread badge loses the window. Missing source now errors by name instead of recording nothing. Minimised windows warn |
| A4 · capture failures reach the structured log | ✅ | M-022. Two dead recordings had produced a one-line log file. Also fixed `log.write` letting a caller's field overwrite the log envelope |
| A5 · audio levels measured at stop, silence surfaced to the user | ✅ | M-023 classifier shared with the pipeline; warning banner appears before the user closes the app |

### Phase D — preview | ✅ done, verified

| Task | Status | Notes |
|---|---|---|
| D1 · `getSources` narrowed by source kind | ✅ | was capturing a thumbnail of every window every 2 s to pick one. WGC `E_INVALIDARG` spam: 68 errors / 133 s → 3 for a whole run (one device enumeration) |
| D2 · poll only while visible and on the Record tab, 2 s → 5 s | ✅ | it polled while minimised |
| D3 · every preview state renders a sentence; no stale thumbnail on failure | ✅ | "sometimes previews are missing" was the null-with-no-message path |

### Phase B — pipeline honesty | ✅ done, verified

| Task | Status | Notes |
|---|---|---|
| B1 · silence gate measures the signal, not loudnorm's output | ✅ | M-023. Same file: mic read −19.8 dB before, −53.5 dB after. Shared classifier with capture |
| B2 · stage outcomes carry a reason | ✅ | ADR-013. `StageOutcome` widened; every bare `skipped` now has a code. `PIPELINE_STAGE_FAILED` was being written but never declared — fixed |
| B3 · zero-segment honesty + data-loss fix | ✅ | M-024. `replaceTrackSegments` guarded: a re-run recognising nothing used to DELETE a good transcript |
| B4 · re-run clears the checkpoint | ✅ | M-025. `enqueue`/`retry` discard, `resetInterrupted` preserves — three paths, three intents |
| B5 · terminal `publish` stage owns cleanup | ✅ | M-025. Was in diarize's unconditional `finally`, so any skip destroyed the WAVs |
| B6 · job id + error code/detail cross IPC | ✅ | `jobs:retry` had zero callers because no job id ever reached the renderer. `error_detail` path-redacted |
| B7 · UI tells the truth | ✅ | `skipped` has its own badge; reason sentences under each meeting; Re-process always available; Regenerate no longer hidden when there is no summary; job events patch one row instead of re-querying 100 meetings per tick |
| B8 · `autoProcess` actually consulted | ✅ | defined, written by Settings, read by nothing |
| A4 completion · `no-console` enforced for `src/main/**` | ✅ | M-022's rule made mechanical; 25 remaining call sites converted. Zod issues and LLM/JSON error text deliberately not logged |

Verification: `npm run test:honesty` (new) — synthetic silence and tone cases assert on outcome
**codes**, no mic/speakers/focus needed. ALL PASS. 129 unit tests green, typecheck clean.
### Lint cleanup | ✅ done — and it was hiding a real bug

`npm run lint` had been red on `main` with 15 errors. Clearing them found **M-026**: the six
`no-control-regex` errors in `vlm.ts` were not pedantry — the source held literal backspace bytes
(0x08) where `` was intended, and the alternation was ungrouped, so *every* scene-keyword group
had a dead first and last keyword while its middle entries matched inside longer words
("powerpointless" classified as a slide; "a slide about budget" did not). Scene classification has
been wrong since Phase 5; the visual E2E never caught it because it asserts on captions, not
scene types. Keyword table + `parseReply` extracted to a pure `stages/vlm-scene.ts` — it had been
untestable because it lived beside an `electron` import, which is why it survived.

Lint is now **0 errors**. Remaining fixes were unused vars in scripts and a `.cjs` require
override for the electron-builder hook.

### Phase C — independent source toggles | ✅ done, verified

| Task | Status | Notes |
|---|---|---|
| C1 · "enabled" split from "chosen" | ✅ | M-027. `null` meant both "off" and "not picked", so Refresh silently re-enabled the camera. Seeds once from `cameraEnabledDefault` — a field unread since Phase 1 |
| C2 · silent device downgrade surfaced | ✅ | an enabled source whose `dshowName` never reconciled produced no track and said nothing. Now an error in the preview; `select()` auto-validates on a 400 ms debounce |
| C3 · off-state UI is honest | ✅ | a black `<video>` and a dead meter read as broken hardware. Off sources render a sentence with their own aria-label |
| C4 · `tests/**` typechecked | ✅ | new `tsconfig.test.json` wired into `npm run typecheck`; fixtures could previously drift from the schemas they claim to pin |
| — · `buildConfig` extracted to pure `capture-config.ts` | ✅ | it lived beside an `api` import that touches `window`, so it could not be imported by a test. Same root cause as M-026 |

ADR-014 records why this needed no schema change: **ADR-007 is about track ORDER, not absolute
index** — the code always computed indices dynamically; only the prose said otherwise. Mic off →
system audio is legitimately `a:0`, now pinned by tests.

Verification: lint 0 errors · typecheck (3 projects) clean · **146 unit tests** · live 12 s
recording still yields 2 video + 2 audio on the default all-on path.

### Phase E — Q&A report | ✅ done, verified on a real meeting

Runs from a button (ADR-015), not as part of automatic processing.

| Task | Status | Notes |
|---|---|---|
| E1 · consumes summarize's persisted map notes | ✅ | one llama call instead of a second map-reduce; falls back to the stored summary when the checkpoint is gone |
| E2 · zod + mirrored json_schema, probed with curl first | ✅ | M-015's rule. The probe is what found `minItems` (the model returned ONE pair without it) and all four prompt rules |
| E3 · timestamps snapped to real segments or dropped | ✅ | the probe caught the model reusing one fact's `t` on an unrelated answer. A wrong seek costs more than a missing one |
| E4 · `qa_reports` table, migration v2 | ✅ | own table, not a `kind` column — zero blast radius on the summary queries |
| E5 · `qa:get` / `qa:regenerate` / `qa:export` | ✅ | export copies `transcript:export` exactly: renderer names a format, main owns the save dialog. ipc-fuzz covers all three |
| E6 · third Library tab | ✅ | question, answer, click-to-seek when the timestamp survived snapping; degraded banner; md/txt/json export |
| E7 · llama-server lifecycle | ✅ | M-029: idle unloader could kill a model mid-answer (5 min idle vs 10 min request). Bounded stderr ring, logged only on failure |
| — · `cleanAnswer` strips leaked markers | ✅ | M-028: the model writes `t=19400` into the prose as well as the field |

Verification: `npm run test:qa` on a real 20-segment meeting — 6 content assertions, ALL PASS,
report not degraded. lint 0 · typecheck (3 projects) · **172 unit tests**.

### Phase F — storage location + sidecar files | ✅ done, verified

| Task | Status | Notes |
|---|---|---|
| F1/F2 · `media_root` per meeting, migration v3 | ✅ | applied to the live DB; all 56 existing meetings keep `userData` and resolve unchanged, `.pre-v3.bak` written. `media_path` stays RELATIVE — absolutising it would have destroyed the containment guarantee |
| F2 · all six resolution sites via `resolveMedia()` | ✅ | free hardening: `meetings:delete` had a bare `path.join` with **no containment check** before an `rmSync(recursive)` — the only media site without one |
| F3 · folder picker without breaking the IPC invariant | ✅ | ADR-016: paths may leave main in a *response*, never enter in a *request*. Write-probe validation (not `fs.access`), app-internal folders refused, 5 GB floor |
| F4 · existing recordings never move | ✅ | the setting governs new recordings only; bulk migration stays deferred |
| F5 · sidecars beside the `.mkv` | ✅ | `.md`/`.srt`/`.json` transcript + `.summary.md` + `.qa.md`. Verified: all five written, `.srt` validated by ffprobe (`format_name=srt`). Toggleable in Settings |
| F6 · folder disappears | ✅ | pre-flight is a **blocking error**; mid-recording, 3 consecutive failed disk probes (30 s) → `stop()` to salvage. A single transient statfs stays harmless |
| — · `media_root` stores the real folder, not a marker | ✅ | **M-031**: a `'custom'` marker made resolution depend on the CURRENT setting, so resetting the folder orphaned everything recorded under the old one — unplayable *and* undeletable. Found by the bulk delete, not by a unit test |
| — · harness integrity | ✅ | **M-030**: a stray Electron holds the single-instance lock, so a launch exits **0 without booting** — three smoke runs "passed" while migration v3 silently never applied. `scripts/electron-run.mjs` kills strays and asserts on a *freshly written* artefact |

Verification: `npm run test:storage` (new — records into a chosen folder, then **resets the
setting** and proves the row still resolves and still deletes) · `npm run test:qa` (also exercises
`publish`, so the sidecars) · sidecar contents inspected, `.srt` validated by ffprobe ·
`npm run test:honesty` · lint 0 · typecheck (3 projects) · 180 unit tests.

**Cleanup done (user's decision, 2026-08-31):** all 57 meetings deleted through the app's own
`deleteMeeting()` path — 549 MB of media plus 83 transcript segments, 6 summaries, 5 Q&A reports
and 170 job rows. Ten pre-database recordings left over from the Phase 1 spikes were removed too.
`meetfroge.db.pre-v2.bak` and `.pre-v3.bak` are kept. The Library starts empty.

---

## Post-v0.1.0 round 2 — reported 2026-08-31 (audio + file size)

Reported: *"system microphone is not working ... or voice ase nai"*, *"doita microphone ek
sathe kaj kore nah"*, *"on and off ... video er record er moddhe o korte parbo"*, *"video size
onek besi"*.

| Finding | Status | Notes |
|---|---|---|
| System audio capture itself | ✅ works | Measured: a tone played to the default output lands on the system track at −18.9 dB, band-checked at 600–900 Hz. Both tracks record together in one file — `scripts/audio-diagnose.mjs` answers this with a measurement, not a guess |
| **The real bug: no way to check beforehand** | ✅ fixed | **M-032** — `systemLevel` only updated inside `start()`, so the System meter read zero until Record was pressed. With three active output endpoints on this machine, a loopback on the wrong one was invisible until the meeting was over. The meter now runs live before recording, and `start()` REUSES that stream (which also satisfies M-020's ordering) |
| Mute mic / system **during** recording | ✅ done | **M-034** — ffmpeg accepts a filter command on the stdin already used for `q`: `cvolume@mic -1 volume 0` (no space after `c`, time field required). Named volume filters mean the track is silenced, never removed, so segments stay concatenable (M-011). Verified live: −20.1 dB → −91.0 dB mid-recording, mic unaffected |
| File size | ✅ 13× smaller | **M-033 / B-011** — every preset moved from fixed bitrate to quality-based rate control. `high` end-to-end: **3.40 → 0.26 GB/hour**, same 1080p30, same tracks |

## Post-v0.1.0 round 3 - gap review, 2026-09-01

Asked what was missing for daily use. The sharpest finding was a documentation claim rather than
a bug: **R-07 listed "transcript is editable" as the mitigation for Banglish accuracy, and it was
not** (M-035). The `edited` column had existed unused since the v1 schema.

| Gap | Status | Notes |
|---|---|---|
| Transcript editing | done | Click a line to correct it. FTS row rewritten in the same transaction, line marked as edited, UI prompts to regenerate the summary. Makes R-07's stated mitigation real |
| Speaker names per meeting | done | `known_speakers` (migration v4). Speakers stay per-meeting - no voice identification is claimed - but the NAMES are offered as suggestions, so a recurring colleague is typed once |
| No summary export | done | `summary:export` md/txt/json, matching transcript and Q&A. The sidecar file already existed; the button did not |
| `meetings.notes` column dead | done | In the schema since v1, never read or written. Now a notes field per meeting |
| No way to flag a moment live | done | `markers` table (migration v4) + a Mark-moment button while recording. Anchored to elapsed time so pauses do not shift it, shown in the Library, and fed to the summarizer as the only human-judgement signal in the pipeline |

Verification: `npm run test:features` (new) - exercises all four against the real database and
cleans up after itself. lint 0, typecheck (3 projects), 206 unit tests.

Still open: R-11 (~1 s mic-system skew), live transcript (ADR-006, v1.1), auto-update, disk
retention policy, bulk operations, list virtualization, encryption at rest, Bangla UI,
code signing, **CI has still never run** (account billing lock), manual release gates.

### Open items (non-blocking)

| Item | Status | Notes |
|---|---|---|
| Windows code signing | ⏸ | Deferred to Phase 10. Recommendation: ship unsigned for v1.0 (conventional for OSS, genuinely $0). |
| Recording consent framing | ⏸ | Needs user confirmation. `docs/legal.md` + first-run acknowledgement. |
| Bangla UI localization | ⏸ | Infrastructure in Phase 9; shipping a translation for v1.0 is a separate call. |

---

## Camera picture-in-picture (2026-09-01)

The camera can now be composited onto the screen track instead of only living beside it. Position
(four corners) and size (10–40% of screen height) are chosen on the recording board, persisted as
app settings, and the screen preview shows the live camera in the corner it will actually occupy.

The camera **keeps its own raw track** — this is the design point, not a compromise (ADR-017). The
stream count is identical with the overlay on or off, so segments stay concat-compatible (M-011),
`detectCameraPresence` needed no change, and `session.ts` can fall back to no-overlay mid-recording
and still produce a joinable file.

Two mistakes came out of it, both now documented: `hwupload` is a property of the CHAIN and not of
the encoder (M-036 — the composite worked on ddagrab and killed the recording on gdigrab), and a
measurement harness that reads ffmpeg's numbers off stdout reports "could not measure" as a failed
check (M-037).

Verification: `npm run test:pip` (new) records twice through the real app, with the overlay on and
off, and compares the overlay rectangle in `v:0` against the raw camera in `v:1` — 47.13 dB with,
7.49 dB without. The control run is what makes the first number mean anything. Cost measured in
B-013: +15 points of one core out of twelve, +23% on the screen track's bytes. lint 0, typecheck
(3 projects), 231 unit tests.

Still unreviewed visually, like the rest of the recent UI work.
