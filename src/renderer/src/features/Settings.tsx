import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'

interface ModelRow {
  id: string
  file: string
  status: 'ok' | 'missing' | 'corrupt'
  purpose: string
  tier: 'required' | 'recommended'
  bytes: number
}

interface SettingsData {
  defaultPreset: 'efficient' | 'balanced' | 'high' | 'archival'
  language: 'en' | 'bn' | 'auto'
  autoProcess: boolean
  keyframeSensitivity: 'sensitive' | 'balanced' | 'sparse'
  modelsDir: string
  recordingsDir: string
  recordingsDirIsDefault: boolean
  recordingsDirWritable: boolean
  writeSidecarFiles: boolean
  models: ModelRow[]
  vulkan: boolean
}

interface DlProgress {
  modelId: string
  received: number
  total: number
  state: 'downloading' | 'verifying' | 'done' | 'failed'
  error?: string
}

function fmtGb(n: number): string {
  return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.round(n / 1024 ** 2) + ' MB'
}

export default function Settings(): React.JSX.Element {
  const [data, setData] = useState<SettingsData | null>(null)
  const [saved, setSaved] = useState(false)
  const [progress, setProgress] = useState<Record<string, DlProgress>>({})
  const [folderMsg, setFolderMsg] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const r = await api.invoke('settings:get', {})
    if (r.ok) setData(r.data)
  }
  useEffect(() => {
    void load()
    const off = api.onModelsProgress((raw) => {
      const p = raw as DlProgress
      setProgress((prev) => ({ ...prev, [p.modelId]: p }))
      if (p.state === 'done') void load()
    })
    return off
  }, [])

  const missingBytes = (data?.models ?? [])
    .filter((m) => m.status !== 'ok')
    .reduce((acc, m) => acc + m.bytes, 0)

  const downloadAll = (): void => {
    for (const m of data?.models ?? []) {
      if (m.status !== 'ok') void api.invoke('models:download', { modelId: m.id })
    }
  }

  const patch = async (
    p: Partial<
      Pick<
        SettingsData,
        'defaultPreset' | 'language' | 'autoProcess' | 'keyframeSensitivity' | 'writeSidecarFiles'
      >
    >,
  ): Promise<void> => {
    await api.invoke('settings:set', p)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    void load()
  }

  if (!data) return <p className="empty">{t.settings.loading}</p>

  return (
    <div className="settings">
      <section className="panel">
        <h2>{t.settings.recording}</h2>
        <label>
          {t.settings.defaultQuality}
          <select value={data.defaultPreset} onChange={(e) => void patch({ defaultPreset: e.target.value as SettingsData['defaultPreset'] })}>
            <option value="efficient">{t.setup.qualityEfficient}</option>
            <option value="balanced">{t.setup.qualityBalanced}</option>
            <option value="high">{t.setup.qualityHigh}</option>
            <option value="archival">{t.setup.qualityArchival}</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={data.autoProcess}
            onChange={(e) => void patch({ autoProcess: e.target.checked })}
          />
          {t.settings.autoProcess}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={data.writeSidecarFiles}
            onChange={(e) => void patch({ writeSidecarFiles: e.target.checked })}
          />
          {t.settings.sidecarFiles}
        </label>
        <div className="folder-row">
          <p className="hint">
            {t.settings.recordingsFolder} <code>{data.recordingsDir}</code>
          </p>
          <div className="folder-actions">
            <button
              className="ghost small"
              onClick={() => {
                // The renderer asks for a picker; main owns the dialog and the
                // path. No filesystem path is ever sent from here (ADR-016).
                void api.invoke('settings:chooseRecordingsFolder', {}).then((r) => {
                  if (!r.ok) return
                  if (r.data.ok && r.data.path) {
                    setFolderMsg(t.settings.folderChanged(r.data.path))
                    void load()
                  } else if (r.data.reason) {
                    setFolderMsg(r.data.reason)
                  }
                })
              }}
            >
              {t.settings.changeFolder}
            </button>
            {!data.recordingsDirIsDefault && (
              <button
                className="ghost small"
                onClick={() => {
                  void api.invoke('settings:resetRecordingsFolder', {}).then((r) => {
                    if (r.ok) {
                      setFolderMsg(t.settings.folderReset)
                      void load()
                    }
                  })
                }}
              >
                {t.settings.useDefaultFolder}
              </button>
            )}
          </div>
        </div>
        <p className="hint">{t.settings.folderNote}</p>
        {!data.recordingsDirWritable && (
          <p className="messages warn">{t.settings.folderUnwritable}</p>
        )}
        {folderMsg && <p className="export-msg">{folderMsg}</p>}
      </section>

      <section className="panel">
        <h2>{t.settings.transcription}</h2>
        <label>
          {t.settings.language}
          <select value={data.language} onChange={(e) => void patch({ language: e.target.value as SettingsData['language'] })}>
            <option value="en">{t.settings.langEn}</option>
            <option value="bn">{t.settings.langBn}</option>
            <option value="auto">{t.settings.langAuto}</option>
          </select>
        </label>
        <p className="hint">
          {t.settings.banglishHint}
        </p>
      </section>

      <section className="panel">
        <h2>{t.settings.visual}</h2>
        <label>
          {t.settings.keyframeSensitivity}
          <select
            value={data.keyframeSensitivity}
            onChange={(e) => void patch({ keyframeSensitivity: e.target.value as SettingsData['keyframeSensitivity'] })}
          >
            <option value="sensitive">{t.settings.kfSensitive}</option>
            <option value="balanced">{t.settings.kfBalanced}</option>
            <option value="sparse">{t.settings.kfSparse}</option>
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>{t.settings.models}</h2>
        {missingBytes > 0 && (
          <p className="messages warn">
            {data.models.filter((m) => m.status !== 'ok').length} model(s) missing ({fmtGb(missingBytes)}).
            Their pipeline stages will be skipped until downloaded.{' '}
            <button className="ghost small" onClick={downloadAll}>Download all</button>
          </p>
        )}
        <table className="model-table">
          <tbody>
            {data.models.map((m) => {
              const p = progress[m.id]
              return (
                <tr key={m.id}>
                  <td>
                    {m.purpose}
                    {m.tier === 'required' && <span className="req-tag"> required</span>}
                  </td>
                  <td className="mono">{m.file}</td>
                  <td>
                    {p && p.state === 'downloading' ? (
                      <span className="model-status">
                        {Math.round((p.received / Math.max(1, p.total)) * 100)}%{' '}
                        <button className="link" onClick={() => void api.invoke('models:cancel', { modelId: m.id })}>cancel</button>
                      </span>
                    ) : p && p.state === 'verifying' ? (
                      <span className="model-status">verifying…</span>
                    ) : p && p.state === 'failed' ? (
                      <span className="model-status corrupt" title={p.error}>failed — retry?</span>
                    ) : m.status === 'ok' ? (
                      <span className="model-status ok">{t.settings.modelReady}</span>
                    ) : (
                      <button className="ghost small" onClick={() => void api.invoke('models:download', { modelId: m.id })}>
                        get ({fmtGb(m.bytes)})
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="hint">
          {t.settings.modelsFolder} <code>{data.modelsDir}</code> {t.settings.modelsHint}
        </p>
      </section>

      {saved && <p className="export-msg">{t.settings.saved}</p>}
    </div>
  )
}
