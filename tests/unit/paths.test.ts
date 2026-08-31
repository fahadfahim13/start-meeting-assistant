import { describe, expect, it } from 'vitest'
import { isInside, resolveInside, PathEscapeError, mediaAbsolute } from '../../src/main/security/paths'

const ROOT = 'C:\\Users\\hp\\AppData\\Roaming\\meetfroge'

describe('resolveInside — the traversal battery (docs/testing.md list)', () => {
  it('accepts ordinary relative paths', () => {
    expect(resolveInside(ROOT, 'recordings\\a.mkv')).toContain('meetfroge')
    expect(resolveInside(ROOT, 'frames/abc/kf_1.jpg')).toContain('frames')
  })

  const hostile = [
    '..\\..\\Windows\\System32\\config\\sam',
    '../../../etc/passwd',
    'recordings\\..\\..\\..\\secret.txt',
    'C:\\Windows\\System32\\cmd.exe',
    'D:\\other\\drive.txt',
    '\\\\attacker\\share\\x', // UNC
    '..',
  ]
  for (const p of hostile) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(() => resolveInside(ROOT, p)).toThrow(PathEscapeError)
    })
  }

  it('does not treat a sibling directory with the root as prefix as inside', () => {
    // C:\...\meetfroge-evil must NOT count as inside C:\...\meetfroge
    expect(isInside(ROOT, ROOT + '-evil\\file.txt')).toBe(false)
    expect(isInside(ROOT, ROOT + '\\file.txt')).toBe(true)
  })
})

describe('mediaAbsolute', () => {
  const ROOTS = { userData: 'C:\\Users\\x\\AppData\\Roaming\\meetfroge' }
  const CUSTOM = 'D:\\Meetings'

  it('resolves a legacy row against userData - recordings already made must not move', () => {
    // Rows written before the column existed carry nothing; default-folder
    // recordings carry the 'userData' sentinel. Both must behave as they always did.
    const legacy = 'recordings\\a.mkv'
    expect(mediaAbsolute(ROOTS, { media_root: 'userData', media_path: legacy })).toContain('AppData')
    expect(mediaAbsolute(ROOTS, { media_path: legacy })).toContain('AppData')
    expect(mediaAbsolute(ROOTS, { media_root: null, media_path: legacy })).toContain('AppData')
  })

  it('resolves against the folder the recording was actually made in', () => {
    expect(mediaAbsolute(ROOTS, { media_root: CUSTOM, media_path: 'a.mkv' })).toBe(
      CUSTOM + '\\a.mkv',
    )
  })

  it('keeps resolving after the setting is changed or reset', () => {
    // The bug this pins: with a 'custom' MARKER, resolution depended on the
    // CURRENT setting, so reverting to the default orphaned every recording
    // made under the old folder - unplayable AND undeletable. Storing the real
    // root makes the row self-sufficient. Principle 2.
    const row = { media_root: CUSTOM, media_path: 'a.mkv' }
    const beforeReset = mediaAbsolute(ROOTS, row)
    // Nothing about the caller's state changes the answer.
    expect(mediaAbsolute(ROOTS, row)).toBe(beforeReset)
    expect(beforeReset.startsWith(CUSTOM)).toBe(true)
  })

  it('still contains traversal inside a custom root', () => {
    const evil = [
      '..\\..\\Windows\\System32\\config\\sam',
      'C:\\Windows\\cmd.exe',
      '..',
      '\\\\attacker\\share\\x',
    ]
    for (const path of evil) {
      expect(() => mediaAbsolute(ROOTS, { media_root: CUSTOM, media_path: path })).toThrow(
        PathEscapeError,
      )
    }
  })
})
