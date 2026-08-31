import { describe, expect, it } from 'vitest'
import { buildConfig, enabledButUnavailable, type ConfigSource } from '../../src/renderer/src/capture-config'

/**
 * The camera / microphone / system-audio toggles.
 *
 * The invariant these must not break (ADR-007): mic and system audio are never
 * mixed, and their ORDER is fixed — mic before system. The absolute track index
 * is not fixed, and never was: with the mic off, system audio legitimately
 * becomes a:0. `tests/unit/ffmpeg-builder.test.ts` pins the argv side of that;
 * this file pins the config the UI produces.
 */

const CAMERA = { deviceId: 'cam-1', label: 'HP TrueVision HD Camera', dshowName: 'HP TrueVision HD Camera', isVirtual: false }
const MIC = { deviceId: 'mic-1', label: 'Microphone Array', dshowName: 'Microphone Array (AMD Audio Device)' }
const SCREEN = {
  id: 'screen:0:0',
  name: 'Entire screen',
  kind: 'screen' as const,
  displayIndex: 0,
  width: 1920,
  height: 1080,
  thumbnailDataUrl: null,
}

function source(overrides: Partial<ConfigSource['selection']> = {}): ConfigSource {
  return {
    inventory: { cameras: [CAMERA], microphones: [MIC], screens: [SCREEN] },
    selection: {
      screenId: SCREEN.id,
      cameraDeviceId: CAMERA.deviceId,
      cameraEnabled: true,
      microphoneDeviceId: MIC.deviceId,
      microphoneEnabled: true,
      systemAudio: true,
      preset: 'balanced',
      title: 'test',
      ...overrides,
    },
  }
}

describe('buildConfig — source toggles', () => {
  it('includes every source when all three are on', () => {
    const c = buildConfig(source())
    expect(c.camera).not.toBeNull()
    expect(c.microphone).not.toBeNull()
    expect(c.systemAudio).toBe(true)
  })

  it('drops the camera when the toggle is off but REMEMBERS the device', () => {
    const src = source({ cameraEnabled: false })
    expect(buildConfig(src).camera).toBeNull()
    // The whole point of splitting "enabled" from "chosen": switching back on
    // must not require re-picking the device.
    expect(src.selection.cameraDeviceId).toBe(CAMERA.deviceId)
    expect(buildConfig(source({ cameraEnabled: true })).camera).toEqual({
      dshowName: CAMERA.dshowName,
    })
  })

  it('drops the microphone while keeping system audio — "only what others say"', () => {
    const c = buildConfig(source({ microphoneEnabled: false }))
    expect(c.microphone).toBeNull()
    expect(c.systemAudio).toBe(true)
  })

  it('keeps the microphone while dropping system audio — "only my own voice"', () => {
    const c = buildConfig(source({ systemAudio: false }))
    expect(c.microphone).toEqual({ dshowName: MIC.dshowName })
    expect(c.systemAudio).toBe(false)
  })

  it('allows mic and system audio together — they are independent, never mixed', () => {
    const c = buildConfig(source())
    expect(c.microphone).not.toBeNull()
    expect(c.systemAudio).toBe(true)
  })

  it('allows every audio source off (validate() downgrades this to a warning)', () => {
    const c = buildConfig(source({ microphoneEnabled: false, systemAudio: false }))
    expect(c.microphone).toBeNull()
    expect(c.systemAudio).toBe(false)
  })
})

describe('enabledButUnavailable', () => {
  it('reports an enabled device the recorder cannot address', () => {
    const src = source()
    src.inventory = { ...src.inventory!, microphones: [{ ...MIC, dshowName: null }] }
    // buildConfig still has to drop it - ffmpeg has no other way to name the
    // device - so the user must be TOLD, or they record with no mic believing
    // it is on.
    expect(buildConfig(src).microphone).toBeNull()
    expect(enabledButUnavailable(src)).toEqual([MIC.label])
  })

  it('says nothing about a device that is switched off anyway', () => {
    const src = source({ microphoneEnabled: false })
    src.inventory = { ...src.inventory!, microphones: [{ ...MIC, dshowName: null }] }
    expect(enabledButUnavailable(src)).toEqual([])
  })

  it('says nothing when everything reconciled', () => {
    expect(enabledButUnavailable(source())).toEqual([])
  })
})
