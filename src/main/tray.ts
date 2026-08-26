import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import path from 'node:path'
import type { SessionStatus } from '@shared/schemas/capture'

/**
 * Recording indicator (SECURITY.md T8). The tray icon turns red while any
 * recording is active, with the elapsed time in the tooltip. This is a safety
 * control, not a preference — there is deliberately no setting to disable it.
 */

let tray: Tray | null = null

function iconPath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons', name)
    : path.join(app.getAppPath(), 'resources', 'icons', name)
}

export function initTray(win: BrowserWindow): void {
  tray = new Tray(nativeImage.createFromPath(iconPath('tray-idle.png')))
  tray.setToolTip('MeetFroge — idle')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show MeetFroge', click: () => { win.show(); win.focus() } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => {
    win.show()
    win.focus()
  })
}

export function updateTray(status: SessionStatus): void {
  if (!tray) return
  const active = status.state === 'recording' || status.state === 'paused' || status.state === 'finalizing'
  tray.setImage(nativeImage.createFromPath(iconPath(active ? 'tray-rec.png' : 'tray-idle.png')))
  if (status.state === 'recording') {
    const s = Math.floor(status.elapsedMs / 1000)
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    tray.setToolTip(`MeetFroge — ● RECORDING ${mm}:${ss}`)
  } else if (status.state === 'paused') {
    tray.setToolTip('MeetFroge — ⏸ paused (still in a session)')
  } else if (status.state === 'finalizing') {
    tray.setToolTip('MeetFroge — finalizing recording…')
  } else {
    tray.setToolTip('MeetFroge — idle')
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
