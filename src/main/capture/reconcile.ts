/**
 * WebRTC ↔ DirectShow device-name reconciliation (docs/risks.md R-06).
 * Pure — no Electron imports — so it stays unit-testable.
 *
 * The two APIs usually agree on the friendly name, but Chromium sometimes
 * appends a " (vid:pid)" USB suffix that DirectShow does not use.
 * Matching order: exact → suffix-stripped → substring. Null over guessing.
 */

/** Chromium may append " (04f2:b6f1)"-style USB ids that dshow names lack. */
export function stripUsbSuffix(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
}

export function reconcile(webrtcLabel: string, dshowNames: string[]): string | null {
  if (dshowNames.includes(webrtcLabel)) return webrtcLabel
  const stripped = stripUsbSuffix(webrtcLabel)
  const exact = dshowNames.find((n) => n === stripped)
  if (exact) return exact
  const partial = dshowNames.find((n) => n.includes(stripped) || stripped.includes(n))
  return partial ?? null
}
