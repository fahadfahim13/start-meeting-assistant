import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { JobUpdateSchema } from '@shared/ipc'
import { t } from '../i18n'

interface MeetingItem {
  id: string
  title: string
  startedAt: number
  durationMs: number | null
  state: string
  bytes: number | null
  sourceLabel: string | null
  tags: string[]
  jobs: {
    id: string
    stage: string
    state: string
    progress: number
    errorCode: string | null
    errorDetail: string | null
    attempts: number
    maxAttempts: number
  }[]
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

interface QaReport {
  pairs: { q: string; a: string; t: number | null }[]
  degraded: boolean
  generatedAt: number
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

/**
 * `skipped` gets its own class. It used to fall into the same bucket as
 * `pending`, so a step that had decided not to run looked identical to one
 * still waiting its turn - forever. That is what "processing may still be
 * running" meant on a pipeline that had finished ten minutes earlier.
 */
function JobBadge({ job }: { job: MeetingItem['jobs'][number] }): React.JSX.Element {
  const cls =
    job.state === 'done'
      ? 'ok'
      : job.state === 'failed'
        ? 'err'
        : job.state === 'running'
          ? 'run'
          : job.state === 'skipped'
            ? 'skip'
            : 'wait'
  const reason = job.errorCode ? ` - ${t.library.jobReason(job.errorCode)}` : ''
  return (
    <span className={`job-badge ${cls}`} title={`${job.stage}: ${job.state}${reason}`}>
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
  const [view, setView] = useState<'summary' | 'transcript' | 'qa'>('summary')
  const [qa, setQa] = useState<QaReport | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalHits, setGlobalHits] = useState<{ meetingId: string; meetingTitle: string; kind: string; text: string; startMs: number }[] | null>(null)
  const [currentMs, setCurrentMs] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingSeek = useRef<number | null>(null)

  const seekTo = (ms: number): void => {
    const v = videoRef.current
    if (v) {
      v.currentTime = ms / 1000
      void v.play().catch(() => undefined)
    } else {
      pendingSeek.current = ms
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      const v = videoRef.current
      if (!v) return
      const key = e.key.toLowerCase()
      if (key === ' ' && target.tagName !== 'VIDEO' && target.tagName !== 'BUTTON') {
        e.preventDefault()
        if (v.paused) void v.play().catch(() => undefined)
        else v.pause()
      } else if (key === 'arrowleft' || key === 'j') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - 5)
      } else if (key === 'arrowright' || key === 'l') {
        e.preventDefault()
        v.currentTime += 5
      } else if (key === 'k') {
        e.preventDefault()
        if (v.paused) void v.play().catch(() => undefined)
        else v.pause()
      } else if (key === 'arrowup') {
        e.preventDefault()
        v.playbackRate = Math.min(2, +(v.playbackRate + 0.25).toFixed(2))
      } else if (key === 'arrowdown') {
        e.preventDefault()
        v.playbackRate = Math.max(0.5, +(v.playbackRate - 0.25).toFixed(2))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runGlobalSearch = async (q: string): Promise<void> => {
    setGlobalSearch(q)
    if (!q.trim()) {
      setGlobalHits(null)
      return
    }
    const r = await api.invoke('search:all', { query: q.trim() })
    if (r.ok) setGlobalHits(r.data.hits)
  }
  const [search, setSearch] = useState('')
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const r = await api.invoke('meetings:list', { limit: 100 })
    if (r.ok) setItems(r.data.items)
  }, [])

  useEffect(() => {
    void refresh()
    // Patch the single job the event carries, and debounce the full re-query.
    // Every whisper progress tick used to trigger a complete meetings:list -
    // a tags subquery and a jobsFor query for up to 100 meetings, several times
    // a second, on a 15 W laptop that is simultaneously running inference.
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onJobsUpdate((raw) => {
      // Push events carry no gateway validation - the consumer validates.
      const parsed = JobUpdateSchema.safeParse(raw)
      if (!parsed.success) return
      const job = parsed.data
      setItems((prev) =>
        prev.map((m) =>
          m.id === job.meeting_id
            ? {
                ...m,
                jobs: m.jobs.map((j) =>
                  j.id === job.id
                    ? {
                        ...j,
                        state: job.state,
                        progress: job.progress,
                        errorCode: job.error_code,
                        attempts: job.attempts,
                      }
                    : j,
                ),
              }
            : m,
        ),
      )
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          void refresh()
        }, 1000)
      }
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      off()
    }
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
    void api.invoke('qa:get', { meetingId: selected }).then((r) => {
      if (r.ok) setQa(r.data.report)
    })
  }, [selected, items])

  const toggleAction = async (item: ActionItem): Promise<void> => {
    await api.invoke('actionitem:toggle', { actionItemId: item.id, done: !item.done })
    setActionItems((prev) => prev.map((a) => (a.id === item.id ? { ...a, done: !a.done } : a)))
  }

  const renameSpeaker = async (seg: Segment): Promise<void> => {
    if (!seg.speakerId || !selected) return
    const name = window.prompt(t.library.renamePrompt(seg.speaker ?? seg.track), seg.speaker ?? '')
    if (!name || !name.trim()) return
    await api.invoke('speakers:rename', { speakerId: seg.speakerId, displayName: name.trim().slice(0, 80) })
    const r = await api.invoke('transcript:get', { meetingId: selected })
    if (r.ok) setSegments(r.data.segments)
  }

  const doExport = async (format: 'txt' | 'srt' | 'vtt' | 'json' | 'md'): Promise<void> => {
    if (!selected) return
    const r = await api.invoke('transcript:export', { meetingId: selected, format })
    setExportMsg(r.ok && r.data.saved ? t.library.exportSaved(r.data.fileName ?? '') : r.ok ? t.library.exportCancelled : r.error.message)
    setTimeout(() => setExportMsg(null), 4000)
  }

  const filtered = search
    ? segments.filter((s) => s.text.toLowerCase().includes(search.toLowerCase()))
    : segments

  return (
    <div className="library">
      <section className="panel meeting-list" aria-label="Meetings">
        <h2 id="meetings-heading">{t.library.meetings}</h2>
        <input
          type="search"
          className="global-search"
          aria-label={t.library.searchAllAria}
          placeholder={t.library.searchAll}
          value={globalSearch}
          onChange={(e) => void runGlobalSearch(e.target.value)}
        />
        {globalHits !== null && (
          <div className="search-hits">
            {globalHits.length === 0 && <p className="empty">{t.library.noMatches}</p>}
            {globalHits.map((h, i) => (
              <button
                key={i}
                className="search-hit"
                onClick={() => {
                  setSelected(h.meetingId)
                  setGlobalHits(null)
                  setGlobalSearch('')
                  pendingSeek.current = h.startMs
                }}
              >
                <span className={'hit-kind ' + h.kind}>{h.kind === 'screen' ? t.library.screenHit : t.library.speechHit}</span>
                <span className="hit-text">{h.text}</span>
                <span className="hit-meta">{h.meetingTitle} - {fmtClock(h.startMs)}</span>
              </button>
            ))}
          </div>
        )}
        {items.length === 0 && <p className="empty">{t.library.noRecordings}</p>}
        <ul aria-labelledby="meetings-heading" style={{ display: globalHits !== null ? 'none' : undefined }}>
          {items.map((m) => (
            <li key={m.id}>
              <button
                className={`meeting-row ${selected === m.id ? 'selected' : ''}`}
                onClick={() => setSelected(m.id)}
              >
                <span className="meeting-title">{m.title}</span>
                <span className="meeting-meta">
                  {new Date(m.startedAt).toLocaleString()} · {fmtDuration(m.durationMs)} · {fmtBytes(m.bytes)}
                  {m.state === 'recovered' && <span className="recovered-tag">{t.library.recovered}</span>}
                </span>
                {m.tags.length > 0 && (
                  <span className="meeting-tags">{m.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</span>
                )}
                <span className="meeting-jobs">
                  {m.jobs.map((j) => (
                    <JobBadge key={j.stage} job={j} />
                  ))}
                  {/* Previously this button existed ONLY while a meeting had no
                      jobs at all, so after the first automatic run it never came
                      back - there was no way to re-process the meetings that
                      most needed it. */}
                  <button
                    className="link"
                    disabled={m.jobs.some((j) => j.state === 'running' || j.state === 'pending')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void api.invoke('meetings:process', { meetingId: m.id }).then(refresh)
                    }}
                  >
                    {m.jobs.some((j) => j.state === 'running' || j.state === 'pending')
                      ? t.library.processing
                      : m.jobs.length === 0
                        ? t.library.transcribe
                        : t.library.reprocess}
                  </button>
                </span>
                {/* One sentence per step that stopped for a reason. This is the
                    difference between "nothing here" and "no sound was
                    captured, so there was nothing to transcribe". */}
                {m.jobs
                  .filter((j) => j.errorCode && (j.state === 'skipped' || j.state === 'failed'))
                  .map((j) => (
                    <span key={j.id} className="job-reason">
                      {j.stage}: {t.library.jobReason(j.errorCode!)}
                      {j.state === 'failed' && (
                        <button
                          className="link"
                          onClick={(e) => {
                            e.stopPropagation()
                            void api.invoke('jobs:retry', { jobId: j.id }).then(refresh)
                          }}
                        >
                          {t.library.retryJob}
                        </button>
                      )}
                    </span>
                  ))}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel transcript" aria-label="Meeting detail">
        <div aria-live="polite" className="sr-only">
          {items.find((m) => m.id === selected)?.jobs.filter((j) => j.state === 'running').map((j) => `${j.stage} ${j.progress}%`).join(', ')}
        </div>
        <div className="transcript-toolbar">
          <input
            type="search"
            aria-label={t.library.searchTranscriptAria}
            placeholder={t.library.searchTranscript}
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
          <video
            ref={(el) => {
              videoRef.current = el
              if (el && pendingSeek.current !== null) {
                el.currentTime = pendingSeek.current / 1000
                pendingSeek.current = null
              }
            }}
            className="player"
            aria-label={t.library.playerAria}
            controls
            src={'mf-media://' + selected}
            onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
          />
        )}
        {selected && (
          <div className="view-switch">
            <button className={view === 'summary' ? 'tab active' : 'tab'} onClick={() => setView('summary')}>
              {t.library.viewSummary}
            </button>
            <button className={view === 'transcript' ? 'tab active' : 'tab'} onClick={() => setView('transcript')}>
              {t.library.viewTranscript}
            </button>
            <button className={view === 'qa' ? 'tab active' : 'tab'} onClick={() => setView('qa')}>
              {t.library.viewQa}
            </button>
            <span className="spacer" />
            <button
              className="ghost small"
              onClick={() => {
                const m = items.find((x) => x.id === selected)
                const next = window.prompt(t.library.tagsPrompt, m?.tags.join(', ') ?? '')
                if (next === null || !selected) return
                const tags = next.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12)
                void api.invoke('meetings:setTags', { meetingId: selected, tags }).then(refresh)
              }}
            >
              {t.library.tags}
            </button>
            <button
              className="ghost small danger"
              onClick={() => {
                const m = items.find((x) => x.id === selected)
                if (!selected || !m) return
                if (!window.confirm(t.library.deleteConfirm(m.title, fmtBytes(m.bytes)))) return
                void api.invoke('meetings:delete', { meetingId: selected }).then(() => {
                  setSelected(null)
                  void refresh()
                })
              }}
            >
              {t.library.delete}
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
                  onClick={() => {
                    setActiveKf(activeKf?.id === kf.id ? null : kf)
                    seekTo(kf.timestampMs)
                  }}
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
        {!selected && <p className="empty">{t.library.selectMeeting}</p>}
        {selected && view === 'summary' && (
          <div className="summary-view">
            {!summary && (
              <>
                <p className="empty">{t.library.noSummary}</p>
                {(items.find((x) => x.id === selected)?.jobs ?? [])
                  .filter((j) => j.errorCode && (j.state === 'skipped' || j.state === 'failed'))
                  .map((j) => (
                    <p key={j.id} className="messages warn">
                      {j.stage}: {t.library.jobReason(j.errorCode!)}
                    </p>
                  ))}
              </>
            )}
            {summary && (
              <>
                {(() => {
                  const m = items.find((x) => x.id === selected)
                  return m?.sourceLabel ? (
                    <p className="source-note">{t.library.sourcePrefix}{m.sourceLabel}</p>
                  ) : null
                })()}
                {summary.degraded && (
                  <p className="messages warn">{t.library.degradedSummary}</p>
                )}
                <h3 className="sum-title">{summary.title}</h3>
                <p className="sum-tldr">{summary.tldr}</p>
                <p className="sum-body">{summary.summary}</p>
                {summary.key_points.length > 0 && (
                  <>
                    <h4>{t.library.keyPoints}</h4>
                    <ul>{summary.key_points.map((k) => <li key={k}>{k}</li>)}</ul>
                  </>
                )}
                {summary.decisions.length > 0 && (
                  <>
                    <h4>{t.library.decisions}</h4>
                    <ul>{summary.decisions.map((d) => <li key={d.text}>{d.text}</li>)}</ul>
                  </>
                )}
                {actionItems.length > 0 && (
                  <>
                    <h4>{t.library.actionItems}</h4>
                    <ul className="actions">
                      {actionItems.map((a) => (
                        <li key={a.id}>
                          <label>
                            <input type="checkbox" checked={a.done} onChange={() => void toggleAction(a)} />
                            <span className={a.done ? 'done' : ''}>
                              {a.text}
                              {a.assignee ? ` — ${a.assignee}` : ''}
                            </span>
                            {a.sourceMs !== null && (
                              <button className="link" onClick={() => { setView('transcript'); seekTo(a.sourceMs!) }}>
                                {fmtClock(a.sourceMs)}
                              </button>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {summary.open_questions.length > 0 && (
                  <>
                    <h4>{t.library.openQuestions}</h4>
                    <ul>{summary.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
                  </>
                )}
              </>
            )}
            {/* Outside the `summary &&` guard on purpose: it used to render only
                when a summary already existed, so the one situation where you
                need it - there is no summary - was the one where it was
                missing. */}
            <button
              className="ghost small"
              onClick={() => selected && void api.invoke('summary:regenerate', { meetingId: selected })}
            >
              {t.library.regenerate}
            </button>
          </div>
        )}
        {selected && view === 'qa' && (
          <div className="summary-view qa-view">
            {(() => {
              const meeting = items.find((x) => x.id === selected)
              const running = meeting?.jobs.some((j) => j.stage === 'qa' && (j.state === 'running' || j.state === 'pending'))
              const hasTranscript = segments.length > 0
              return (
                <>
                  {qa?.degraded && <p className="messages warn">{t.library.qaDegraded}</p>}
                  {!qa && (
                    <>
                      <p className="empty">{t.library.qaEmpty}</p>
                      <p className="preview-note">{t.library.qaExplain}</p>
                    </>
                  )}
                  {qa?.pairs.map((pair, i) => (
                    <div key={`${i}-${pair.q}`} className="qa-pair">
                      <h4 className="qa-q">{pair.q}</h4>
                      <p className="qa-a">
                        {pair.a}
                        {/* Only when the timestamp survived snapping to a real
                            segment - a seek that lands nowhere is worse than
                            no seek at all. */}
                        {pair.t !== null && (
                          <button
                            className="link"
                            onClick={() => {
                              setView('transcript')
                              seekTo(pair.t!)
                            }}
                          >
                            {fmtClock(pair.t)}
                          </button>
                        )}
                      </p>
                    </div>
                  ))}
                  {!hasTranscript && <p className="preview-note warn-note">{t.library.qaNeedsTranscript}</p>}
                  <div className="export-group">
                    <button
                      className="ghost small"
                      disabled={!hasTranscript || running}
                      onClick={() => {
                        if (!selected) return
                        void api.invoke('qa:regenerate', { meetingId: selected }).then(refresh)
                      }}
                    >
                      {running ? t.library.qaRunning : qa ? t.library.qaRegenerate : t.library.qaGenerate}
                    </button>
                    {qa &&
                      (['md', 'txt', 'json'] as const).map((f) => (
                        <button
                          key={f}
                          className="ghost small"
                          onClick={() => {
                            if (!selected) return
                            void api.invoke('qa:export', { meetingId: selected, format: f }).then((r) => {
                              if (r.ok) setExportMsg(r.data.saved ? t.library.exportSaved(r.data.fileName ?? '') : t.library.exportCancelled)
                            })
                          }}
                        >
                          {f}
                        </button>
                      ))}
                  </div>
                  {qa && (
                    <p className="preview-note">
                      {t.library.qaGeneratedAt(new Date(qa.generatedAt).toLocaleString())}
                    </p>
                  )}
                </>
              )
            })()}
          </div>
        )}
        {selected && view === 'transcript' && segments.length === 0 && (
          <>
            <p className="empty">{t.library.noTranscript}</p>
            {(items.find((x) => x.id === selected)?.jobs ?? [])
              .filter((j) => j.errorCode && (j.state === 'skipped' || j.state === 'failed'))
              .map((j) => (
                <p key={j.id} className="messages warn">
                  {j.stage}: {t.library.jobReason(j.errorCode!)}
                </p>
              ))}
          </>
        )}
        {view !== 'transcript' && !selected && null}
        <div className="segments" role="list" style={{ display: view === 'transcript' ? undefined : 'none' }}>
          {filtered.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={`segment track-${s.track} ${currentMs >= s.startMs && currentMs < s.endMs ? 'current' : ''}`}
            >
              <button className="seg-time" onClick={() => seekTo(s.startMs)} title={t.library.jumpTo}>
                {fmtClock(s.startMs)}
              </button>
              <button
                className={`seg-speaker ${s.certain ? 'certain' : ''}`}
                title={s.certain ? t.library.speakerCertain : t.library.speakerDiarized}
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
