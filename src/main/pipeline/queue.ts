import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { getDb } from '@main/db'

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

export type StageRunner = (ctx: StageContext) => Promise<'done' | 'skipped'>

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

  /** Crash cleanup: anything 'running' at boot was interrupted. */
  resetInterrupted(): void {
    getDb().prepare(`UPDATE jobs SET state = 'pending' WHERE state = 'running'`).run()
  }

  enqueue(meetingId: string, stages: string[]): void {
    const db = getDb()
    const insert = db.prepare(
      `INSERT INTO jobs (id, meeting_id, stage, state) VALUES (?, ?, ?, 'pending')
       ON CONFLICT(meeting_id, stage) DO UPDATE SET state = 'pending', attempts = 0,
         error_code = NULL, error_detail = NULL, progress = 0`,
    )
    for (const stage of stages) insert.run(randomUUID(), meetingId, stage)
    void this.pump()
  }

  retry(jobId: string): void {
    getDb()
      .prepare(`UPDATE jobs SET state = 'pending', attempts = 0, error_code = NULL, error_detail = NULL WHERE id = ?`)
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
      this.update(job.id, { state: outcome, progress: 100, finished_at: Date.now() })
    } catch (e) {
      const attempts = job.attempts + 1
      const max = job.max_attempts
      console.error(`[queue] ${job.stage}/${job.meeting_id} attempt ${attempts}:`, e)
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
