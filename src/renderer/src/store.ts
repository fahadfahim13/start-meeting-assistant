import { create } from 'zustand'
import type { DeviceInventory } from '@shared/schemas/devices'
import type { CaptureConfig, QualityPreset, SessionStatus, ValidationResult } from '@shared/schemas/capture'
import { api } from './api'
import { startLoopback, type LoopbackHandle } from './audio/loopback'

interface Selection {
  screenId: string | null
  cameraDeviceId: string | null
  microphoneDeviceId: string | null
  systemAudio: boolean
  preset: QualityPreset
  title: string
}

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

function buildConfig(state: AppState): CaptureConfig {
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
        }
      : null,
    camera: camera?.dshowName ? { dshowName: camera.dshowName } : null,
    microphone: mic?.dshowName ? { dshowName: mic.dshowName } : null,
    systemAudio: sel.systemAudio,
  }
}

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
      microphoneDeviceId: null,
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
        set({
          inventory: inv,
          selection: {
            ...sel,
            screenId: sel.screenId ?? inv.screens.find((s) => s.kind === 'screen')?.id ?? null,
            cameraDeviceId: sel.cameraDeviceId ?? inv.cameras.find((c) => !c.isVirtual)?.deviceId ?? null,
            microphoneDeviceId: sel.microphoneDeviceId ?? inv.microphones[0]?.deviceId ?? null,
          },
        })
      } catch (e) {
        set({ devicesError: String(e) })
      }
    },

    select(patch) {
      set({ selection: { ...get().selection, ...patch }, validation: null })
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
