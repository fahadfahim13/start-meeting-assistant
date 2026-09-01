import { z } from 'zod'
import { getDb } from '../index'

/**
 * Typed app settings over the key/value table. One zod schema is the source
 * of truth; unknown keys never enter the table, bad values fall back to
 * defaults rather than crashing consumers.
 */

export const SettingsSchema = z.object({
  defaultPreset: z.enum(['efficient', 'balanced', 'high', 'archival']).default('balanced'),
  /** ADR-004: transcription language — the per-meeting override lives here for now. */
  language: z.enum(['en', 'bn', 'auto']).default('en'),
  autoProcess: z.boolean().default(true),
  keyframeSensitivity: z.enum(['sensitive', 'balanced', 'sparse']).default('balanced'),
  /**
   * Absolute folder for NEW recordings; null means userData/recordings.
   *
   * Deliberately NOT settable through `settings:set` — a filesystem path must
   * never cross IPC in a REQUEST (CLAUDE.md). It is written only by the
   * main-process folder-picker handler, which owns the dialog and validates the
   * result. See ADR-016.
   */
  recordingsDir: z.string().max(500).nullable().default(null),
  /**
   * Write the transcript, summary and Q&A next to the .mkv, so the recording
   * folder is readable without opening the app at all (Principle 6: open by
   * default, no lock-in).
   */
  writeSidecarFiles: z.boolean().default(true),
  /**
   * Container for the finished recording.
   *
   * Segments are ALWAYS Matroska while recording, whatever this says: MKV
   * tolerates a truncated file, so a crash costs one segment rather than the
   * whole meeting (Principle 2). Only the final concatenated file follows this
   * setting.
   */
  outputFormat: z.enum(['mkv', 'mp4']).default('mkv'),
})
export type AppSettings = z.infer<typeof SettingsSchema>

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as unknown as {
    key: string
    value: string
  }[]
  const raw: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value)
    } catch {
      /* ignore bad rows */
    }
  }
  const parsed = SettingsSchema.safeParse(raw)
  return parsed.success ? parsed.data : SettingsSchema.parse({})
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = SettingsSchema.parse({ ...getSettings(), ...patch })
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  for (const [key, value] of Object.entries(merged)) {
    stmt.run(key, JSON.stringify(value))
  }
  return merged
}
