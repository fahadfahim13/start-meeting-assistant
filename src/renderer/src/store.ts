import { create } from 'zustand'
import type { DeviceInventory } from '@shared/schemas/devices'
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


interface AppState {
  inventory: DeviceInventory | null
  devicesError: string | null
  selection: Selection
  validation: ValidationResult | null
  session: SessionStatus | null
  systemLevel: number
  busy: boolean
  /** True from just BEFORE session:start until stop/failure — previews must
   *  release their devices before ffmpeg tries to open them (M-007). */
  previewsSuspended: boolean

  refreshDevices(): Promise<void>
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
    validation: null,
    session: null,
    systemLevel: 0,
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
        if (state.selection.systemAudio) {
          loopback = await startLoopback()
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
        set({ busy: false, systemLevel: 0, previewsSuspended: false })
      }
    },
  }
})
