import { BrowserWindow, desktopCapturer, session, shell } from 'electron'
import path from 'node:path'

/**
 * Hardened window factory. Every setting here is an invariant (CLAUDE.md,
 * SECURITY.md §5.2) — do not relax any of them without an ADR.
 */

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

// Vite dev needs its websocket + inline preamble; production stays strict.
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' ws: http://localhost:*; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

export function hardenSession(): void {
  const ses = session.defaultSession

  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DEV_SERVER_URL ? CSP_DEV : CSP_PROD],
      },
    })
  })

  // Deny everything except media capture, and log what was asked for.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = permission === 'media' || permission === 'display-capture'
    if (!allowed) console.warn(`[perm] denied: ${permission}`)
    callback(allowed)
  })

  // System audio: Chromium attaches loopback to a display capture (M-003).
  // The renderer discards the video track and keeps the audio.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const first = sources[0]
          if (!first) return callback({})
          callback({ video: first, audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false },
  )
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    title: 'MeetFroge',
    webPreferences: {
      contextIsolation: true, // invariant
      nodeIntegration: false, // invariant
      sandbox: true, // invariant
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })

  // Navigation lockdown: the window renders our app and nothing else.
  win.webContents.on('will-navigate', (event, url) => {
    const isDev = DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)
    if (!isDev && !url.startsWith('file://')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.once('ready-to-show', () => win.show())

  // E2E harness: MEETFROGE_AUTOREC=<seconds> makes the renderer record
  // unattended through the full production path (loopback → pipe → ffmpeg).
  const autorec = process.env['MEETFROGE_AUTOREC']
  const autopause = process.env['MEETFROGE_AUTOPAUSE'] === '1' ? '1' : ''
  const query: Record<string, string> = {}
  if (autorec) query['autorec'] = autorec
  if (autopause) query['autopause'] = autopause
  if (DEV_SERVER_URL) {
    const qs = new URLSearchParams(query).toString()
    void win.loadURL(qs ? `${DEV_SERVER_URL}?${qs}` : DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
  }

  return win
}
