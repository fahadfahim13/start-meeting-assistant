import { describe, expect, it } from 'vitest'
import { isInside, resolveInside, PathEscapeError } from '../../src/main/security/paths'

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
