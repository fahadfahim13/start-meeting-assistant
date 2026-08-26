import { describe, expect, it } from 'vitest'
import { buildCaptureArgs, pickEncoder } from '../../src/main/capture/ffmpeg-builder'
import type { CaptureConfig } from '../../src/shared/schemas/capture'
import type { Capabilities } from '../../src/shared/schemas/devices'

const caps = (encoders: Capabilities['workingEncoders']): Capabilities => ({
  workingEncoders: encoders,
  ddagrabWorks: true,
  gdigrabWorks: true,
  ffmpegVersion: '8.1.1',
  probedAt: 0,
  probeDurationMs: 0,
})

const fullConfig: CaptureConfig = {
  title: 'test',
  preset: 'balanced',
  screen: { sourceId: 'screen:0:0', kind: 'screen', displayIndex: 0, windowTitle: null },
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
    const maps = args.filter((_, i) => args[i - 1] === '-map')
    expect(maps).toContain('0:a') // mic
    expect(maps).toContain('1:a') // system
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

  it('window capture uses gdigrab with the window title', () => {
    const { args } = buildCaptureArgs({
      config: {
        ...fullConfig,
        screen: { sourceId: 'window:1:0', kind: 'window', displayIndex: null, windowTitle: 'My Window' },
      },
      capabilities: caps(['h264_amf']),
      output: { kind: 'single' as const, path: 'C:/out/x.mkv' },
      pcmPipePath: '\\\\.\\pipe\\test',
    })
    expect(args).toContain('gdigrab')
    expect(args).toContain('title=My Window')
  })

  it('throws CAPTURE_ENCODER_FAILED when no encoder works', () => {
    expect(() => pickEncoder(caps([]))).toThrowError(/no working encoder/)
  })
})
