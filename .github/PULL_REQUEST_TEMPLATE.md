## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

Closes #

## How

<!-- Approach, and anything non-obvious about it. -->

---

## Checklist

**Always:**

- [ ] Tests added or updated
- [ ] Docs updated **in this PR**, not a follow-up
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` pass locally
- [ ] Conventional Commits used

**If you hit a non-obvious failure while working on this:**

- [ ] Added an entry to `MISTAKES.md` — including the `Rule` line, which is the part that matters

**If you made a non-obvious architectural choice:**

- [ ] Added an ADR to `DECISIONS.md`

**If this completes a tracked task:**

- [ ] Updated `PROGRESS.md`

**If you measured anything:**

- [ ] Recorded it in `docs/benchmarks.md` with the exact command

---

## Security review

Tick every line that applies to the code you touched. If none apply, say so.

- [ ] No `shell: true` introduced anywhere
- [ ] No filesystem path accepted from the renderer over IPC
- [ ] New IPC channels are allowlisted and schema-validated in both directions
- [ ] No transcript, OCR or model output written to logs
- [ ] No new analytics or telemetry package
- [ ] Encoder capability still probed by a real encode, never by reading `-encoders`
- [ ] Mic and system audio remain separate tracks
- [ ] N/A — this PR touches none of the above

## Dependencies

<!-- If you added a dependency, justify it: what it does, why the standard library or an
     existing dependency will not do, and its transitive footprint. Dependency count is
     tracked as a security metric. Delete this section if you added none. -->

## Hardware tested

<!-- Much of this project is hardware-dependent. State what you actually tested on, and
     be explicit about what you could not test. An honest "untested on NVIDIA" is far more
     useful than a silent assumption. -->

- OS / CPU / GPU:
- Encoder path exercised:
- Untested paths:
