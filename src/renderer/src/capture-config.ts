import type { DeviceInventory } from '@shared/schemas/devices'
import type { CaptureConfig, QualityPreset } from '@shared/schemas/capture'

/**
 * Turning the user's source selection into a CaptureConfig — pure, no store, no
 * preload bridge, no `window`.
 *
 * It lives here rather than in `store.ts` for the same reason `vlm-scene.ts`
 * exists: `store.ts` imports `api`, which touches `window` at module load, so
 * anything defined beside it cannot be imported by a unit test at all. This is
 * the mapping that decides whether a track gets recorded; it needs a test more
 * than most of the file it came from.
 */

/**
 * "Which device" and "is it on" are separate facts.
 *
 * They used to be one: `cameraDeviceId: null` meant both "off" and "nothing
 * chosen". Two consequences, both bugs — turning a source off forgot which
 * device it was, and `refreshDevices()` re-picked a default with `?? ...`, so
 * pressing Refresh silently turned the camera back on.
 */
export interface Selection {
  screenId: string | null
  cameraDeviceId: string | null
  cameraEnabled: boolean
  microphoneDeviceId: string | null
  microphoneEnabled: boolean
  systemAudio: boolean
  preset: QualityPreset
  title: string
}

/** Everything the config builder actually reads. */
export interface ConfigSource {
  inventory: DeviceInventory | null
  selection: Selection
}

export function buildConfig(state: ConfigSource): CaptureConfig {
  const inv = state.inventory
  const sel = state.selection
  const screen = inv?.screens.find((s) => s.id === sel.screenId) ?? null
  const camera = inv?.cameras.find((c) => c.deviceId === sel.cameraDeviceId) ?? null
  const mic = inv?.microphones.find((m) => m.deviceId === sel.microphoneDeviceId) ?? null

  return {
    title: sel.title || `Meeting ${new Date().toLocaleString()}`,
    preset: sel.preset,
    screen: screen
      ? {
          sourceId: screen.id,
          kind: screen.kind,
          displayIndex: screen.displayIndex,
          windowTitle: screen.kind === 'window' ? screen.name : null,
          label:
            screen.kind === 'window'
              ? screen.name.slice(0, 256)
              : `Screen ${(screen.displayIndex ?? 0) + 1}`,
        }
      : null,
    // ADR-007 is about ORDER (mic before system), not absolute index. With the
    // mic off, system audio legitimately becomes a:0 — ffmpeg-builder computes
    // input indices dynamically and extract-audio derives the track index from
    // the has_mic/has_system_audio flags, so nothing downstream breaks.
    //
    // An ENABLED source whose dshowName failed reconciliation still becomes
    // null here — ffmpeg has no other way to name the device. That silent
    // downgrade is reported by enabledButUnavailable() so the user is told
    // rather than discovering a missing track afterwards.
    camera: sel.cameraEnabled && camera?.dshowName ? { dshowName: camera.dshowName } : null,
    microphone: sel.microphoneEnabled && mic?.dshowName ? { dshowName: mic.dshowName } : null,
    systemAudio: sel.systemAudio,
  }
}

/**
 * Sources the user has switched ON that cannot actually be recorded, because
 * their WebRTC label never reconciled to a DirectShow name (reconcile.ts
 * returns null rather than guessing).
 */
export function enabledButUnavailable(state: ConfigSource): string[] {
  const inv = state.inventory
  const sel = state.selection
  const out: string[] = []
  if (sel.cameraEnabled && sel.cameraDeviceId) {
    const cam = inv?.cameras.find((c) => c.deviceId === sel.cameraDeviceId)
    if (cam && !cam.dshowName) out.push(cam.label)
  }
  if (sel.microphoneEnabled && sel.microphoneDeviceId) {
    const mic = inv?.microphones.find((m) => m.deviceId === sel.microphoneDeviceId)
    if (mic && !mic.dshowName) out.push(mic.label)
  }
  return out
}
