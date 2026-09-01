import { useEffect, useRef, useState } from 'react'
import { enabledButUnavailable, useStore } from './store'
import { api } from './api'
import { startMeter, type MeterHandle } from './audio/meter'
import Library from './features/Library'
import Settings from './features/Settings'
import { t } from './i18n'

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/**
 * Why there is no preview image, not just that there isn't one.
 * `idle` = nothing selected / previews suspended, `empty` = the source exists
 * but is minimised, `not-found` = it was closed, `error` = the IPC call failed.
 */
type PreviewState = {
  kind: 'idle' | 'ok' | 'empty' | 'not-found' | 'error'
  url: string | null
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

function Meter({ level, label }: { level: number; label: string }): React.JSX.Element {
  const pct = Math.min(100, level * 300)
  return (
    <div className="meter-row" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(pct)}>
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%`, background: level > 0.003 ? '#3fb950' : '#484f58' }} />
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const s = useStore()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [tab, setTab] = useState<'record' | 'library' | 'settings'>('record')

  useEffect(() => {
    void s.refreshDevices()
  }, [])

  // E2E harness (?autorec=N): record unattended through the full production
  // path for N seconds, then stop. Main writes out/e2e.json on stop.
  useEffect(() => {
    const autorec = new URLSearchParams(window.location.search).get('autorec')
    if (!autorec || !s.inventory) return
    const seconds = Math.min(600, Math.max(3, parseInt(autorec, 10) || 10))
    const autopause = new URLSearchParams(window.location.search).get('autopause') === '1'
    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(setTimeout(() => void useStore.getState().start(), 1500))
    if (autopause) {
      // pause at 40%, resume at 60% — exercises the segment-based pause path
      timers.push(setTimeout(() => void useStore.getState().pause(), 1500 + seconds * 400))
      timers.push(setTimeout(() => void useStore.getState().resume(), 1500 + seconds * 600))
    }
    // ?automute=system  — mute that track halfway through, so a harness can
    // measure the track's first half against its second and prove the runtime
    // mute actually reached ffmpeg.
    const automute = new URLSearchParams(window.location.search).get('automute')
    if (automute === 'system' || automute === 'mic') {
      timers.push(
        setTimeout(() => void useStore.getState().setMuted(automute, true), 1500 + seconds * 500),
      )
    }
    timers.push(setTimeout(() => void useStore.getState().stop(), 1500 + seconds * 1000))
    return () => timers.forEach(clearTimeout)
  }, [s.inventory === null])

  const recording = s.session?.state === 'recording'
  const paused = s.session?.state === 'paused'
  const inSession = recording || paused || s.session?.state === 'finalizing'
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle', url: null })
  // Keyed by content so a NEW set of warnings reappears after being dismissed.
  const [dismissedWarnings, setDismissedWarnings] = useState('')
  const [markerMsg, setMarkerMsg] = useState<string | null>(null)

  // Live preview of the SELECTED screen/window — so what gets recorded (and
  // therefore what the summary is built from) is visible before pressing
  // Record, not discovered afterwards.
  useEffect(() => {
    const id = s.selection.screenId
    // previewsSuspended matters here exactly like the camera preview (M-007):
    // a getSources thumbnail capture racing getDisplayMedia's loopback start
    // can leave the system-audio stream silent (M-020).
    if (!id || inSession || s.previewsSuspended || tab !== 'record') {
      setPreview({ kind: 'idle', url: null })
      return
    }
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const grab = async (): Promise<void> => {
      const r = await api.invoke('devices:screenPreview', { sourceId: id })
      if (!alive) return
      if (!r.ok) {
        // Never keep the last good image on failure. A stale thumbnail is worse
        // than none: it shows a window that may already be closed and quietly
        // contradicts what is about to be recorded.
        setPreview({ kind: 'error', url: null })
        return
      }
      if (r.data.status === 'ok') setPreview({ kind: 'ok', url: r.data.thumbnailDataUrl })
      else setPreview({ kind: r.data.status, url: null })
    }

    // Poll only while this window is actually on screen. Previously it polled
    // every 2 s even while minimised, which is how an idle app generated a
    // continuous stream of desktop captures on a 15 W laptop.
    const sync = (): void => {
      const shouldPoll = document.visibilityState === 'visible'
      if (shouldPoll && timer === null) {
        void grab()
        timer = setInterval(() => void grab(), 5000)
      } else if (!shouldPoll && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)

    return () => {
      alive = false
      if (timer !== null) clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [s.selection.screenId, inSession, s.previewsSuspended, tab])

  // Camera preview — WebRTC, entirely separate from the ffmpeg path, and torn
  // down the moment recording starts: cameras are EXCLUSIVE devices, and a
  // preview that keeps holding one starves ffmpeg's dshow input of frames,
  // killing the whole recording (MISTAKES.md M-007).
  useEffect(() => {
    let stream: MediaStream | null = null
    const el = videoRef.current
    if (!s.selection.cameraEnabled || !s.selection.cameraDeviceId || !el || recording || s.previewsSuspended) return
    void navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: s.selection.cameraDeviceId } } })
      .then((st) => {
        stream = st
        el.srcObject = st
      })
      .catch(() => {
        /* preview failure is non-fatal */
      })
    return () => {
      if (el) el.srcObject = null
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [s.selection.cameraDeviceId, s.selection.cameraEnabled, recording, s.previewsSuspended])

  // System-audio meter BEFORE recording. Without it the System bar reads zero
  // until Record is pressed, so a loopback attached to the wrong output device
  // was invisible until the meeting was already over.
  useEffect(() => {
    const want = tab === 'record' && s.selection.systemAudio && !inSession
    if (want) void s.startSystemPreview()
    else s.stopSystemPreview()
  }, [tab, s.selection.systemAudio, inSession])

  // Mic level meter — released during recording for the same reason. WASAPI
  // shared mode often tolerates two mic readers, but "often" is not a design.
  useEffect(() => {
    let meter: MeterHandle | null = null
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    if (!s.selection.microphoneEnabled || !s.selection.microphoneDeviceId || recording || s.previewsSuspended) {
      setMicLevel(0)
      return
    }
    void navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: s.selection.microphoneDeviceId } } })
      .then(async (st) => {
        stream = st
        meter = await startMeter(st)
        timer = setInterval(() => setMicLevel(meter?.getLevel() ?? 0), 100)
      })
      .catch(() => setMicLevel(0))
    return () => {
      if (timer) clearInterval(timer)
      meter?.stop()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [s.selection.microphoneDeviceId, s.selection.microphoneEnabled, recording, s.previewsSuspended])
  const inv = s.inventory
  // Sources switched ON that the recorder cannot actually address.
  const unavailable = enabledButUnavailable(s)

  return (
    <div className="app">
      <header className="titlebar">
        <h1>{t.app.title}</h1>
        <nav className="tabs" aria-label="Views">
          <button className={tab === 'record' ? 'tab active' : 'tab'} onClick={() => setTab('record')}>
            {t.app.tabRecord}
          </button>
          <button className={tab === 'library' ? 'tab active' : 'tab'} onClick={() => setTab('library')}>
            {t.app.tabLibrary}
          </button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
            {t.app.tabSettings}
          </button>
        </nav>
        {inSession && (
          <span className={paused ? 'rec-indicator paused' : 'rec-indicator'} aria-live="assertive">
            {paused ? t.app.paused : t.app.rec} {fmtElapsed(s.session?.elapsedMs ?? 0)}
          </span>
        )}
      </header>

      {tab === 'settings' ? (
        <main className="layout-single settings-scroll">
          <Settings />
        </main>
      ) : tab === 'library' ? (
        <main className="layout-single">
          <Library />
        </main>
      ) : (
      <main className="layout">
        <section className="panel setup" aria-label="Recording setup">
          <h2>{t.setup.heading}</h2>

          <label>
            {t.setup.meetingTitle}
            <input
              type="text"
              value={s.selection.title}
              placeholder={t.setup.meetingTitlePlaceholder}
              maxLength={200}
              disabled={inSession}
              onChange={(e) => s.select({ title: e.target.value })}
            />
          </label>

          <label>
            {t.setup.screen}
            <select
              value={s.selection.screenId ?? ''}
              disabled={inSession}
              onChange={(e) => s.select({ screenId: e.target.value || null })}
            >
              <option value="">{t.setup.none}</option>
              {inv?.screens.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.kind === 'screen' ? t.setup.screenOption((sc.displayIndex ?? 0) + 1) : sc.name.slice(0, 60)}
                </option>
              ))}
            </select>
            <div className="screen-strip" role="listbox" aria-label="Pick a screen or window">
              {inv?.screens.filter((sc) => sc.thumbnailDataUrl).slice(0, 12).map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  role="option"
                  aria-selected={s.selection.screenId === sc.id}
                  className={`screen-thumb ${s.selection.screenId === sc.id ? 'selected' : ''}`}
                  title={sc.kind === 'screen' ? t.setup.screenOption((sc.displayIndex ?? 0) + 1) : sc.name}
                  disabled={inSession}
                  onClick={() => s.select({ screenId: sc.id })}
                >
                  <img src={sc.thumbnailDataUrl ?? undefined} alt="" />
                  <span>{sc.kind === 'screen' ? t.setup.screenOption((sc.displayIndex ?? 0) + 1) : sc.name.slice(0, 22)}</span>
                </button>
              ))}
            </div>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={s.selection.cameraEnabled}
              disabled={inSession}
              onChange={(e) => s.select({ cameraEnabled: e.target.checked })}
            />
            {t.setup.cameraEnabled}
          </label>

          <label>
            {t.setup.camera}
            <select
              value={s.selection.cameraDeviceId ?? ''}
              disabled={inSession || !s.selection.cameraEnabled}
              onChange={(e) => s.select({ cameraDeviceId: e.target.value || null })}
            >
              <option value="">{t.setup.none}</option>
              {inv?.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                  {c.isVirtual ? t.setup.virtualSuffix : ''}
                  {c.dshowName ? '' : t.setup.unavailableSuffix}
                </option>
              ))}
            </select>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={s.selection.microphoneEnabled}
              disabled={inSession}
              onChange={(e) => s.select({ microphoneEnabled: e.target.checked })}
            />
            {t.setup.microphoneEnabled}
          </label>

          <label>
            {t.setup.microphone}
            <select
              value={s.selection.microphoneDeviceId ?? ''}
              disabled={inSession || !s.selection.microphoneEnabled}
              onChange={(e) => s.select({ microphoneDeviceId: e.target.value || null })}
            >
              <option value="">{t.setup.none}</option>
              {inv?.microphones.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                  {m.dshowName ? '' : t.setup.unavailableSuffix}
                </option>
              ))}
            </select>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={s.selection.systemAudio}
              disabled={inSession}
              onChange={(e) => s.select({ systemAudio: e.target.checked })}
            />
            {t.setup.systemAudio}
          </label>

          <label>
            {t.setup.quality}
            <select
              value={s.selection.preset}
              disabled={inSession}
              onChange={(e) => s.select({ preset: e.target.value as typeof s.selection.preset })}
            >
              <option value="efficient">{t.setup.qualityEfficient}</option>
              <option value="balanced">{t.setup.qualityBalanced}</option>
              <option value="high">{t.setup.qualityHigh}</option>
              <option value="archival">{t.setup.qualityArchival}</option>
            </select>
          </label>

          <button className="ghost" disabled={inSession} onClick={() => void s.refreshDevices()}>
            {t.setup.refreshDevices}
          </button>
        </section>

        <section className="panel preview" aria-label="Preview">
          <h2>{t.preview.heading}</h2>
          {preview.kind === 'ok' && preview.url ? (
            <>
              <img src={preview.url} alt="Selected screen preview" className="screen-preview" />
              <p className="preview-note">{t.preview.screenLabel}</p>
            </>
          ) : preview.kind === 'not-found' ? (
            <p className="preview-note warn-note">{t.preview.sourceGone}</p>
          ) : preview.kind === 'empty' ? (
            <p className="preview-note warn-note">{t.preview.sourceMinimized}</p>
          ) : preview.kind === 'error' ? (
            <p className="preview-note warn-note">{t.preview.previewFailed}</p>
          ) : (
            !inSession && s.selection.screenId === null && <p className="preview-note warn-note">{t.preview.noScreen}</p>
          )}
          {/* A black rectangle and a dead grey meter are indistinguishable from
              a broken camera and a silent microphone. An OFF source says so. */}
          {s.selection.cameraEnabled && s.selection.cameraDeviceId ? (
            <video ref={videoRef} autoPlay muted playsInline className="camera-preview" />
          ) : (
            <p className="preview-note source-off">{t.preview.cameraOff}</p>
          )}
          {s.selection.microphoneEnabled && s.selection.microphoneDeviceId ? (
            <Meter level={micLevel} label={t.preview.mic} />
          ) : (
            <p className="preview-note source-off" aria-label={t.preview.micOff}>
              {t.preview.micOff}
            </p>
          )}
          {s.selection.systemAudio ? (
            <>
              <Meter level={s.systemLevel} label={t.preview.system} />
              {!inSession && (
                <p className={s.systemPreviewOn && s.systemLevel < 0.001 ? 'preview-note warn-note' : 'preview-note'}>
                  {s.systemPreviewOn && s.systemLevel < 0.001
                    ? t.preview.systemSilent
                    : t.preview.systemCheckHint}
                </p>
              )}
            </>
          ) : (
            <p className="preview-note source-off" aria-label={t.preview.systemOff}>
              {t.preview.systemOff}
            </p>
          )}
          {unavailable.map((label) => (
            <div key={label} className="messages error" role="alert">
              <p>✕ {t.preview.deviceUnavailable(label)}</p>
            </div>
          ))}

          {s.validation && !s.validation.ok && (
            <div className="messages error" role="alert">
              {s.validation.errors.map((e) => (
                <p key={e}>✕ {e}</p>
              ))}
            </div>
          )}
          {s.validation?.warnings.length ? (
            <div className="messages warn">
              {s.validation.warnings.map((w) => (
                <p key={w}>⚠ {w}</p>
              ))}
            </div>
          ) : null}
          {s.validation?.ok && (
            <p className="estimate">
              {t.preview.estimate(fmtBytes(s.validation.estimatedBytesPerHour), fmtBytes(s.validation.diskFreeBytes))}
            </p>
          )}
          {s.devicesError && (
            <div className="messages error" role="alert">
              <p>✕ {s.devicesError}</p>
            </div>
          )}
        </section>
      </main>
      )}

      {(() => {
        // Post-recording findings (M-023). Shown here rather than in the footer
        // because these are full sentences the user has to act on — a silent
        // system-audio track means the transcript will be empty, and that is
        // worth interrupting for while they still remember the setup.
        const warnings = s.session?.warnings ?? []
        const key = warnings.join('|')
        if (warnings.length === 0 || key === dismissedWarnings) return null
        return (
          <div className="messages warn recording-warnings" role="status">
            <strong>{t.controls.recordingIssues}</strong>
            {warnings.map((w) => (
              <p key={w}>⚠ {w}</p>
            ))}
            <button className="ghost small" onClick={() => setDismissedWarnings(key)}>
              {t.controls.dismiss}
            </button>
          </div>
        )
      })()}

      <footer className="controls">
        <div className="status" aria-live="polite">
          {s.session && (
            <>
              <span className={`state state-${s.session.state}`}>{s.session.state}</span>
              {recording && (
                <>
                  <span>{fmtBytes(s.session.bytesWritten)}</span>
                  <span>{s.session.encoderInUse}</span>
                  {s.session.pcmDrops > 0 && (
                    <span className="drop-warning">{t.controls.dropWarning(s.session.pcmDrops)}</span>
                  )}
                </>
              )}
              {markerMsg && <span className="marker-msg">{markerMsg}</span>}
              {s.session.error && <span className="drop-warning">{s.session.error.slice(0, 120)}</span>}
            </>
          )}
        </div>
        <div className="buttons">
          <button className="ghost" disabled={recording || s.busy} onClick={() => void s.validate()}>
            {t.controls.checkSetup}
          </button>
          {inSession && s.session && (
            <>
              {/* Flagging the moment while it happens beats hunting for it in
                  an hour of transcript afterwards. */}
              <button
                className="ghost"
                onClick={() => {
                  void api.invoke('session:marker', { label: null }).then((r) => {
                    if (r.ok) setMarkerMsg(t.controls.markerAdded(r.data.total))
                  })
                }}
              >
                {t.controls.marker}
              </button>
              {s.session.mutedMic !== undefined && s.selection.microphoneEnabled && (
                <button
                  className="ghost"
                  onClick={() => void s.setMuted('mic', !s.session!.mutedMic)}
                  aria-pressed={s.session.mutedMic}
                >
                  {s.session.mutedMic ? t.controls.unmuteMic : t.controls.muteMic}
                </button>
              )}
              {s.selection.systemAudio && (
                <button
                  className="ghost"
                  onClick={() => void s.setMuted('system', !s.session!.mutedSystem)}
                  aria-pressed={s.session.mutedSystem}
                >
                  {s.session.mutedSystem ? t.controls.unmuteSystem : t.controls.muteSystem}
                </button>
              )}
            </>
          )}
          {!inSession ? (
            <button className="record" disabled={s.busy || !inv} onClick={() => void s.start()}>
              {t.controls.record}
            </button>
          ) : (
            <>
              {recording && (
                <button className="ghost" disabled={s.busy} onClick={() => void s.pause()}>
                  {t.controls.pause}
                </button>
              )}
              {paused && (
                <button className="record" disabled={s.busy} onClick={() => void s.resume()}>
                  {t.controls.resume}
                </button>
              )}
              <button className="stop" disabled={s.busy} onClick={() => void s.stop()}>
                {t.controls.stop}
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}
