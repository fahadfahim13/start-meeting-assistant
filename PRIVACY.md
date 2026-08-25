# Privacy

MeetFroge records private conversations. That makes privacy the core of the product, not a
policy page. This document states exactly what happens to your data.

## The commitments

1. **No telemetry.** Not opt-out, not anonymized, not "essential only" — **absent**. There is no
   analytics code in this repository. CI fails the build if a known analytics package is added.

2. **No runtime network calls.** The only network activity is downloading models, which you start
   explicitly and can see the progress of. Disconnect the network afterwards and every feature
   continues to work.

3. **All processing is local.** Transcription, diarization, OCR, vision analysis and summarization
   all run on your machine, using models stored on your disk.

4. **Recording is always visible.** A tray indicator and a window badge show whenever a recording
   is active. This cannot be disabled by any setting, because it is a safety control rather than
   a preference.

5. **Crash logs stay local.** They are written to your disk, rotated after 7 days, and never
   transmitted. If you choose to file a bug report, you decide what to attach.

6. **No accounts.** There is nothing to sign up for and no identifier associated with you.

## What is stored, and where

Everything lives under `%LOCALAPPDATA%\MeetFroge\` (configurable), with filesystem permissions
restricted to your user account:

| | |
|---|---|
| `recordings/` | Video and audio, standard MKV |
| `frames/` | Extracted keyframe images |
| `models/` | Downloaded model files |
| `meetfroge.db` | SQLite: transcripts, summaries, keyframe text, metadata |
| `logs/` | Rotating diagnostic logs, 7-day retention |

Standard formats throughout. If you stop using MeetFroge, your recordings are ordinary video
files and your transcripts are ordinary JSON. There is nothing to export yourself out of.

## What is never logged

The diagnostic logs deliberately exclude the content of your meetings: transcript text, OCR text,
and model output are passed through a redaction layer and never reach a log file. Logs contain
timings, error codes, ffmpeg arguments with paths redacted, and job state — enough to diagnose a
problem, not enough to reconstruct a conversation.

## Encryption at rest

Optional, off by default, toggleable in Settings.

**What it does.** Media files are encrypted with AES-256-GCM. The database is encrypted with
SQLCipher. The data key is generated locally and wrapped using Windows DPAPI through Electron's
`safeStorage`, binding it to your Windows user account.

**What it protects against.** Another user on the same machine. Someone reading the disk offline —
a stolen laptop, a recovered drive, a backup.

**What it does not protect against.** Malware running as *you*. DPAPI unwrapping succeeds for
anything in your user session, by design. Encryption at rest is not a defence against a
compromised account, and we would rather say so than let the toggle imply otherwise.

It is off by default because it costs CPU on every read and write, and because most users are
better served by full-disk encryption (BitLocker) covering everything at once.

## Deleting data

Deleting a meeting removes its media, frames, database rows and search index entries. With
"secure delete" enabled, media files are overwritten before unlinking and the database is
`VACUUM`ed afterwards so freed pages are not left readable.

Note that overwrite-based deletion is unreliable on SSDs due to wear levelling — the controller
may not overwrite the physical blocks. For genuinely sensitive material, full-disk encryption is
the answer, not secure delete.

## Exports

Exported files are sanitized: no absolute paths, no machine identifiers, no account name. What
leaves your machine is entirely your decision — MeetFroge never initiates it.

## Recording other people

MeetFroge records conversations, and in many jurisdictions recording a conversation requires the
consent of some or all participants. The always-visible recording indicator exists partly for
this reason.

Complying with the law where you are is your responsibility. See [docs/legal.md](docs/legal.md).

## Changes

Material changes to this document are recorded in [CHANGELOG.md](CHANGELOG.md) and called out in
release notes. The commitments above are architectural, not policy: reversing them would require
an ADR and a visible code change in a public repository.
