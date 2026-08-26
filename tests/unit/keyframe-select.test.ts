import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTION,
  FRAME_BYTES,
  hammingDistance,
  histIntersection,
  histogram,
  pHash,
  selectKeyframes,
} from '../../src/main/pipeline/stages/keyframe-select'

/** Build a synthetic 32×32 gray frame from a pattern function. */
function frame(fn: (x: number, y: number) => number): Uint8Array {
  const f = new Uint8Array(FRAME_BYTES)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) f[y * 32 + x] = fn(x, y) & 0xff
  return f
}

const gradient = frame((x, y) => x * 8 + y)
const gradientNoisy = frame((x, y) => (x * 8 + y + ((x * 31 + y * 17) % 3)) & 0xff) // tiny noise
const checker = frame((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 230 : 20))
const solid = frame(() => 128)

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.length * FRAME_BYTES)
  frames.forEach((f, i) => out.set(f, i * FRAME_BYTES))
  return out
}

describe('pHash', () => {
  it('is stable under tiny noise', () => {
    expect(hammingDistance(pHash(gradient), pHash(gradientNoisy))).toBeLessThanOrEqual(6)
  })
  it('separates genuinely different content', () => {
    expect(hammingDistance(pHash(gradient), pHash(checker))).toBeGreaterThan(16)
  })
})

describe('histogram intersection', () => {
  it('near 1 for cursor-like change, low for different content', () => {
    // Cursor-like: a 3x3 patch changed, everything else identical (<1% of pixels)
    const cursor = Uint8Array.from(gradient)
    for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) cursor[y * 32 + x] = 255
    expect(histIntersection(histogram(gradient), histogram(cursor))).toBeGreaterThan(0.98)
    // Global per-pixel dithering migrates ~8% of pixels across bin edges - still high-ish
    expect(histIntersection(histogram(gradient), histogram(gradientNoisy))).toBeGreaterThan(0.85)
    expect(histIntersection(histogram(gradient), histogram(checker))).toBeLessThan(0.5)
  })
  it('stays meaningful on FLAT histograms (the Pearson degenerate case)', () => {
    // gradient is near-uniform; intersection with itself must be ~1, not NaN/degenerate
    const h = histogram(gradient)
    expect(histIntersection(h, h)).toBeCloseTo(1, 5)
  })
})

describe('selectKeyframes — a 60 s meeting with 3 slide changes', () => {
  // seconds 0–19: gradient · 20–39: checker · 40–59: solid
  const frames = concat([
    ...Array.from({ length: 20 }, () => gradient),
    ...Array.from({ length: 20 }, () => checker),
    ...Array.from({ length: 20 }, () => solid),
  ])

  it('finds the first frame and each change, near the right times', () => {
    const r = selectKeyframes(frames)
    const times = r.keyframes.map((k) => k.timestampMs / 1000)
    expect(times).toContain(0)
    expect(times.some((t) => t >= 20 && t <= 22)).toBe(true)
    expect(times.some((t) => t >= 40 && t <= 42)).toBe(true)
    expect(r.capped).toBe(false)
  })

  it('does not fire on static content except keepalive', () => {
    const r = selectKeyframes(frames, DEFAULT_SELECTION)
    // 3 content keyframes; static runs are 20 s < 30 s keepalive
    expect(r.keyframes.length).toBe(3)
  })

  it('keepalive keeps long static runs represented', () => {
    const longStatic = concat(Array.from({ length: 70 }, () => gradient))
    const r = selectKeyframes(longStatic)
    // first frame + keepalives at ~30 s and ~60 s
    expect(r.keyframes.length).toBe(3)
  })

  it('reports when the cap binds instead of truncating silently', () => {
    // alternate content every 4 s for 60 s with an absurdly low cap
    const flicker = concat(
      Array.from({ length: 60 }, (_, i) => ((i >> 2) % 2 ? checker : gradient)),
    )
    const r = selectKeyframes(flicker, DEFAULT_SELECTION)
    // 60 s → cap = max(10, ceil(60/3600*150)) = 10; ~15 changes occur
    expect(r.capped).toBe(true)
    expect(r.keyframes.length).toBe(10)
  })
})
