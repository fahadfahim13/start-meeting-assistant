import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Capabilities, EncoderId } from '@shared/schemas/devices'
import { CapabilitiesSchema } from '@shared/schemas/devices'
import { resolveBinary } from './binaries'

/**
 * Detects what this machine can actually do by RUNNING short real encodes.
 *
 * Never trust `ffmpeg -encoders`: it lists every compiled-in encoder regardless
 * of hardware. On the reference machine h264_amf is listed AND fails on the
 * naive path (MISTAKES.md M-001, benchmarks B-001/B-003). Each ladder rung
 * below is the exact filter chain production will use, so a probe pass means
 * the real recording path works.
 */

const PROBE_TIMEOUT_MS = 15_000

interface ProbeSpec {
  id: EncoderId
  args: string[]
}

// framerate=5 -t 1 keeps each probe under ~2 s while exercising the full chain.
const ENCODER_PROBES: ProbeSpec[] = [
  {
    id: 'h264_amf',
    args: [
      '-init_hw_device', 'd3d11va',
      '-filter_complex', 'ddagrab=0:framerate=5,hwdownload,format=bgra,format=nv12,hwupload',
      '-c:v', 'h264_amf', '-t', '1', '-f', 'null', '-',
    ],
  },
  {
    id: 'h264_nvenc',
    args: [
      '-init_hw_device', 'd3d11va',
      '-filter_complex', 'ddagrab=0:framerate=5,hwdownload,format=bgra,format=nv12',
      '-c:v', 'h264_nvenc', '-t', '1', '-f', 'null', '-',
    ],
  },
  {
    id: 'h264_qsv',
    args: [
      '-init_hw_device', 'd3d11va',
      '-filter_complex', 'ddagrab=0:framerate=5,hwdownload,format=bgra,format=nv12',
      '-c:v', 'h264_qsv', '-t', '1', '-f', 'null', '-',
    ],
  },
  {
    id: 'libx264',
    args: [
      '-init_hw_device', 'd3d11va',
      '-filter_complex', 'ddagrab=0:framerate=5,hwdownload,format=bgra',
      '-c:v', 'libx264', '-preset', 'veryfast', '-t', '1', '-f', 'null', '-',
    ],
  },
]

function runProbe(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // shell: false is implicit with execFile + argv array. Invariant: never a command string.
    const child = execFile(
      resolveBinary('ffmpeg'),
      ['-hide_banner', '-loglevel', 'error', ...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error),
    )
    child.on('error', () => resolve(false))
  })
}

function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      resolveBinary('ffmpeg'),
      ['-version'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)
        const m = /ffmpeg version (\S+)/.exec(stdout)
        resolve(m?.[1]?.slice(0, 64) ?? null)
      },
    )
  })
}

function cachePath(): string {
  return path.join(app.getPath('userData'), 'capabilities.json')
}

let inFlight: Promise<Capabilities> | null = null

export async function probeCapabilities(force = false): Promise<Capabilities> {
  if (inFlight) return inFlight
  inFlight = doProbe(force).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doProbe(force: boolean): Promise<Capabilities> {
  const version = await ffmpegVersion()

  if (!force) {
    try {
      const cached = CapabilitiesSchema.parse(JSON.parse(readFileSync(cachePath(), 'utf8')))
      // Cache is only valid for the same ffmpeg build; a driver change is caught
      // by the user-facing "re-detect" action (settings), and Phase 2 adds
      // re-probe on driver-version change.
      if (cached.ffmpegVersion === version) return cached
    } catch {
      // no cache / invalid cache — fall through to a real probe
    }
  }

  const started = Date.now()

  const gdigrabWorks = await runProbe([
    '-f', 'gdigrab', '-framerate', '5', '-i', 'desktop',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-',
  ])

  const workingEncoders: EncoderId[] = []
  let ddagrabWorks = false
  for (const probe of ENCODER_PROBES) {
    // Sequential on purpose: parallel hardware-encoder probes can interfere
    // with each other on some drivers.
    if (await runProbe(probe.args)) {
      workingEncoders.push(probe.id)
      ddagrabWorks = true // every rung above uses ddagrab as its source
    }
  }
  // Last-resort rung shares libx264's probe result at a cheaper preset.
  if (workingEncoders.includes('libx264')) workingEncoders.push('libx264_ultrafast')

  const caps: Capabilities = {
    workingEncoders,
    ddagrabWorks,
    gdigrabWorks,
    ffmpegVersion: version,
    probedAt: Date.now(),
    probeDurationMs: Date.now() - started,
  }

  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(caps, null, 2))
  } catch (e) {
    console.warn('[probe] failed to cache capabilities:', e)
  }

  return caps
}
