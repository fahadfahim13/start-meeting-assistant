# Testing strategy

## Layers

| Layer | Tool | Target | What it actually protects |
|---|---|---|---|
| Unit | Vitest | ≥ 80% | ffmpeg argv construction, pHash, VAD region merging, transcript chunking, zod schemas, path guards |
| Integration | Vitest + real binaries | ≥ 70% | Full pipeline against a fixture recording |
| E2E | Playwright + Electron | critical paths | Setup → record → process → summary → export |
| Security | custom + CodeQL | 100% of IPC channels | Every channel rejects malformed and hostile input |
| Performance | custom harness | all budgets | Regressions fail CI rather than being noticed later |
| Smoke | CI, every PR | loopback audio | The Electron-version regression guard |

Capture and pipeline code carry a higher bar (85%) than the rest of the codebase, because they
are where failure is both most likely and most costly.

## Fixtures

`tests/fixtures/` holds a committed 30-second recording with **known** content:

- a known spoken script (for word error rate)
- exactly 3 slide changes at known timestamps (for keyframe detection)
- 2 distinct speakers on the system track plus one on the mic (for diarization)
- 4 seconds of deliberate silence (for VAD)
- a clapper transient at the start and end (for A/V sync)

This is what makes pipeline assertions concrete rather than approximate. A test that asserts
"produced some keyframes" is not a test; "produced exactly 3 keyframes at 4s, 12s and 23s ±1s" is.

## Performance budgets

Asserted in CI, not merely documented. Exceeding one fails the build.

| Scenario | Budget |
|---|---|
| Idle | < 150 MB RAM, < 1% CPU |
| Recording, Balanced preset | < 400 MB RAM, < 15% CPU, zero dropped frames |
| Transcription, 1 h meeting | < 2.5 GB RAM, < 20 min |
| Visual analysis, 1 h meeting | < 2 GB RAM, < 10 min |
| Summarization, 1 h meeting | < 4 GB RAM, < 10 min |
| Full pipeline, 1 h meeting | < 40 min |
| Storage per recorded hour | < 0.5 GB (measured 0.26 at `high`; was 3.40 before quality-based encoding — B-011) |
| Cold start to interactive | < 1.5 s |

## IPC security tests

Every channel gets the same battery, generated from the channel registry so a new channel cannot
be added without being covered:

- missing required fields
- wrong types for every field
- oversized payloads
- path traversal strings (`../`, absolute paths, UNC paths, NTFS alternate data streams)
- SQL fragments and shell metacharacters in every string field
- unicode normalization tricks in filenames
- unknown channel names
- rapid-fire calls on rate-limited channels

Expected behaviour throughout: rejection at the boundary, a typed error, and no handler invocation.

## Manual test matrix

Automated tests cannot cover hardware variation. Run before each release, record results in the
release PR:

| Dimension | Cases |
|---|---|
| GPU | AMD iGPU (REF-01) · NVIDIA discrete · Intel iGPU · no Vulkan |
| Encoder | AMF · NVENC · QSV · libx264 forced |
| Displays | single · dual same-DPI · dual mixed-DPI · HDR |
| Camera | present · absent · unplugged mid-recording · in use by another app |
| Camera overlay | each of the four corners · 10% and 40% · off · window capture (gdigrab, no d3d11 — M-036) · camera unplugged with the overlay on |
| Audio | system audio present · silent · output device changed mid-recording · Bluetooth |
| Storage | ample · near floor · exhausted mid-recording |
| Power | AC · battery · battery with processing paused |
| Interruption | app killed mid-recording · machine sleep · driver crash |
| Duration | 30 s · 30 min · 3 h |

The long-duration and mid-recording-interruption cases are the ones that find real bugs. A
30-second test proves almost nothing about a recorder.

## Testing hardware you do not have

Force code paths with environment variables rather than guessing:

```bash
MEETFROGE_FORCE_ENCODER=libx264   # software fallback
MEETFROGE_DISABLE_VULKAN=1        # CPU inference path
```

If you cannot test a path, say so explicitly in the PR. An honest "untested on NVIDIA" is more
useful than a silent assumption.

## Running

```bash
npm run test              # unit + integration
npm run test:unit
npm run test:integration  # requires fetched binaries
npm run test:e2e          # Playwright
npm run test:security     # IPC battery
npm run test:perf         # budget assertions
npm run test:coverage
```

## Release gate additions (v0.1.0)

| Check | How | Status source |
|---|---|---|
| Packaged smoke | `MEETFROGE_SMOKE=1 release/win-unpacked/MeetFroge.exe` → smoke.json in `%APPDATA%/MeetFroge/out/` | automated, must pass before tagging |
| Forced software encode | `MEETFROGE_AUTOREC=20 MEETFROGE_FORCE_ENCODER=libx264` → ≥60% duration, 4 tracks | automated |
| Clean-VM install | run the NSIS installer on a machine without dev tools; record → transcript → summary | **manual, needs the user** |
| Screen-reader pass | Narrator over Record + Library + Settings | manual |
| 3-hour recording | duration + drift + disk behavior | manual |
