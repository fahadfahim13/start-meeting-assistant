import { describe, expect, it } from 'vitest'
import { buildCaptureArgs, pickEncoder } from '../../src/main/capture/ffmpeg-builder'
import { pipGeometry } from '../../src/main/capture/pip'
import type { CaptureConfig } from '../../src/shared/schemas/capture'
import type { Capabilities } from '../../src/shared/schemas/devices'

const caps = (encoders: Capabilities['workingEncoders']): Capabilities => ({
  workingEncoders: encoders,
  ddagrabWorks: true,
  gdigrabWorks: true,
  probeVersion: 2,
  ffmpegVersion: '8.1.1',
  probedAt: 0,
  probeDurationMs: 0,
})

const fullConfig: CaptureConfig = {
  title: 'test',
  preset: 'balanced',
  screen: { sourceId: 'screen:0:0', kind: 'screen', displayIndex: 0, windowTitle: null, label: null },
  camera: { dshowName: 'HP TrueVision HD Camera' },
  microphone: { dshowName: 'Microphone Array (AMD Audio Device)' },
  systemAudio: true,
}

describe('buildCaptureArgs', () => {
  it('builds the verified AMF chain with the mandatory nv12 conversion (M-001)', () => {
    const { args, encoder } = buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['h264_amf', 'libx264']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(encoder).toBe('h264_amf')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('hwdownload,format=bgra,format=nv12,hwupload')
    // Camera chain must ALSO be nv12 for AMF (M-007's sibling fix).
    expect(filter).toContain('format=nv12[vcam]')
    expect(filter).not.toContain('yuv420p')
  })

  it('uses yuv420p for the camera when falling back to libx264', () => {
    const { args } = buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['libx264']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('format=yuv420p[vcam]')
  })

  it('keeps mic and system audio as separate mapped tracks — ADR-007 invariant', () => {
    const { args } = buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    // Each track now passes through its own named volume filter so it can be
    // muted mid-recording; the invariant is unchanged — two separate tracks,
    // mic first, never combined.
    const maps = args.filter((_, i) => args[i - 1] === '-map')
    expect(maps).toContain('[amic]')
    expect(maps).toContain('[asys]')
    expect(maps.indexOf('[amic]')).toBeLessThan(maps.indexOf('[asys]'))
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[0:a]volume@mic=1[amic]')
    expect(filter).toContain('[1:a]volume@sys=1[asys]')
    expect(args.join(' ')).not.toContain('amerge')
    expect(args.join(' ')).not.toContain('amix')
    expect(args).toContain('title=Microphone')
    expect(args).toContain('title=System Audio')
  })

  it('passes device names as discrete argv elements, never quoted or interpolated', () => {
    const { args } = buildCaptureArgs({
      config: {
        ...fullConfig,
        microphone: { dshowName: 'Evil "name" & $(whoami) | mic' },
      },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    // The whole point of argv arrays: metacharacters stay inert data.
    expect(args).toContain('audio=Evil "name" & $(whoami) | mic')
  })

  it('omits the pipe input when system audio is off', () => {
    const { args, trackLayout } = buildCaptureArgs({
      config: { ...fullConfig, systemAudio: false },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: null,
    })
    expect(trackLayout.system).toBe(false)
    expect(args.join(' ')).not.toContain('pipe')
  })

  const windowConfig: CaptureConfig = {
    ...fullConfig,
    screen: {
      sourceId: 'window:1:0',
      kind: 'window',
      displayIndex: null,
      windowTitle: 'My Window',
      label: 'My Window',
    },
  }

  it('window capture uses gdigrab with the window title', () => {
    const { args } = buildCaptureArgs({
      config: windowConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(args).toContain('gdigrab')
    expect(args).toContain('title=My Window')
  })

  // M-021 regression pin. A minimised window is captured by gdigrab at its tiny
  // restored-down size (measured: 181x25); h264_amf refuses anything under
  // 128x128 and the ENTIRE recording died with `frame= 0 … Conversion failed!`.
  // The old code mapped gdigrab's output raw, so nothing could rescue it.
  it('pads a window chain up to the h264_amf floor instead of mapping it raw', () => {
    const { args } = buildCaptureArgs({
      config: windowConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('pad=')
    expect(filter).toContain('128')
    expect(filter).toContain('[vscreen]')

    const maps = args.filter((_, i) => args[i - 1] === '-map')
    expect(maps).toContain('[vscreen]')
    // The raw `N:v` mapping is the exact shape that let gdigrab reach the
    // encoder unpadded. It must not come back for any video source.
    expect(maps.some((m) => /^\d+:v$/.test(m))).toBe(false)
  })

  it('pads the gdigrab desktop fallback too, not just window capture', () => {
    const { args } = buildCaptureArgs({
      config: fullConfig,
      capabilities: { ...caps(['h264_amf']), ddagrabWorks: false },
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(args).toContain('desktop')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('pad=')
    expect(args.filter((_, i) => args[i - 1] === '-map')).toContain('[vscreen]')
  })

  it('gives a gdigrab window yuv420p when the encoder is libx264', () => {
    const { args } = buildCaptureArgs({
      config: windowConfig,
      capabilities: caps(['libx264']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('format=yuv420p[vscreen]')
  })

  // The a:0/a:1 invariant is about ORDER, not absolute index: with the mic off,
  // system audio legitimately becomes a:0. This combination was untested and is
  // the one an on/off toggle is most likely to break.
  it('makes system audio track a:0 when the microphone is disabled', () => {
    const { args, trackLayout } = buildCaptureArgs({
      config: { ...fullConfig, microphone: null },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(trackLayout.mic).toBe(false)
    expect(trackLayout.system).toBe(true)
    expect(args.filter((_, i) => args[i - 1] === '-map')).toContain('[asys]')
    // The system pipe is input 0 when the mic is off — the ORDER invariant is
    // preserved, the absolute index is not fixed and never was.
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[0:a]volume@sys=')
    expect(args).toContain('title=System Audio')
    expect(args).not.toContain('title=Microphone')
    expect(args.join(' ')).not.toContain('-f dshow -thread_queue_size 4096')
  })

  it('starts a track muted when asked, so pause/resume preserves mute state', () => {
    // Pause/resume respawns ffmpeg. Without carrying the state back in, resuming
    // would silently un-mute a track the user had muted.
    const { args } = buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
      muted: { mic: true, system: false },
    })
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('volume@mic=0')
    expect(filter).toContain('volume@sys=1')
    // Muting must not remove the track — the concat needs identical streams.
    expect(args.filter((_, i) => args[i - 1] === '-map')).toContain('[amic]')
  })

  it('uses quality-based rate control, not a fixed bitrate', () => {
    // A near-static meeting screen at CBR 6000k measured 2.45 GB/h; the same
    // capture at QP 26 measured 0.53 GB/h at the same framerate.
    const { args } = buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(args).toContain('-rc')
    expect(args).toContain('cqp')
    expect(args.join(' ')).not.toContain('-b:v')
  })

  it('drops the audio encoder entirely when both audio sources are off', () => {
    const { args, trackLayout } = buildCaptureArgs({
      config: { ...fullConfig, microphone: null, systemAudio: false },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: null,
    })
    expect(trackLayout.mic).toBe(false)
    expect(trackLayout.system).toBe(false)
    expect(args).not.toContain('-c:a')
  })

  it('omits the camera chain when the camera is off', () => {
    const { args, trackLayout } = buildCaptureArgs({
      config: { ...fullConfig, camera: null },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(trackLayout.camera).toBe(false)
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).not.toContain('[vcam]')
    expect(args.filter((_, i) => args[i - 1] === '-map')).not.toContain('[vcam]')
    expect(args).not.toContain('title=Camera')
  })

  it('throws CAPTURE_ENCODER_FAILED when no encoder works', () => {
    expect(() => pickEncoder(caps([]))).toThrowError(/no working encoder/)
  })
})

describe('camera overlay (ADR-017)', () => {
  const geom = pipGeometry({ position: 'bottom-right', sizePct: 22, screenHeightPx: 1080 })!
  const pip = { geometry: geom, maskPath: 'C:/res/assets/pip-mask-16x9.png' }

  const build = (over: Partial<Parameters<typeof buildCaptureArgs>[0]> = {}) =>
    buildCaptureArgs({
      config: fullConfig,
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
      pip,
      ...over,
    })

  const filterOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]!
  const mapsOf = (args: string[]): string[] => args.filter((_, i) => args[i - 1] === '-map')

  it('keeps the RAW camera as its own track — the stream count does not change', () => {
    const { args, trackLayout } = build()
    expect(trackLayout.pip).toBe(true)
    const maps = mapsOf(args)
    // Exactly the same two video maps as without the overlay. This is what
    // lets a degraded respawn produce segments that still concatenate (M-011).
    expect(maps.filter((m) => m === '[vscreen]' || m === '[vcam]')).toEqual(['[vscreen]', '[vcam]'])
    expect(filterOf(args)).toContain('split=2[camraw][campip]')
    expect(filterOf(args)).toContain('format=nv12[vcam]')
  })

  it('composites in system memory and uploads ONCE, after the overlay (M-001)', () => {
    const filter = filterOf(build().args)
    // The screen chain must NOT still end in hwupload — overlay is a software
    // filter and cannot consume a d3d11 surface.
    expect(filter).not.toContain('format=nv12,hwupload[vscr]')
    expect(filter).toContain('hwdownload,format=bgra,format=yuv420p[vscr]')
    expect(filter.match(/hwupload/g)).toHaveLength(1)
    expect(filter.indexOf('overlay=')).toBeLessThan(filter.indexOf('hwupload'))
    expect(filter).toContain('[vmix]format=nv12,hwupload[vscreen]')
  })

  it('does NOT hwupload on the gdigrab path — there is no d3d11 device there (M-036)', () => {
    // gdigrab means no `-init_hw_device`, so an unconditional hwupload fails
    // the whole graph with "A hardware device reference is required".
    const { args } = build({
      config: {
        ...fullConfig,
        screen: { ...fullConfig.screen!, kind: 'window', windowTitle: 'Zoom Meeting' },
      },
    })
    expect(args).not.toContain('-init_hw_device')
    const filter = filterOf(args)
    expect(filter).toContain('overlay=')
    expect(filter).not.toContain('hwupload')
    expect(filter).toContain('[vmix]format=nv12[vscreen]')
  })

  it('passes the mask as an input rather than a path inside the filter string', () => {
    const { args } = build()
    expect(args).toContain(pip.maskPath)
    expect(args[args.indexOf(pip.maskPath) - 1]).toBe('-i')
    expect(filterOf(args)).not.toContain('movie=')
    expect(filterOf(args)).not.toContain(pip.maskPath)
    // -loop 1, or a single still frame stops feeding alphamerge after one frame.
    expect(args).toContain('-loop')
  })

  it('still forbids a bare N:v mapping (M-021)', () => {
    const maps = mapsOf(build().args)
    expect(maps.some((m) => /^\d+:v$/.test(m))).toBe(false)
  })

  it('ignores the overlay when there is nothing to composite onto or with', () => {
    for (const config of [
      { ...fullConfig, camera: null },
      { ...fullConfig, screen: null },
    ]) {
      const { args, trackLayout } = build({ config })
      expect(trackLayout.pip).toBe(false)
      expect(filterOf(args)).not.toContain('overlay=')
      expect(args).not.toContain(pip.maskPath)
    }
  })

  it('leaves the argv untouched when the overlay is off', () => {
    const base = { config: fullConfig, capabilities: caps(['h264_amf']), output: { kind: 'single' as const, path: 'C:/out/x.mkv' }, pcmPipePath: '\\\\.\\pipe\\test' }
    // The regression pin: `pip: null` must be byte-identical to not passing it,
    // which is what keeps the verified recipes in CLAUDE.md verified.
    expect(buildCaptureArgs({ ...base, pip: null }).args).toEqual(buildCaptureArgs(base).args)
  })

  it('names the composited track for what it holds', () => {
    expect(build().args).toContain('title=Screen + Camera')
    expect(build({ pip: null }).args).toContain('title=Screen')
  })
})
