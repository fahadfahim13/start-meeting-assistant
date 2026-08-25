# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately via [GitHub Security Advisories](https://github.com/fahadfahim13/meetfroge/security/advisories/new),
or by email to the maintainer listed in the repository metadata.

Please include: what the issue is, how to reproduce it, what an attacker could achieve, and the
version and OS you tested on.

**Response commitments:**

| | Target |
|---|---|
| Acknowledgement | 72 hours |
| Initial assessment | 7 days |
| Fix or mitigation plan | 30 days for high/critical |

This is a solo-maintained project. Those are honest targets, not an SLA. Credit is given in the
advisory and changelog unless you prefer otherwise.

## Scope

**In scope:** the MeetFroge application — Electron main and renderer, IPC boundary, subprocess
handling, filesystem access, encryption at rest, model and binary integrity verification,
the build and release pipeline.

**Out of scope:** vulnerabilities in upstream dependencies (report those upstream, then tell us so
we can pin or patch), and attacks requiring an already-compromised OS user account — see the
threat model below for why.

## Threat model

MeetFroge is a local desktop application. There is no server, no authentication, and no
multi-tenancy. But it holds extremely sensitive data — recordings of private conversations — and
it runs privileged native subprocesses. Security effort concentrates accordingly.

| # | Threat | Mitigation |
|---|---|---|
| T1 | Malicious npm dependency exfiltrates recordings | Lockfile + `npm ci` only, SBOM per release, Renovate, no runtime network egress, CSP blocks all remote origins |
| T2 | Another local user reads recordings from disk | Optional AES-256-GCM at rest, key wrapped by DPAPI via Electron `safeStorage`; restrictive ACLs on the data directory |
| T3 | Renderer compromised via transcript/OCR/LLM text, escalating to RCE | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP, React auto-escaping, no `dangerouslySetInnerHTML`, Electron fuses |
| T4 | Path traversal via meeting name or export path | Path allowlist plus a `path.resolve` containment check on every filesystem operation |
| T5 | Command injection through device names or paths into ffmpeg | **Never `shell: true`.** argv arrays only. No string interpolation into commands, ever |
| T6 | Tampered model file | SHA-256 pinned per model, verified before load; downloads restricted to a host allowlist |
| T7 | Tampered bundled binary (ffmpeg, whisper, llama) | Hash manifest verified at first run and after each update; ASAR integrity fuse |
| T8 | Covert recording | Non-suppressible tray indicator, window badge, OS-level camera/mic indicators. Recording state is an invariant, not a preference |
| T9 | Sensitive content leaked into logs or crash dumps | Structured logging with a redaction layer; transcript, OCR and LLM text are never logged; crash dumps stay local |
| T10 | Malicious update package | Signed releases, `electron-updater` signature verification, pinned update source |
| T11 | Prompt injection from meeting content steering the summary | Summary output is data, never executed; strict schema validation; content explicitly delimited; the summarizer has no tools |
| T12 | Denial of service via disk exhaustion | Pre-flight and live disk guards with a hard floor and clean auto-stop; retention policy |

### What this does not protect against

Stated plainly, because vague security claims are worse than none:

- **Malware running as your own OS user.** Encryption at rest is keyed to your Windows account
  via DPAPI. Anything running as you can unwrap it. This protects against other local users and
  offline disk access, not against a compromised session.
- **A compromised build environment.** Reproducible builds are on the roadmap, not yet implemented.
- **Physical access with your credentials.**

## Security-relevant invariants

These are enforced in code review and CI. A change that violates one is a security regression
regardless of what else it does:

- `shell: false` on every subprocess spawn. No exceptions.
- No renderer-supplied filesystem path ever crosses IPC. The renderer sends identifiers; the main
  process resolves paths.
- No IPC channel accepts SQL, a command string, a module path, or a function name.
- Every IPC payload is schema-validated at the boundary, in both directions.
- Binary paths resolve from app resources, never from `PATH` at runtime.
- Transcript, OCR and LLM text are never written to logs.
- `llama-server` binds to `127.0.0.1` on an ephemeral port with a per-session random token.
- No analytics or telemetry package may be added — CI enforces this.
