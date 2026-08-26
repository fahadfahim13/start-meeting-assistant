import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './migrations'

/**
 * Database bootstrap. node:sqlite (ADR-011) — synchronous, built into the
 * Electron 44 runtime, FTS5 verified present. All access goes through the
 * repositories; nothing else touches SQL.
 */

let db: DatabaseSync | null = null

export function dbPath(): string {
  return path.join(app.getPath('userData'), 'meetfroge.db')
}

export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(app.getPath('userData'), { recursive: true })
  db = new DatabaseSync(dbPath())
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  return db
}

function migrate(d: DatabaseSync): void {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
  )`)
  const appliedRows = d.prepare('SELECT version FROM schema_migrations').all() as unknown as { version: number }[]
  const applied = new Set(appliedRows.map((r) => r.version))

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    // Forward-only, numbered, with an automatic backup before each new migration
    // on an existing database (plan §10.4).
    if (m.version > 1 && existsSync(dbPath())) {
      try {
        copyFileSync(dbPath(), `${dbPath()}.pre-v${m.version}.bak`)
      } catch (e) {
        console.warn('[db] pre-migration backup failed:', e)
      }
    }
    d.exec('BEGIN')
    try {
      d.exec(m.sql)
      d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now())
      d.exec('COMMIT')
      console.log(`[db] migrated to v${m.version}`)
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
