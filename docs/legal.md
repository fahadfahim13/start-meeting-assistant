# Legal notes

**This is not legal advice.** It is a plain description of the obligations that come with
recording software, so that you can make an informed decision. If you need certainty, consult a
lawyer in your jurisdiction.

## Recording consent

MeetFroge records conversations. In many places, recording a conversation requires consent —
sometimes from one participant (which can be you), sometimes from all of them.

Roughly, and with many exceptions:

- **One-party consent** — recording is permitted if at least one participant (you) consents.
  Common in much of the United States and in the UK for personal use.
- **All-party consent** — every participant must consent. Applies in several US states
  (California, Florida, Illinois, Pennsylvania, Washington and others), and broadly across the
  EU under GDPR, where a recording of identifiable people is personal data.
- **Workplace recording** may be governed separately by employment law and company policy, even
  where general recording law would permit it.
- **Cross-border meetings** may engage more than one jurisdiction's rules at once. The
  conservative approach is to follow the strictest that applies.

**Complying with the law where you are is your responsibility.** MeetFroge cannot know your
jurisdiction, who is on your call, or what they have agreed to.

## What MeetFroge does to help

- A recording indicator is always visible — tray icon, window badge, optional always-on-top pill.
  **It cannot be disabled by any setting**, because a recorder that can hide itself is a
  surveillance tool.
- The operating system's own camera and microphone indicators remain active and are never
  suppressed.
- A first-run acknowledgement notes that consent is your responsibility.

These are deliberate design constraints, not features that could be traded away later. See
[SECURITY.md](../SECURITY.md) threat T8.

## Practical suggestions

- Announce recording at the start of the meeting and let the announcement be recorded. This
  creates evidence of notice.
- For all-party jurisdictions, get explicit agreement before starting.
- Some meeting platforms display their own recording banner. MeetFroge captures the screen
  externally, so **it will not trigger that banner** — the other participants have no automatic
  way to know. Announcing is on you.
- Consider retention: keeping recordings indefinitely may create obligations under data
  protection law, particularly under GDPR where others are identifiable. The retention policy
  in Settings exists partly for this.

## GDPR, briefly

If you record identifiable people in the EU/UK, you are likely processing personal data:

- You need a lawful basis (usually consent, or legitimate interest with a balancing test).
- Participants may have rights of access, rectification and erasure over the recording.
- You should not keep recordings longer than necessary for your stated purpose.

Because MeetFroge processes everything locally and transmits nothing, there is no processor
relationship with the software's author and no international transfer to account for. The
recordings are yours, held by you, and the obligations that attach to them are yours too.

## Software licensing

MeetFroge is licensed under [GPL-3.0-or-later](../LICENSE).

If you distribute the application, or a modified version, GPL-3.0 requires that you make the
corresponding source available under the same terms. This applies to distribution, not to
personal use, and not to the recordings you make with it — **your recordings are your own work
and are not covered by the app's license.**

Bundled components and their licenses are listed in `THIRD_PARTY_NOTICES.md`, generated at build
time. The reason the project is GPL rather than permissive is explained in
[ADR-009](../DECISIONS.md#adr-009--gpl-30-or-later): the bundled ffmpeg build includes libx264,
which is the CPU encoding fallback needed for machines without hardware encoders.

## Model licenses

The models MeetFroge downloads carry their own terms, all permissive:

| Model | License |
|---|---|
| Whisper (OpenAI) | MIT |
| Qwen3 (Alibaba) | Apache-2.0 |
| SmolVLM2 (HuggingFace) | Apache-2.0 |
| Moondream2 | Apache-2.0 |
| sherpa-onnx models | Apache-2.0 |
| Tesseract traineddata | Apache-2.0 |

Models with use-restricting custom licenses are deliberately avoided, which is why Gemma is not
used despite its quality.

## No warranty

Per GPL-3.0 sections 15 and 16, MeetFroge is provided without warranty. Recording software can
fail — a driver update, a device disconnection, a full disk. The architecture is built to make
loss unlikely (segmented recording, crash recovery, integrity verification), but **for anything
irreplaceable, keep a second recording.**
