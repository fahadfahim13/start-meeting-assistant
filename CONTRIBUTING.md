# Contributing to MeetFroge

Thanks for your interest. This document covers what you need to be productive here, including a
few rules that are stricter than usual and the reasons why.

## Before you start

**If you are touching the capture engine or anything that invokes ffmpeg, read
[MISTAKES.md](MISTAKES.md) first.** It records non-obvious failures already discovered and paid
for. Reading it takes two minutes and will save you hours.

**If you are changing an architectural choice**, check [DECISIONS.md](DECISIONS.md) to see whether
it was already considered and rejected, and why. Reversing a decision is fine — reversing it
without knowing it was a decision is not.

## Development setup

```bash
git clone https://github.com/fahadfahim13/meetfroge.git
cd meetfroge
nvm use          # Node 22.13.1, pinned in .nvmrc
npm ci           # npm ci, never npm install
npm run dev
```

Building whisper.cpp and llama.cpp with Vulkan, and downloading models, is covered in
[docs/setup.md](docs/setup.md).

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint + prettier
npm run test         # unit + integration
npm run test:e2e     # Playwright
```

## The rules that are stricter than usual

These exist because of what this application is: a privileged desktop process that spawns native
binaries and handles recordings of private conversations.

**1. `shell: false` on every subprocess spawn. No exceptions.**
Pass argv arrays. Never build a command string, never interpolate a variable into one. Device
names come from the OS and are attacker-influenceable — a malicious virtual device can name itself
anything.

**2. No renderer-supplied filesystem paths cross IPC.**
The renderer sends identifiers (`meetingId`, `exportFormat`); the main process resolves paths
internally. If you find yourself adding a `path` field to an IPC payload, stop and reconsider.

**3. Every IPC payload is schema-validated at the boundary, both directions.**
Add the zod schema in `src/shared/schemas/` and wire it into the gateway. An unvalidated channel
will not be merged.

**4. Mic and system audio are never mixed into one track.**
`a:0` is the microphone, `a:1` is system audio. This separation is what gives exact speaker
identification. Code that mixes them destroys a core capability.

**5. Encoder capability is probed by running a real one-second encode.**
Never by reading `ffmpeg -encoders`. `h264_amf` is listed as available on hardware where it fails
(see MISTAKES.md M-001). This is the exact trap the probe exists to avoid.

**6. Transcript, OCR and LLM text are never written to logs.**
Route anything that might contain meeting content through the redaction layer.

**7. No analytics or telemetry packages.**
CI enforces this. It is a product commitment, not a preference.

**8. Adding a dependency requires justification in the PR description.**
Say what it does, why the standard library or an existing dependency will not, and what its
transitive footprint is. Dependency count is tracked as a security metric — every package is
code that ships to users and could be compromised upstream.

## Pull requests

1. Branch from `main`: `feat/short-description` or `fix/short-description`.
2. Commit using [Conventional Commits](https://www.conventionalcommits.org/) —
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Enforced by commitlint.
3. Include tests. Capture and pipeline code has an 85% coverage target; everything else 80%.
4. Update documentation **in the same PR** as the code, not afterwards.
5. If you hit a non-obvious failure while working, add an entry to `MISTAKES.md`. This is the most
   valuable thing you can contribute — the `Rule` line especially.
6. If you made a non-obvious architectural choice, add an ADR to `DECISIONS.md`.
7. Update `PROGRESS.md` if your work completes a tracked task.

CI must be green: typecheck, lint, tests, `npm audit --audit-level=high`, license compliance,
performance budgets, and the loopback-audio smoke test.

## Testing on hardware you do not have

Much of this project is hardware-dependent — AMD versus NVIDIA encoders, Vulkan present or absent,
integrated versus discrete GPUs. You are not expected to have all of it.

Force specific code paths with environment variables (see `.env.example`):

```bash
MEETFROGE_FORCE_ENCODER=libx264   # test the software fallback
MEETFROGE_DISABLE_VULKAN=1        # test the CPU inference path
```

If you cannot test a path, say so in the PR. An honest "untested on NVIDIA" is far more useful
than a silent assumption.

## Reporting bugs

Use the issue templates. For anything involving recording, please attach a diagnostic bundle
(Settings → Logs → Copy diagnostic bundle). It contains timings, error codes and ffmpeg
arguments — no meeting content.

For security vulnerabilities, do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under GPL-3.0-or-later, matching the project. By submitting a pull
request you agree your contribution is licensed on those terms.
