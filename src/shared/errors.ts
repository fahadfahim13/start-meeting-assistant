/**
 * Stable, machine-readable error codes. The taxonomy from the plan (§10.1):
 * namespaced, every error carries a code + human message + recovery action.
 */
export const ERROR_CODES = {
  // capture
  CAPTURE_ENCODER_FAILED: 'No encoder in the ladder produced output',
  CAPTURE_LOOPBACK_SILENT: 'System audio stream produced only silence',
  CAPTURE_DEVICE_LOST: 'A capture device disappeared mid-recording',
  CAPTURE_ALREADY_ACTIVE: 'A recording session is already active',
  CAPTURE_NOT_ACTIVE: 'No recording session is active',
  CAPTURE_FFMPEG_SPAWN: 'ffmpeg failed to start',
  CAPTURE_FFMPEG_EXIT: 'ffmpeg exited unexpectedly',
  // devices
  DEVICE_NOT_FOUND: 'Selected device is no longer available',
  DEVICE_IN_USE: 'Device is in use by another application',
  DEVICE_UNRECONCILED: 'Device could not be matched to a DirectShow name',
  // storage
  STORAGE_LOW: 'Disk space is below the warning threshold',
  STORAGE_FULL: 'Disk space is below the hard floor',
  // system
  SYSTEM_BINARY_MISSING: 'A required binary was not found',
  SYSTEM_PROBE_FAILED: 'Hardware capability probe failed',
  // ipc
  IPC_INVALID_PAYLOAD: 'Request failed schema validation',
  IPC_UNKNOWN_CHANNEL: 'Unknown IPC channel',
  IPC_INTERNAL: 'Internal error',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERROR_CODES[code])
    this.name = 'AppError'
  }
}
