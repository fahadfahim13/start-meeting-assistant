import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

interface MeetingItem {
  id: string
  title: string
  startedAt: number
  durationMs: number | null
  state: string
  bytes: number | null
  jobs: { stage: string; state: string; progress: number }[]
}

interface Segment {
  id: string
  startMs: number
  endMs: number
  speaker: string | null
  track: string
  text: string
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s % 60}s`
}

function fmtClock(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  return n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`
}

function JobBadge({ job }: { job: MeetingItem['jobs'][number] }): React.JSX.Element {
  const cls =
    job.state === 'done' ? 'ok' : job.state === 'failed' ? 'err' : job.state === 'running' ? 'run' : 'wait'
  return (
    <span className={`job-badge ${cls}`} title={`${job.stage}: ${job.state}`}>
      {job.stage}
      {job.state === 'running' ? ` ${job.progress}%` : ''}
    </span>
  )
}

export default function Library(): React.JSX.Element {
  const [items, setItems] = useState<MeetingItem[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [search, setSearch] = useState('')
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const r = await api.invoke('meetings:list', { limit: 100 })
    if (r.ok) setItems(r.data.items)
  }, [])

  useEffect(() => {
    void refresh()
    // Job updates re-render the list live (progress %, state changes).
    const off = api.onJobsUpdate(() => void refresh())
    return off
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setSegments([])
      return
    }
    void api.invoke('transcript:get', { meetingId: selected }).then((r) => {
      if (r.ok) setSegments(r.data.segments)
    })
  }, [selected, items])

  const doExport = async (format: 'txt' | 'srt' | 'vtt' | 'json' | 'md'): Promise<void> => {
    if (!selected) return
    const r = await api.invoke('transcript:export', { meetingId: selected, format })
    setExportMsg(r.ok && r.data.saved ? `Saved ${r.data.fileName}` : r.ok ? 'Export cancelled' : r.error.message)
    setTimeout(() => setExportMsg(null), 4000)
  }

  const filtered = search
    ? segments.filter((s) => s.text.toLowerCase().includes(search.toLowerCase()))
    : segments

  return (
    <div className="library">
      <section className="panel meeting-list" aria-label="Meetings">
        <h2>Meetings</h2>
        {items.length === 0 && <p className="empty">No recordings yet. Record one from the Record tab.</p>}
        <ul>
          {items.map((m) => (
            <li key={m.id}>
              <button
                className={`meeting-row ${selected === m.id ? 'selected' : ''}`}
                onClick={() => setSelected(m.id)}
              >
                <span className="meeting-title">{m.title}</span>
                <span className="meeting-meta">
                  {new Date(m.startedAt).toLocaleString()} · {fmtDuration(m.durationMs)} · {fmtBytes(m.bytes)}
                  {m.state === 'recovered' && <span className="recovered-tag"> recovered</span>}
                </span>
                <span className="meeting-jobs">
                  {m.jobs.map((j) => (
                    <JobBadge key={j.stage} job={j} />
                  ))}
                  {m.jobs.length === 0 && (
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.invoke('meetings:process', { meetingId: m.id }).then(refresh)
                      }}
                    >
                      transcribe
                    </button>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel transcript" aria-label="Transcript">
        <div className="transcript-toolbar">
          <input
            type="search"
            placeholder="Search this transcript…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={!selected}
          />
          <div className="export-group">
            {(['txt', 'srt', 'vtt', 'json', 'md'] as const).map((f) => (
              <button key={f} className="ghost small" disabled={!selected || segments.length === 0} onClick={() => void doExport(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {exportMsg && <p className="export-msg">{exportMsg}</p>}
        {!selected && <p className="empty">Select a meeting to view its transcript.</p>}
        {selected && segments.length === 0 && (
          <p className="empty">No transcript yet — processing may still be running, or press “transcribe”.</p>
        )}
        <div className="segments" role="list">
          {filtered.map((s) => (
            <div key={s.id} role="listitem" className={`segment track-${s.track}`}>
              <span className="seg-time">{fmtClock(s.startMs)}</span>
              <span className={`seg-speaker ${s.track === 'mic' ? 'certain' : ''}`}>{s.speaker ?? s.track}</span>
              <span className="seg-text">{s.text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
