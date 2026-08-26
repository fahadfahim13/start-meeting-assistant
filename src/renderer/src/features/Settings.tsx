import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'

interface SettingsData {
  defaultPreset: 'efficient' | 'balanced' | 'high' | 'archival'
  language: 'en' | 'bn' | 'auto'
  autoProcess: boolean
  keyframeSensitivity: 'sensitive' | 'balanced' | 'sparse'
  modelsDir: string
  recordingsDir: string
  models: { id: string; file: string; status: 'ok' | 'missing' | 'corrupt' }[]
}

export default function Settings(): React.JSX.Element {
  const [data, setData] = useState<SettingsData | null>(null)
  const [saved, setSaved] = useState(false)

  const load = async (): Promise<void> => {
    const r = await api.invoke('settings:get', {})
    if (r.ok) setData(r.data)
  }
  useEffect(() => {
    void load()
  }, [])

  const patch = async (p: Partial<Pick<SettingsData, 'defaultPreset' | 'language' | 'autoProcess' | 'keyframeSensitivity'>>): Promise<void> => {
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
        <p className="hint">{t.settings.recordingsFolder} <code>{data.recordingsDir}</code></p>
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
        <table className="model-table">
          <tbody>
            {data.models.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td className="mono">{m.file}</td>
                <td>
                  <span className={`model-status ${m.status}`}>
                    {m.status === 'ok' ? t.settings.modelReady : m.status === 'missing' ? t.settings.modelMissing : t.settings.modelCorrupt}
                  </span>
                </td>
              </tr>
            ))}
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
