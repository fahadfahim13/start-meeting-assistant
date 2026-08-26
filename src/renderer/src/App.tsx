import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { startMeter, type MeterHandle } from './audio/meter'
import Library from './features/Library'
import Settings from './features/Settings'
import { t } from './i18n'

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
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
    timers.push(setTimeout(() => void useStore.getState().stop(), 1500 + seconds * 1000))
    return () => timers.forEach(clearTimeout)
  }, [s.inventory === null])

  const recording = s.session?.state === 'recording'
  const paused = s.session?.state === 'paused'
  const inSession = recording || paused || s.session?.state === 'finalizing'

  // Camera preview — WebRTC, entirely separate from the ffmpeg path, and torn
  // down the moment recording starts: cameras are EXCLUSIVE devices, and a
  // preview that keeps holding one starves ffmpeg's dshow input of frames,
  // killing the whole recording (MISTAKES.md M-007).
  useEffect(() => {
    let stream: MediaStream | null = null
    const el = videoRef.current
    if (!s.selection.cameraDeviceId || !el || recording || s.previewsSuspended) return
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
  }, [s.selection.cameraDeviceId, recording, s.previewsSuspended])

  // Mic level meter — released during recording for the same reason. WASAPI
  // shared mode often tolerates two mic readers, but "often" is not a design.
  useEffect(() => {
    let meter: MeterHandle | null = null
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    if (!s.selection.microphoneDeviceId || recording || s.previewsSuspended) {
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
  }, [s.selection.microphoneDeviceId, recording, s.previewsSuspended])
  const inv = s.inventory

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
          </label>

          <label>
            {t.setup.camera}
            <select
              value={s.selection.cameraDeviceId ?? ''}
              disabled={inSession}
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

          <label>
            {t.setup.microphone}
            <select
              value={s.selection.microphoneDeviceId ?? ''}
              disabled={inSession}
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
          <video ref={videoRef} autoPlay muted playsInline className="camera-preview" />
          <Meter level={micLevel} label={t.preview.mic} />
          <Meter level={s.systemLevel} label={t.preview.system} />

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
              {s.session.error && <span className="drop-warning">{s.session.error.slice(0, 120)}</span>}
            </>
          )}
        </div>
        <div className="buttons">
          <button className="ghost" disabled={recording || s.busy} onClick={() => void s.validate()}>
            {t.controls.checkSetup}
          </button>
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
