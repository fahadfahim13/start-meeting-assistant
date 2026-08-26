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
