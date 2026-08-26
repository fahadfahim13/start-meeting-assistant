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

interface Keyframe {
  id: string
  timestampMs: number
  url: string
  ocrText: string | null
  caption: string | null
  sceneType: string | null
}

interface SummaryData {
  title: string
  tldr: string
  summary: string
  key_points: string[]
  decisions: { text: string; t?: number }[]
  topics: string[]
  open_questions: string[]
  degraded: boolean
}

interface ActionItem {
  id: string
  text: string
  assignee: string | null
  sourceMs: number | null
  done: boolean
}

interface Segment {
  id: string
  startMs: number
  endMs: number
  speaker: string | null
  speakerId: string | null
  certain: boolean
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
  const [keyframes, setKeyframes] = useState<Keyframe[]>([])
  const [activeKf, setActiveKf] = useState<Keyframe | null>(null)
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [actionItems, setActionItems] = useState<ActionItem[]>([])
  const [view, setView] = useState<'summary' | 'transcript'>('summary')
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
      setKeyframes([])
      setActiveKf(null)
      return
    }
    void api.invoke('transcript:get', { meetingId: selected }).then((r) => {
      if (r.ok) setSegments(r.data.segments)
    })
    void api.invoke('keyframes:get', { meetingId: selected }).then((r) => {
      if (r.ok) {
        setKeyframes(r.data.keyframes)
        setActiveKf(null)
      }
    })
    void api.invoke('summary:get', { meetingId: selected }).then((r) => {
      if (r.ok) {
        setSummary(r.data.summary)
        setActionItems(r.data.actionItems)
      }
    })
  }, [selected, items])

  const toggleAction = async (item: ActionItem): Promise<void> => {
    await api.invoke('actionitem:toggle', { actionItemId: item.id, done: !item.done })
    setActionItems((prev) => prev.map((a) => (a.id === item.id ? { ...a, done: !a.done } : a)))
  }

  const renameSpeaker = async (seg: Segment): Promise<void> => {
    if (!seg.speakerId || !selected) return
    const name = window.prompt(`Rename "${seg.speaker ?? seg.track}" to:`, seg.speaker ?? '')
    if (!name || !name.trim()) return
    await api.invoke('speakers:rename', { speakerId: seg.speakerId, displayName: name.trim().slice(0, 80) })
    const r = await api.invoke('transcript:get', { meetingId: selected })
    if (r.ok) setSegments(r.data.segments)
  }

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
        {selected && (
          <div className="view-switch">
            <button className={view === 'summary' ? 'tab active' : 'tab'} onClick={() => setView('summary')}>
              Summary
            </button>
            <button className={view === 'transcript' ? 'tab active' : 'tab'} onClick={() => setView('transcript')}>
              Transcript
            </button>
          </div>
        )}
        {keyframes.length > 0 && (
          <div className="visual-timeline" aria-label="Screen timeline">
            <div className="kf-strip">
              {keyframes.map((kf) => (
                <button
                  key={kf.id}
                  className={`kf-thumb ${activeKf?.id === kf.id ? 'active' : ''}`}
                  title={`${fmtClock(kf.timestampMs)}${kf.sceneType ? ` · ${kf.sceneType}` : ''}`}
                  onClick={() => setActiveKf(activeKf?.id === kf.id ? null : kf)}
                >
                  <img src={kf.url} alt={kf.caption ?? `Screen at ${fmtClock(kf.timestampMs)}`} loading="lazy" />
                  <span className="kf-time">{fmtClock(kf.timestampMs)}</span>
                </button>
              ))}
            </div>
            {activeKf && (
              <div className="kf-detail">
                <img src={activeKf.url} alt="" />
                <div className="kf-info">
                  {activeKf.sceneType && <span className="kf-tag">{activeKf.sceneType}</span>}
                  {activeKf.caption && <p className="kf-caption">{activeKf.caption}</p>}
                  {activeKf.ocrText && <p className="kf-ocr">{activeKf.ocrText.slice(0, 400)}</p>}
                </div>
              </div>
            )}
          </div>
        )}
        {!selected && <p className="empty">Select a meeting to view its transcript.</p>}
        {selected && view === 'summary' && (
          <div className="summary-view">
            {!summary && <p className="empty">No summary yet — it appears after processing finishes.</p>}
            {summary && (
              <>
                {summary.degraded && (
                  <p className="messages warn">⚠ Structured summarization failed — showing merged raw notes.</p>
                )}
                <h3 className="sum-title">{summary.title}</h3>
                <p className="sum-tldr">{summary.tldr}</p>
                <p className="sum-body">{summary.summary}</p>
                {summary.key_points.length > 0 && (
                  <>
                    <h4>Key points</h4>
                    <ul>{summary.key_points.map((k) => <li key={k}>{k}</li>)}</ul>
                  </>
                )}
                {summary.decisions.length > 0 && (
                  <>
                    <h4>Decisions</h4>
                    <ul>{summary.decisions.map((d) => <li key={d.text}>{d.text}</li>)}</ul>
                  </>
                )}
                {actionItems.length > 0 && (
                  <>
                    <h4>Action items</h4>
                    <ul className="actions">
                      {actionItems.map((a) => (
                        <li key={a.id}>
                          <label>
                            <input type="checkbox" checked={a.done} onChange={() => void toggleAction(a)} />
                            <span className={a.done ? 'done' : ''}>
                              {a.text}
                              {a.assignee ? ` — ${a.assignee}` : ''}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {summary.open_questions.length > 0 && (
                  <>
                    <h4>Open questions</h4>
                    <ul>{summary.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
                  </>
                )}
                <button
                  className="ghost small"
                  onClick={() => selected && void api.invoke('summary:regenerate', { meetingId: selected })}
                >
                  Regenerate
                </button>
              </>
            )}
          </div>
        )}
        {selected && view === 'transcript' && segments.length === 0 && (
          <p className="empty">No transcript yet — processing may still be running, or press “transcribe”.</p>
        )}
        {view !== 'transcript' && !selected && null}
        <div className="segments" role="list" style={{ display: view === 'transcript' ? undefined : 'none' }}>
          {filtered.map((s) => (
            <div key={s.id} role="listitem" className={`segment track-${s.track}`}>
              <span className="seg-time">{fmtClock(s.startMs)}</span>
              <button
                className={`seg-speaker ${s.certain ? 'certain' : ''}`}
                title={s.certain ? 'Identified from your microphone track (exact)' : 'Diarized (probabilistic) — click to rename'}
                onClick={() => void renameSpeaker(s)}
              >
                {s.speaker ?? s.track}
              </button>
              <span className="seg-text">{s.text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
