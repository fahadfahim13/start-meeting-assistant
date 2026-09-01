/**
 * Picture-in-picture geometry: where the camera sits ON the screen track.
 *
 * ADR-017. The camera keeps its own untouched track (`v:1`); this module only
 * describes the copy that is burned into `v:0`, so the stream COUNT is the same
 * whether the overlay is on or off. That is what lets a segment recorded with
 * the overlay concatenate with one recorded without it (M-011), and what lets
 * the degrade path in session.ts respawn without the overlay mid-recording.
 *
 * Everything here is pure. The box is sized in main rather than in an ffmpeg
 * expression because `scale` cannot reference another input's dimensions —
 * only `overlay` knows `main_w`/`main_h`, and by then it is too late to resize.
 * So the pixel size is computed from the real display height and SNAPSHOTTED
 * into capture_profile (M-031): a recording must not be reinterpreted later
 * under a setting the user has since changed.
 */

import { z } from 'zod'

export const PIP_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export type PipCorner = (typeof PIP_CORNERS)[number]
export type PipPosition = 'off' | PipCorner

export const PIP_SIZE_PCT_MIN = 10
export const PIP_SIZE_PCT_MAX = 40
export const PIP_SIZE_PCT_DEFAULT = 22

/**
 * Used when the capture source's real height cannot be resolved — a window
 * capture, or a display id that no longer maps to a display. REF-01 is 1080p.
 * Which of the two was used is recorded, so the file never claims a precision
 * it does not have (Principle 5).
 */
export const ASSUMED_SCREEN_HEIGHT = 1080

/** Below this the picture is not a face any more, it is a smudge. */
const MIN_BOX_HEIGHT = 96

/** One box aspect for every size, so a single mask asset fits them all. */
const BOX_ASPECT_W = 16
const BOX_ASPECT_H = 9

/**
 * Gap from the screen edge, as a fraction of the frame WIDTH — used for both
 * axes so the visual gap is square. Deliberately an ffmpeg expression rather
 * than a computed pixel count: `overlay` knows `main_w` at runtime, so the
 * margin stays correct even if the captured frame is not the size we assumed.
 */
const MARGIN_FRACTION = 0.02
const MARGIN = `main_w*${MARGIN_FRACTION}`

/** Light border, so a dark webcam frame still reads as a card on a dark slide. */
export const PIP_BORDER_COLOR = 'white'

/**
 * The frozen description of one recording's overlay. This is both the builder's
 * input and the capture_profile snapshot — one object, so the two can never
 * disagree about what was burned in.
 */
export interface PipGeometry {
  position: PipCorner
  sizePct: number
  /** Outer box, border included. Always even — h264 has no odd dimensions. */
  boxW: number
  boxH: number
  borderPx: number
  screenHeightPx: number
  screenHeightSource: 'display' | 'assumed'
}

/**
 * Reading the snapshot back out of capture_profile.
 *
 * Anything that fails to parse — an older recording made before the overlay
 * existed, a truncated row — is simply "no overlay", which is the behaviour
 * every consumer already had to handle anyway.
 */
export const PipGeometrySchema = z.object({
  position: z.enum(PIP_CORNERS),
  sizePct: z.number().int(),
  boxW: z.number().int().positive(),
  boxH: z.number().int().positive(),
  borderPx: z.number().int().nonnegative(),
  screenHeightPx: z.number().int().positive(),
  screenHeightSource: z.enum(['display', 'assumed']),
})

export function parsePipGeometry(raw: unknown): PipGeometry | null {
  const parsed = PipGeometrySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

export function clampSizePct(pct: number): number {
  if (!Number.isFinite(pct)) return PIP_SIZE_PCT_DEFAULT
  return clamp(Math.round(pct), PIP_SIZE_PCT_MIN, PIP_SIZE_PCT_MAX)
}

/**
 * Resolve a position + size into concrete pixels, or null for "no overlay".
 *
 * Null is the whole of the off switch: every caller treats it as "behave
 * exactly as the app did before this feature existed", which is what keeps the
 * overlay-off ffmpeg argv byte-identical to the verified recipes in CLAUDE.md.
 */
export function pipGeometry(input: {
  position: PipPosition
  sizePct: number
  screenHeightPx: number | null
}): PipGeometry | null {
  if (input.position === 'off') return null

  const given = input.screenHeightPx
  const resolved = given !== null && Number.isFinite(given) && given >= MIN_BOX_HEIGHT * 2
  const screenHeightPx = resolved ? Math.round(given) : ASSUMED_SCREEN_HEIGHT
  const sizePct = clampSizePct(input.sizePct)

  // Never let the picture-in-picture eat half the screen, whatever the maths
  // says on a tiny capture.
  const ceilingH = Math.max(MIN_BOX_HEIGHT, Math.floor(screenHeightPx / 2))
  const boxH = even(clamp(Math.round((screenHeightPx * sizePct) / 100), MIN_BOX_HEIGHT, ceilingH))
  const boxW = even((boxH * BOX_ASPECT_W) / BOX_ASPECT_H)

  // Even, so subtracting it twice leaves the inner picture even as well.
  const borderPx = even(Math.max(2, Math.round(boxH * 0.012)))

  return {
    position: input.position,
    sizePct,
    boxW,
    boxH,
    borderPx,
    screenHeightPx,
    screenHeightSource: resolved ? 'display' : 'assumed',
  }
}

/** The inner picture, inside the border ring. */
export function pipInnerSize(geom: PipGeometry): { w: number; h: number } {
  return {
    w: Math.max(2, geom.boxW - 2 * geom.borderPx),
    h: Math.max(2, geom.boxH - 2 * geom.borderPx),
  }
}

/**
 * `overlay` x/y expressions for a corner.
 *
 * No commas anywhere — a bare comma inside a filter is an argument separator
 * and would need escaping (see the `even()` helper in gdigrabFilter for what
 * that looks like when it is unavoidable).
 */
export function pipOverlayXY(position: PipCorner): { x: string; y: string } {
  const right = position === 'top-right' || position === 'bottom-right'
  const bottom = position === 'bottom-left' || position === 'bottom-right'
  return {
    x: right ? `main_w-overlay_w-${MARGIN}` : MARGIN,
    y: bottom ? `main_h-overlay_h-${MARGIN}` : MARGIN,
  }
}

/**
 * Build the camera side of the composite: fill the box, ring it with a border,
 * then punch the rounded corners out with the mask input.
 *
 * `force_original_aspect_ratio=increase` + `crop` fills the box and centre-crops
 * the excess. Letterboxing instead would put black bars inside the rounded card,
 * which looks like a broken camera.
 *
 * The mask is a real ffmpeg INPUT, not a `movie=` filter source: a Windows path
 * inside a filter string needs its drive colon escaped, and one wrong backslash
 * there costs a whole recording. As an argv element there is nothing to escape.
 */
export function pipCameraFilters(input: {
  cameraLabel: string
  maskInputIndex: number
  geom: PipGeometry
  outLabel: string
}): string[] {
  const { geom } = input
  const inner = pipInnerSize(geom)
  const boxLabel = `${input.outLabel}box`
  const maskLabel = `${input.outLabel}mask`
  return [
    `[${input.cameraLabel}]scale=${inner.w}:${inner.h}:force_original_aspect_ratio=increase,` +
      `crop=${inner.w}:${inner.h},` +
      `pad=${geom.boxW}:${geom.boxH}:${geom.borderPx}:${geom.borderPx}:color=${PIP_BORDER_COLOR},` +
      `format=yuva420p[${boxLabel}]`,
    `[${input.maskInputIndex}:v]scale=${geom.boxW}:${geom.boxH},format=gray[${maskLabel}]`,
    `[${boxLabel}][${maskLabel}]alphamerge[${input.outLabel}]`,
  ]
}

/** The composite itself. `format=yuv420` is overlay's cheapest alpha path. */
export function pipOverlayFilter(input: {
  screenLabel: string
  pipLabel: string
  geom: PipGeometry
  outLabel: string
}): string {
  const { x, y } = pipOverlayXY(input.geom.position)
  return `[${input.screenLabel}][${input.pipLabel}]overlay=x=${x}:y=${y}:format=yuv420[${input.outLabel}]`
}

/**
 * Fill the overlay rectangle with black — for the visual-analysis pass only.
 *
 * Scene detection drives keyframe SELECTION, and a face moving in the corner of
 * an otherwise static slide is exactly what the change score is looking for. Left
 * alone, a talking head would generate keyframes for a screen that never changed,
 * and OCR would then be handed a webcam. `iw` here is the analysed frame's own
 * width, which is the same `main_w` the overlay used.
 */
export function pipBlankFilter(geom: PipGeometry): string {
  const right = geom.position === 'top-right' || geom.position === 'bottom-right'
  const bottom = geom.position === 'bottom-left' || geom.position === 'bottom-right'
  const margin = `iw*${MARGIN_FRACTION}`
  const x = right ? `iw-${geom.boxW}-${margin}` : margin
  const y = bottom ? `ih-${geom.boxH}-${margin}` : margin
  return `drawbox=x=${x}:y=${y}:w=${geom.boxW}:h=${geom.boxH}:color=black:t=fill`
}
