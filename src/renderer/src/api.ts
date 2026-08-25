import type { MeetFrogeApi } from '@shared/ipc'

declare global {
  interface Window {
    meetfroge: MeetFrogeApi
  }
}

/** Typed access to the preload surface. Nothing else touches window.meetfroge. */
export const api = window.meetfroge
