import { describe, expect, it } from 'vitest'
import {
  ASSUMED_SCREEN_HEIGHT,
  parsePipGeometry,
  pipBlankFilter,
  pipCameraFilters,
  pipGeometry,
  pipInnerSize,
  pipOverlayFilter,
  pipOverlayXY,
} from '../../src/main/capture/pip'

const geom = (over: Partial<Parameters<typeof pipGeometry>[0]> = {}) =>
  pipGeometry({ position: 'bottom-right', sizePct: 22, screenHeightPx: 1080, ...over })

describe('pipGeometry', () => {
  it('is null when the overlay is off — the whole off switch', () => {
    expect(geom({ position: 'off' })).toBeNull()
  })

  it('sizes the box from the real screen height', () => {
    const g = geom()!
    expect(g.boxH).toBe(238) // 1080 * 0.22, rounded to even
    expect(g.screenHeightSource).toBe('display')
  })

  it('produces even dimensions at every size — h264 has no odd dimensions', () => {
    for (let pct = 10; pct <= 40; pct++) {
      for (const h of [720, 1080, 1440, 2160]) {
        const g = pipGeometry({ position: 'top-left', sizePct: pct, screenHeightPx: h })!
        expect(g.boxW % 2, `w at ${pct}% of ${h}`).toBe(0)
        expect(g.boxH % 2, `h at ${pct}% of ${h}`).toBe(0)
        expect(g.borderPx % 2).toBe(0)
        // The inner picture must stay even too, or scale/crop lands off-grid.
        const inner = pipInnerSize(g)
        expect(inner.w % 2).toBe(0)
        expect(inner.h % 2).toBe(0)
        expect(inner.w).toBeGreaterThan(0)
        expect(inner.h).toBeGreaterThan(0)
      }
    }
  })

  it('clamps the percentage into range instead of trusting it', () => {
    expect(geom({ sizePct: 400 })!.sizePct).toBe(40)
    expect(geom({ sizePct: 0 })!.sizePct).toBe(10)
    expect(geom({ sizePct: Number.NaN })!.sizePct).toBe(22)
  })

  it('falls back to a stated assumption when the screen height is unknown', () => {
    const g = geom({ screenHeightPx: null })!
    expect(g.screenHeightPx).toBe(ASSUMED_SCREEN_HEIGHT)
    // Principle 5: the row says which of the two it was, so nothing downstream
    // has to guess whether the number was measured.
    expect(g.screenHeightSource).toBe('assumed')
  })

  it('never lets the overlay take more than half the screen', () => {
    const g = pipGeometry({ position: 'top-left', sizePct: 40, screenHeightPx: 300 })!
    expect(g.boxH).toBeLessThanOrEqual(150)
  })
})

describe('filter strings', () => {
  it('contains no unescaped comma — a bare comma is a filter separator', () => {
    const g = geom()!
    const chunks = [
      ...pipCameraFilters({ cameraLabel: 'campip', maskInputIndex: 3, geom: g, outLabel: 'pip' }),
      pipOverlayFilter({ screenLabel: 'vscr', pipLabel: 'pip', geom: g, outLabel: 'vmix' }),
      pipBlankFilter(g),
    ]
    for (const chunk of chunks) {
      // Commas may only separate whole filters within one chain, never appear
      // inside an option VALUE. None of these expressions needs one at all.
      for (const filter of chunk.split(',')) {
        expect(filter).not.toMatch(/=[^:[\]]*\\$/)
      }
    }
  })

  it('anchors each corner to the right two edges', () => {
    expect(pipOverlayXY('top-left')).toEqual({ x: 'main_w*0.02', y: 'main_w*0.02' })
    expect(pipOverlayXY('bottom-right').x).toContain('main_w-overlay_w-')
    expect(pipOverlayXY('bottom-right').y).toContain('main_h-overlay_h-')
    expect(pipOverlayXY('top-right').y).toBe('main_w*0.02')
    expect(pipOverlayXY('bottom-left').x).toBe('main_w*0.02')
  })

  it('fills the box, borders it, then punches the corners out with the mask', () => {
    const g = geom()!
    const chunks = pipCameraFilters({ cameraLabel: 'campip', maskInputIndex: 3, geom: g, outLabel: 'pip' })
    const joined = chunks.join(';')
    // Fill-and-crop, not letterbox: black bars inside the card read as a
    // broken camera.
    expect(joined).toContain('force_original_aspect_ratio=increase')
    expect(joined).toContain(`crop=${g.boxW - 2 * g.borderPx}:${g.boxH - 2 * g.borderPx}`)
    expect(joined).toContain(`pad=${g.boxW}:${g.boxH}:${g.borderPx}:${g.borderPx}:color=white`)
    // Alpha is required for the rounded corners to be transparent at all.
    expect(joined).toContain('format=yuva420p')
    expect(joined).toContain('[3:v]scale=424:238,format=gray[pipmask]')
    expect(joined).toContain('alphamerge[pip]')
  })

  it('blanks the same rectangle it drew, for the analysis pass', () => {
    const g = geom()!
    const blank = pipBlankFilter(g)
    expect(blank).toContain(`w=${g.boxW}:h=${g.boxH}`)
    expect(blank).toContain('t=fill')
    // iw/ih, because the analysed frame is the composited one — the same
    // dimensions overlay called main_w/main_h.
    expect(blank).toContain('iw-424-iw*0.02')
    expect(blank).toContain('ih-238-iw*0.02')
  })
})

describe('parsePipGeometry', () => {
  it('round-trips a snapshot out of capture_profile', () => {
    const g = geom()!
    expect(parsePipGeometry(JSON.parse(JSON.stringify(g)))).toEqual(g)
  })

  it('treats anything unreadable as no overlay, never as a throw', () => {
    // A recording made before the feature existed has no such key at all.
    expect(parsePipGeometry(undefined)).toBeNull()
    expect(parsePipGeometry(null)).toBeNull()
    expect(parsePipGeometry({ position: 'middle', boxW: 1 })).toBeNull()
    expect(parsePipGeometry('bottom-right')).toBeNull()
  })
})
