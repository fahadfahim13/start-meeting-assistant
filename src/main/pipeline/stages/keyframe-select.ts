/**
 * Keyframe selection (ADR-003): collapse 1 fps samples to the frames where the
 * screen actually changed. Pure functions over raw 32×32 grayscale frames —
 * ffmpeg emits them directly (`-vf fps=1,scale=32:32,format=gray -f rawvideo`),
 * so no image decoding happens in Node at all.
 *
 * Selection: 64-bit DCT pHash distance vs the LAST KEYFRAME, confirmed by a
 * histogram-correlation check (suppresses cursor/video noise), minimum gap,
 * periodic keepalive through long static runs, and a hard cap that is
 * REPORTED when it binds (Principle 5 — silent truncation is a bug).
 */

export const GRAY_SIZE = 32
export const FRAME_BYTES = GRAY_SIZE * GRAY_SIZE

// ---- pHash ----------------------------------------------------------------

/** Precomputed DCT-II basis for a 32-point transform. */
const DCT_BASIS: number[][] = (() => {
  const N = GRAY_SIZE
  const basis: number[][] = []
  for (let k = 0; k < N; k++) {
    const row: number[] = []
    for (let n = 0; n < N; n++) {
      row.push(Math.cos((Math.PI / N) * (n + 0.5) * k))
    }
    basis.push(row)
  }
  return basis
})()

/** 64-bit perceptual hash: 2D DCT → top-left 8×8 (minus DC) vs median. */
export function pHash(gray: Uint8Array): bigint {
  const N = GRAY_SIZE
  // rows then columns
  const tmp = new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let k = 0; k < N; k++) {
      let acc = 0
      const basis = DCT_BASIS[k]!
      for (let x = 0; x < N; x++) acc += gray[y * N + x]! * basis[x]!
      tmp[y * N + k] = acc
    }
  }
  const dct = new Float64Array(64)
  for (let k = 0; k < 8; k++) {
    for (let j = 0; j < 8; j++) {
      let acc = 0
      const basis = DCT_BASIS[j]!
      for (let y = 0; y < N; y++) acc += tmp[y * N + k]! * basis[y]!
      dct[j * 8 + k] = acc
    }
  }
  // median of AC coefficients (skip DC at [0])
  const ac = Array.from(dct.slice(1)).sort((a, b) => a - b)
  const median = ac[Math.floor(ac.length / 2)]!
  let hash = 0n
  for (let i = 1; i < 64; i++) {
    if (dct[i]! > median) hash |= 1n << BigInt(i - 1)
  }
  return hash
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x) {
    x &= x - 1n
    count++
  }
  return count
}

// ---- histogram ------------------------------------------------------------

/** 32-bin luminance histogram, normalized. */
export function histogram(gray: Uint8Array): Float64Array {
  const bins = new Float64Array(32)
  for (let i = 0; i < gray.length; i++) bins[gray[i]! >> 3] = (bins[gray[i]! >> 3] ?? 0) + 1
  for (let i = 0; i < 32; i++) bins[i]! /= gray.length
  return bins
}

/**
 * Histogram intersection: sum of per-bin minima (1 = identical, 0 = disjoint).
 * Chosen over Pearson correlation, which degenerates on FLAT histograms
 * (uniform content -> zero variance -> meaningless) — caught by unit test.
 */
export function histIntersection(a: Float64Array, b: Float64Array): number {
  let acc = 0
  for (let i = 0; i < a.length; i++) acc += Math.min(a[i]!, b[i]!)
  return acc
}

// ---- selection walk -------------------------------------------------------

export interface SelectionOptions {
  /** pHash hamming distance above which a frame is a change candidate. */
  hashThreshold: number
  /**
   * Margin above hashThreshold at which pHash alone decides. Below it (the
   * marginal band) the histogram may VETO near-identical color stats — this
   * suppresses cursor/video noise WITHOUT letting two same-palette text
   * slides (hist intersection ~1) mask a real change.
   */
  strongMargin: number
  /** In the marginal band, intersection ABOVE this vetoes the change. */
  histVeto: number
  minGapS: number
  /** Keep a frame after this long with no keyframe (long static runs). */
  keepaliveS: number
  maxPerHour: number
}

export const DEFAULT_SELECTION: SelectionOptions = {
  hashThreshold: 12,
  strongMargin: 6,
  histVeto: 0.99,
  minGapS: 3,
  keepaliveS: 30,
  maxPerHour: 150,
}

export interface SelectedKeyframe {
  index: number
  timestampMs: number
  changeScore: number
}

export interface SelectionResult {
  keyframes: SelectedKeyframe[]
  /** True when the cap truncated coverage — MUST be surfaced in the UI. */
  capped: boolean
  totalFrames: number
}

/**
 * Walk 1 fps frames and pick keyframes. `frames` is the concatenated raw
 * grayscale stream; frame i covers second i.
 */
export function selectKeyframes(
  frames: Uint8Array,
  opts: SelectionOptions = DEFAULT_SELECTION,
): SelectionResult {
  const total = Math.floor(frames.length / FRAME_BYTES)
  const result: SelectedKeyframe[] = []
  if (total === 0) return { keyframes: [], capped: false, totalFrames: 0 }

  const cap = Math.max(10, Math.ceil((total / 3600) * opts.maxPerHour))
  let capped = false

  let lastKfHash: bigint | null = null
  let lastKfHist: Float64Array | null = null
  let lastKfIndex = -Infinity

  for (let i = 0; i < total; i++) {
    const gray = frames.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)
    const hash = pHash(gray)
    const hist = histogram(gray)

    let take = false
    let score = 0
    if (lastKfHash === null) {
      take = true // always keep the first frame
      score = 64
    } else {
      const dist = hammingDistance(hash, lastKfHash)
      const strong = dist >= opts.hashThreshold + opts.strongMargin
      const marginal =
        dist > opts.hashThreshold && histIntersection(hist, lastKfHist!) < opts.histVeto
      const keepalive = i - lastKfIndex >= opts.keepaliveS
      if ((strong || marginal || keepalive) && i - lastKfIndex >= opts.minGapS) {
        take = true
        score = dist
      }
    }

    if (take) {
      if (result.length >= cap) {
        capped = true
        break
      }
      result.push({ index: i, timestampMs: i * 1000, changeScore: score })
      lastKfHash = hash
      lastKfHist = hist
      lastKfIndex = i
    }
  }

  return { keyframes: result, capped, totalFrames: total }
}
