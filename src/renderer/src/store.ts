import { create } from 'zustand'
import type { DeviceInventory } from '@shared/schemas/devices'
import type { InvokeResponse } from '@shared/ipc'
import type { SessionStatus, ValidationResult } from '@shared/schemas/capture'
import { QUALITY_PROFILES } from '@shared/schemas/capture'
import { api } from './api'
import {
  buildConfig,
  enabledButUnavailable,
  type ConfigSource,
  type Selection,
} from './capture-config'

// Re-exported so components import capture concerns from one place.
export { buildConfig, enabledButUnavailable }
export type { ConfigSource, Selection }
import { startLoopback, type LoopbackHandle } from './audio/loopback'


/**
 * The camera-overlay controls live on the recording BOARD rather than in
 * Settings — it is a framing decision you make while looking at the preview,
 * next to the camera you are framing. It is still a persisted app setting, so
 * the choice survives a restart; the board is just where it is edited.
 *
 * The union comes from the IPC contract rather than being retyped here, so the
 * renderer cannot drift from what main will actually accept.
 */
type OverlaySettings = Pick<
  InvokeResponse<'settings:get'>,
  'cameraOverlay' | 'cameraOverlaySizePct'
>
export type OverlayPosition = OverlaySettings['cameraOverlay']

interface AppState {
  inventory: DeviceInventory | null
  devicesError: string | null
  selection: Selection
  /** Null until the first settings:get resolves. */
  overlay: OverlaySettings | null
  validation: ValidationResult | null
  session: SessionStatus | null
  systemLevel: number
  busy: boolean
  /** True from just BEFORE session:start until stop/failure — previews must
   *  release their devices before ffmpeg tries to open them (M-007). */
  previewsSuspended: boolean

  /** True while the pre-record system-audio meter is running. */
  systemPreviewOn: boolean

  refreshDevices(): Promise<void>
  loadOverlay(): Promise<void>
  setOverlay(patch: Partial<OverlaySettings>): Promise<void>
  startSystemPreview(): Promise<void>
  stopSystemPreview(): void
  setMuted(track: 'mic' | 'system', muted: boolean): Promise<void>
  select(patch: Partial<Selection>): void
  validate(): Promise<void>
  start(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}

let loopback: LoopbackHandle | null = null
let levelTimer: ReturnType<typeof setInterval> | null = null
let validateTimer: ReturnType<typeof setTimeout> | null = null


export const useStore = create<AppState>((set, get) => {
  // Session state pushed from main.
  api.onSessionState((raw) => {
    set({ session: raw as SessionStatus })
  })

  return {
    inventory: null,
    devicesError: null,
    selection: {
      screenId: null,
      cameraDeviceId: null,
      // Seeded once from the preset's cameraEnabledDefault on the first device
      // enumeration. Never re-seeded: an explicit choice outranks a default.
      cameraEnabled: true,
      microphoneDeviceId: null,
      microphoneEnabled: true,
      systemAudio: true,
      preset: 'balanced',
      title: '',
    },
    overlay: null,
    validation: null,
    session: null,
    systemLevel: 0,
    systemPreviewOn: false,
    busy: false,
    previewsSuspended: false,

    async refreshDevices() {
      set({ devicesError: null })
      try {
        // Labels require a one-time getUserMedia grant; tracks stop immediately.
        try {
          const grant = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
          grant.getTracks().forEach((t) => t.stop())
        } catch {
          /* camera-less machines still enumerate mics */
        }
        const all = await navigator.mediaDevices.enumerateDevices()
        const result = await api.invoke('devices:enumerate', {
          webrtcCameras: all
            .filter((d) => d.kind === 'videoinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' })),
          webrtcMicrophones: all
            .filter((d) => d.kind === 'audioinput' && !d.label.toLowerCase().includes('communications'))
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })),
        })
        if (!result.ok) {
          set({ devicesError: result.error.message })
          return
        }
        const inv = result.data
        const sel = get().selection
        const firstRun = get().inventory === null
        set({
          inventory: inv,
          selection: {
            ...sel,
            screenId: sel.screenId ?? inv.screens.find((s) => s.kind === 'screen')?.id ?? null,
            // Auto-pick a device only when none is remembered. The toggles are
            // untouched here: re-enumerating hardware is not a reason to
            // re-enable a source the user deliberately switched off.
            cameraDeviceId: sel.cameraDeviceId ?? inv.cameras.find((c) => !c.isVirtual)?.deviceId ?? null,
            microphoneDeviceId: sel.microphoneDeviceId ?? inv.microphones[0]?.deviceId ?? null,
            cameraEnabled: firstRun
              ? QUALITY_PROFILES[sel.preset].cameraEnabledDefault
              : sel.cameraEnabled,
          },
        })
      } catch (e) {
        set({ devicesError: String(e) })
      }
    },

    async loadOverlay() {
      const r = await api.invoke('settings:get', {})
      if (r.ok) {
        set({
          overlay: {
            cameraOverlay: r.data.cameraOverlay,
            cameraOverlaySizePct: r.data.cameraOverlaySizePct,
          },
        })
      }
    },

    async setOverlay(patch) {
      const current = get().overlay
      if (!current) return
      const next = { ...current, ...patch }
      // Optimistic: the control has to feel immediate, and main is the only
      // writer — a rejected patch is corrected by the reload below.
      set({ overlay: next })
      await api.invoke('settings:set', patch)
      await get().loadOverlay()
      // The overlay changes what the screen track costs, so the size estimate
      // in the footer is now stale.
      void get().validate()
    },

    select(patch) {
      set({ selection: { ...get().selection, ...patch }, validation: null })
      // Validate as the setup changes rather than only when someone presses
      // "Check setup" - which nobody does. session:validate already warns
      // correctly about a silent configuration; it was simply never seen.
      // Cheap: probeCapabilities() is memoised (M-016) and the disk check is a
      // statfs. Title keystrokes are excluded - they cannot invalidate anything.
      if (Object.keys(patch).length === 1 && 'title' in patch) return
      if (validateTimer) clearTimeout(validateTimer)
      validateTimer = setTimeout(() => {
        validateTimer = null
        void get().validate()
      }, 400)
    },

    /**
     * Run the system-audio meter BEFORE recording.
     *
     * Without this the System meter reads zero until Record is pressed, so
     * there was no way to find out that loopback was capturing nothing until
     * after the meeting — which is exactly how "the other person's voice is
     * missing" happened silently. This machine has three active output
     * endpoints; whether the loopback attached to the one the meeting is
     * playing on is a question only a live meter can answer.
     *
     * The handle is deliberately NOT released by `previewsSuspended`: unlike
     * the camera and the microphone (M-007), a loopback is not an exclusive
     * device, and `start()` REUSES this stream rather than opening a second
     * one. That removes a transition rather than adding one — and it means the
     * render session is already flowing when ffmpeg opens the pipe (M-020).
     */
    async startSystemPreview() {
      if (loopback || get().session?.state === 'recording') return
      try {
        loopback = await startLoopback()
        if (levelTimer) clearInterval(levelTimer)
        levelTimer = setInterval(() => set({ systemLevel: loopback?.getLevel() ?? 0 }), 100)
        set({ systemPreviewOn: true })
      } catch (e) {
        // Not fatal: recording can still start, it just cannot be pre-checked.
        set({ devicesError: String(e), systemPreviewOn: false })
      }
    },

    stopSystemPreview() {
      // Never tear down a loopback that a recording is now using.
      if (get().session?.state === 'recording') return
      loopback?.stop()
      loopback = null
      if (levelTimer) clearInterval(levelTimer)
      levelTimer = null
      set({ systemLevel: 0, systemPreviewOn: false })
    },

    async setMuted(track, muted) {
      const r = await api.invoke('session:setMute', { track, muted })
      if (!r.ok) set({ devicesError: r.error.message })
    },

    async validate() {
      const result = await api.invoke('session:validate', buildConfig(get()))
      set({ validation: result.ok ? result.data : null })
      if (!result.ok) set({ devicesError: result.error.message })
    },

    async start() {
      const state = get()
      if (state.busy || state.session?.state === 'recording') return
      // Release the camera/mic previews FIRST — ffmpeg cannot open a camera
      // the preview still holds (cameras are exclusive; M-007).
      set({ busy: true, previewsSuspended: true })
      await new Promise((r) => setTimeout(r, 300)) // let React run effect cleanup
      try {
        // Loopback first so PCM is flowing before ffmpeg opens the pipe.
        // Reuse the preview stream when one is already running: a stream that
        // has been open and metering is known-good, and not restarting it
        // avoids a fresh endpoint race (M-019/M-020).
        if (state.selection.systemAudio && !loopback) {
          loopback = await startLoopback()
        }
        if (state.selection.systemAudio && !levelTimer) {
          levelTimer = setInterval(() => set({ systemLevel: loopback?.getLevel() ?? 0 }), 100)
        }
        const result = await api.invoke('session:start', buildConfig(state))
        if (!result.ok) {
          loopback?.stop()
          loopback = null
          if (levelTimer) clearInterval(levelTimer)
          set({ devicesError: result.error.message, previewsSuspended: false })
        }
      } catch (e) {
        loopback?.stop()
        loopback = null
        set({ devicesError: String(e), previewsSuspended: false })
      } finally {
        set({ busy: false })
      }
    },

    async pause() {
      set({ busy: true })
      try {
        await api.invoke('session:pause', {})
      } finally {
        set({ busy: false })
      }
    },

    async resume() {
      set({ busy: true })
      try {
        await api.invoke('session:resume', {})
      } finally {
        set({ busy: false })
      }
    },

    async stop() {
      set({ busy: true })
      try {
        await api.invoke('session:stop', {})
      } finally {
        loopback?.stop()
        loopback = null
        if (levelTimer) clearInterval(levelTimer)
        levelTimer = null
        set({ busy: false, systemLevel: 0, previewsSuspended: false, systemPreviewOn: false })
      }
    },
  }
})
