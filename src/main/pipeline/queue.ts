import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { getDb } from '@main/db'
import { log } from '@main/log'
import type { ErrorCode } from '@shared/errors'

/**
 * Resumable job queue (plan §8.3, ADR-006). SQLite-backed, ONE worker —
 * parallel inference on a 15 W chip thrashes memory bandwidth (B-009/B-010).
 *
 * Contract with stages: a stage's checkpoint is written AFTER its results are
 * durably persisted, never before — a crash between the two re-does work
 * instead of losing it (plan §10.3). Jobs left 'running' by a crash are reset
 * to 'pending' at startup.
 */

export interface JobRow {
  id: string
  meeting_id: string
  stage: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
  progress: number
  attempts: number
  max_attempts: number
  checkpoint: string | null
  error_code: string | null
  error_detail: string | null
}

export interface StageContext {
  job: JobRow
  setProgress(pct: number): void
  setCheckpoint(data: object): void
}

/**
 * A stage may return a bare state, or a state WITH a reason.
 *
 * The bare form keeps every existing stage body compiling; the object form is
 * how a stage explains itself. `skipped` carrying a code is the important case:
 * a skip with no reason renders identically to "still queued" and leaves the
 * user staring at "No summary yet" on a pipeline that finished ten minutes ago.
 */
export type StageOutcome =
  | 'done'
  | 'skipped'
  | { state: 'done' | 'skipped'; code?: ErrorCode; detail?: string }

export type StageRunner = (ctx: StageContext) => Promise<StageOutcome>

export interface QueueEvents {
  onJobUpdate(job: JobRow): void
}

export class JobQueue {
  private stages = new Map<string, StageRunner>()
  private working = false
  readonly threads = Math.max(1, os.cpus().length - 2)

  constructor(private events: QueueEvents) {}

  registerStage(name: string, runner: StageRunner): void {
    this.stages.set(name, runner)
  }

  /**
   * Crash cleanup: anything 'running' at boot was interrupted.
   *
   * This path deliberately PRESERVES checkpoints — it is resume, and a stage
   * that persisted half its work should not redo it. `enqueue` and `retry`
   * deliberately DISCARD them, because those mean "the result was wrong, start
   * over". Three paths, three different intents; do not unify them.
   */
  resetInterrupted(): void {
    getDb().prepare(`UPDATE jobs SET state = 'pending' WHERE state = 'running'`).run()
  }

  enqueue(meetingId: string, stages: string[]): void {
    const db = getDb()
    const insert = db.prepare(
      // checkpoint = NULL is not optional: transcribe's checkpoint records which
      // tracks it already handled, so re-processing a meeting whose transcribe
      // "succeeded" with zero segments short-circuited straight back to done and
      // did nothing at all. Re-running was a no-op precisely for broken meetings.
      `INSERT INTO jobs (id, meeting_id, stage, state) VALUES (?, ?, ?, 'pending')
       ON CONFLICT(meeting_id, stage) DO UPDATE SET state = 'pending', attempts = 0,
         error_code = NULL, error_detail = NULL, progress = 0, checkpoint = NULL`,
    )
    for (const stage of stages) insert.run(randomUUID(), meetingId, stage)
    void this.pump()
  }

  retry(jobId: string): void {
    getDb()
      .prepare(
        `UPDATE jobs SET state = 'pending', attempts = 0, error_code = NULL,
           error_detail = NULL, checkpoint = NULL WHERE id = ?`,
      )
      .run(jobId)
    void this.pump()
  }

  jobsFor(meetingId: string): JobRow[] {
    return getDb().prepare('SELECT * FROM jobs WHERE meeting_id = ?').all(meetingId) as unknown as JobRow[]
  }

  /** Single worker: picks pending jobs in insertion order, one at a time. */
  async pump(): Promise<void> {
    if (this.working) return
    this.working = true
    try {
      for (;;) {
        const job = getDb()
          .prepare(`SELECT * FROM jobs WHERE state = 'pending' ORDER BY rowid LIMIT 1`)
          .get() as unknown as JobRow | undefined
        if (!job) break
        await this.runJob(job)
      }
    } finally {
      this.working = false
    }
  }

  private update(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields)
    const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    getDb().prepare(sql).run(...keys.map((k) => fields[k]!), id)
    const job = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow
    this.events.onJobUpdate(job)
  }

  private async runJob(job: JobRow): Promise<void> {
    const runner = this.stages.get(job.stage)
    if (!runner) {
      this.update(job.id, { state: 'failed', error_code: 'PIPELINE_STAGE_FAILED', error_detail: `unknown stage ${job.stage}` })
      return
    }

    this.update(job.id, { state: 'running', started_at: Date.now(), attempts: job.attempts + 1 })

    const ctx: StageContext = {
      job,
      setProgress: (pct) => this.update(job.id, { progress: Math.max(0, Math.min(100, pct)) }),
      setCheckpoint: (data) => this.update(job.id, { checkpoint: JSON.stringify(data) }),
    }

    try {
      const outcome = await runner(ctx)
      const normalised = typeof outcome === 'string' ? { state: outcome } : outcome
      // error_code/error_detail are reused for skip reasons rather than adding
      // columns: enqueue() and retry() already null them, which is exactly the
      // lifecycle an outcome reason wants. See DECISIONS.md.
      this.update(job.id, {
        state: normalised.state,
        progress: 100,
        finished_at: Date.now(),
        error_code: normalised.code ?? null,
        error_detail: normalised.detail ? normalised.detail.slice(0, 1000) : null,
      })
      if (normalised.code) {
        log.info('pipeline', 'stage finished with a reason', {
          stage: job.stage,
          meetingId: job.meeting_id,
          state: normalised.state,
          reason: normalised.code,
        })
      }
    } catch (e) {
      const attempts = job.attempts + 1
      const max = job.max_attempts
      log.error('pipeline', 'stage attempt failed', {
        stage: job.stage,
        meetingId: job.meeting_id,
        attempt: attempts,
        maxAttempts: max,
        error: String(e).slice(0, 800),
      })
      if (attempts < max) {
        this.update(job.id, { state: 'pending', error_detail: String(e).slice(0, 1000) })
        // Exponential backoff before the next pump pass picks it up again.
        await new Promise((r) => setTimeout(r, Math.min(60_000, 2 ** attempts * 1000)))
      } else {
        this.update(job.id, {
          state: 'failed',
          error_code: 'PIPELINE_STAGE_FAILED',
          error_detail: String(e).slice(0, 1000),
          finished_at: Date.now(),
        })
      }
    }
  }
}
