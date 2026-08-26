import { useEffect, useState } from 'react'
import { api } from '../api'

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

  if (!data) return <p className="empty">Loading…</p>

  return (
    <div className="settings">
      <section className="panel">
        <h2>Recording</h2>
        <label>
          Default quality
          <select value={data.defaultPreset} onChange={(e) => void patch({ defaultPreset: e.target.value as SettingsData['defaultPreset'] })}>
            <option value="efficient">Efficient — 720p10</option>
            <option value="balanced">Balanced — 1080p15 (recommended)</option>
            <option value="high">High — 1080p30</option>
            <option value="archival">Archival — native</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={data.autoProcess}
            onChange={(e) => void patch({ autoProcess: e.target.checked })}
          />
          Process automatically when a recording stops
        </label>
        <p className="hint">Recordings folder: <code>{data.recordingsDir}</code></p>
      </section>

      <section className="panel">
        <h2>Transcription</h2>
        <label>
          Language
          <select value={data.language} onChange={(e) => void patch({ language: e.target.value as SettingsData['language'] })}>
            <option value="en">English (Bangla words transliterated — recommended for mixed speech)</option>
            <option value="bn">Bangla</option>
            <option value="auto">Auto-detect (can flip mid-sentence on mixed speech)</option>
          </select>
        </label>
        <p className="hint">
          Mixed Bangla-English speech is the hardest case for every open model — accuracy is lower
          at language switch points. Transcripts are editable.
        </p>
      </section>

      <section className="panel">
        <h2>Visual analysis</h2>
        <label>
          Keyframe sensitivity
          <select
            value={data.keyframeSensitivity}
            onChange={(e) => void patch({ keyframeSensitivity: e.target.value as SettingsData['keyframeSensitivity'] })}
          >
            <option value="sensitive">Sensitive — more keyframes, catches subtle changes</option>
            <option value="balanced">Balanced (recommended)</option>
            <option value="sparse">Sparse — fewer keyframes, faster processing</option>
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>Models</h2>
        <table className="model-table">
          <tbody>
            {data.models.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td className="mono">{m.file}</td>
                <td>
                  <span className={`model-status ${m.status}`}>
                    {m.status === 'ok' ? '✓ ready' : m.status === 'missing' ? 'missing' : '⚠ corrupt/partial'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Models folder: <code>{data.modelsDir}</code>. Missing models make their pipeline stage
          skip (the rest still runs). The guided download flow arrives with the installer.
        </p>
      </section>

      {saved && <p className="export-msg">Saved</p>}
    </div>
  )
}
