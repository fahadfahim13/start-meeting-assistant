import { describe, expect, it } from 'vitest'
import { SettingsSchema } from '../../src/main/db/repositories/settings'
import { INVOKE_CHANNELS } from '../../src/shared/ipc'

/**
 * The settings schema and the two IPC schemas that carry it are three
 * hand-maintained copies of the same shape, and nothing made them agree.
 * `outputFormat` shipped in the DB schema and in the capture engine while being
 * invisible to `settings:get` — a setting that exists, is read, and cannot be
 * seen or changed. These tests are the missing seam.
 */

/** Written only by main's own folder picker; never in a request (ADR-016). */
const MAIN_ONLY_KEYS = new Set(['recordingsDir'])

const keysOf = (schema: unknown): string[] =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape)

describe('SettingsSchema', () => {
  it('fills every key from a completely empty table', () => {
    // getSettings() falls back to SettingsSchema.parse({}) when ANY field fails
    // to parse, so a field without a .default() would make that path throw.
    const defaults = SettingsSchema.parse({})
    for (const key of keysOf(SettingsSchema)) {
      expect(defaults[key as keyof typeof defaults], key).toBeDefined()
    }
  })

  it('defaults the camera overlay to on, bottom-right, 22%', () => {
    const d = SettingsSchema.parse({})
    expect(d.cameraOverlay).toBe('bottom-right')
    expect(d.cameraOverlaySizePct).toBe(22)
  })

  it('refuses an overlay size outside the range the slider offers', () => {
    expect(SettingsSchema.safeParse({ cameraOverlaySizePct: 41 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ cameraOverlaySizePct: 9 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ cameraOverlaySizePct: 22.5 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ cameraOverlay: 'middle' }).success).toBe(false)
  })
})

describe('settings IPC contract matches the stored schema', () => {
  it('exposes every stored setting in settings:get', () => {
    const exposed = new Set(keysOf(INVOKE_CHANNELS['settings:get'].response))
    for (const key of keysOf(SettingsSchema)) {
      // A stored setting missing here is silently stripped by the gateway, so
      // the UI can never show it — which is exactly how outputFormat shipped
      // half-wired.
      expect(exposed.has(key), `settings:get is missing ${key}`).toBe(true)
    }
  })

  it('accepts every renderer-writable setting in settings:set', () => {
    const settable = new Set(keysOf(INVOKE_CHANNELS['settings:set'].request))
    for (const key of keysOf(SettingsSchema)) {
      if (MAIN_ONLY_KEYS.has(key)) {
        expect(settable.has(key), `${key} must NOT be settable from the renderer`).toBe(false)
        continue
      }
      expect(settable.has(key), `settings:set cannot write ${key}`).toBe(true)
    }
  })
})
