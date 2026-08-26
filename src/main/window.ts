import { BrowserWindow, app, desktopCapturer, net, protocol, session, shell } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { getDb } from './db'
import { isInside } from './security/paths'

/**
 * Hardened window factory. Every setting here is an invariant (CLAUDE.md,
 * SECURITY.md §5.2) — do not relax any of them without an ADR.
 */

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: mf-frame:; media-src 'self' blob: mediastream: mf-media:; connect-src 'self'; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

// Vite dev needs its websocket + inline preamble; production stays strict.
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: mf-frame:; media-src 'self' blob: mediastream: mf-media:; connect-src 'self' ws: http://localhost:*; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

/** Must run BEFORE app ready. */
export function registerFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'mf-frame', privileges: { standard: false, secure: true, supportFetchAPI: true } },
    // stream:true is what lets <video> seek — the handler answers Range
    // requests with 206 slices.
    { scheme: 'mf-media', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

export function hardenSession(): void {
  const ses = session.defaultSession

  // mf-frame://<meetingId>/<fileName> serves keyframe JPEGs — the only way
  // images reach the sandboxed renderer under the strict CSP. Containment:
  // both path parts are validated, and the resolved path must stay inside
  // the frames root (SECURITY.md T4).
  protocol.handle('mf-frame', (request) => {
    try {
      const url = new URL(request.url)
      const meetingId = decodeURIComponent(url.hostname || url.pathname.split('/')[1] || '')
      const file = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/').pop() || '')
      if (!/^[0-9a-f-]{36}$/i.test(meetingId) || !/^kf_\d+\.jpg$/.test(file)) {
        return new Response('bad request', { status: 400 })
      }
      const framesRoot = path.join(app.getPath('userData'), 'frames')
      const resolved = path.resolve(framesRoot, meetingId, file)
      if (!isInside(framesRoot, resolved)) {
        return new Response('forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(resolved).toString())
    } catch {
      return new Response('error', { status: 500 })
    }
  })

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

  // mf-media://<meetingId> streams the finalized recording to <video> with
  // full Range support (seeking needs 206 slices). The path comes from the
  // DB, never the URL — the id is just a lookup key (SECURITY.md T4).
  protocol.handle('mf-media', (request) => {
    try {
      const url = new URL(request.url)
      const meetingId = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''))
      if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return new Response('bad request', { status: 400 })
      const row = getDb()
        .prepare(`SELECT media_path FROM meetings WHERE id = ? AND state IN ('ready','recovered')`)
        .get(meetingId) as unknown as { media_path: string } | undefined
      if (!row) return new Response('not found', { status: 404 })
      const dataRoot = app.getPath('userData')
      const resolved = path.resolve(dataRoot, row.media_path)
      if (!isInside(dataRoot, resolved)) return new Response('forbidden', { status: 403 })

      const size = statSync(resolved).size
      const rangeHeader = request.headers.get('Range')
      const common = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska' }
      if (rangeHeader) {
        const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
        if (m) {
          const start = parseInt(m[1]!, 10)
          const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
          if (start >= size || start > end) return new Response(null, { status: 416 })
          const stream = Readable.toWeb(createReadStream(resolved, { start, end })) as ReadableStream
          return new Response(stream, {
            status: 206,
            headers: {
              ...common,
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': String(end - start + 1),
            },
          })
        }
      }
      const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream
      return new Response(stream, { headers: { ...common, 'Content-Length': String(size) } })
    } catch {
      return new Response('error', { status: 500 })
    }
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
