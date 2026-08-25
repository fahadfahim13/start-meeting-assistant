import { desktopCapturer } from 'electron'
import { execFile } from 'node:child_process'
import type { DeviceInventory } from '@shared/schemas/devices'
import { resolveBinary } from '@main/platform/binaries'
import { reconcile } from './reconcile'

/** Device enumeration; name reconciliation itself lives in ./reconcile (pure). */

interface DshowDevices {
  video: string[]
  audio: string[]
}

export async function listDshowDevices(): Promise<DshowDevices> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffmpeg'),
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { timeout: 10_000, windowsHide: true },
      (_error, _stdout, stderr) => {
        // Always "fails" (dummy input) — the listing is on stderr.
        const video: string[] = []
        const audio: string[] = []
        for (const line of String(stderr).split(/\r?\n/)) {
          const m = /"([^"]+)"\s+\((video|audio|none)\)/.exec(line)
          if (!m) continue
          const name = m[1]!
          if (m[2] === 'video') video.push(name)
          else if (m[2] === 'audio') audio.push(name)
        }
        resolve({ video, audio })
      },
    )
  })
}

const VIRTUAL_MARKERS = ['obs virtual', 'virtual camera', 'droidcam', 'snap camera', 'manycam']

export async function enumerateDevices(webrtc: {
  webrtcCameras: { deviceId: string; label: string }[]
  webrtcMicrophones: { deviceId: string; label: string }[]
}): Promise<DeviceInventory> {
  const [dshow, sources] = await Promise.all([
    listDshowDevices(),
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    }),
  ])

  const cameras = webrtc.webrtcCameras.map((c) => ({
    deviceId: c.deviceId,
    label: c.label,
    dshowName: reconcile(c.label, dshow.video),
    isVirtual: VIRTUAL_MARKERS.some((m) => c.label.toLowerCase().includes(m)),
  }))

  const microphones = webrtc.webrtcMicrophones.map((m) => ({
    deviceId: m.deviceId,
    label: m.label,
    dshowName: reconcile(m.label, dshow.audio),
  }))

  let screenIndex = 0
  const screens = sources.map((s) => {
    const kind: 'screen' | 'window' = s.id.startsWith('screen:') ? 'screen' : 'window'
    const size = s.thumbnail?.getSize()
    return {
      id: s.id,
      name: s.name.slice(0, 256),
      kind,
      // ddagrab output index follows DXGI enumeration order, which matches the
      // order desktopCapturer returns screens in. Known sharp edge (R-06):
      // verify on multi-monitor before trusting it there.
      displayIndex: kind === 'screen' ? screenIndex++ : null,
      // Minimized windows report 0×0 thumbnails — normalize to null rather
      // than shipping a value the schema (rightly) rejects.
      width: size?.width ? size.width : null,
      height: size?.height ? size.height : null,
      thumbnailDataUrl: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    }
  })

  return { cameras, microphones, screens }
}
