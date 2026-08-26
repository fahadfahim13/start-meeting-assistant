import { contextBridge, ipcRenderer } from 'electron'
import type { MeetFrogeApi } from '@shared/ipc'

/**
 * The complete surface the renderer gets. An explicit object literal — never a
 * proxy or a passthrough of ipcRenderer (SECURITY.md §5.3). Channel strings
 * are validated again in main by the gateway; this file adds no logic.
 */
const api: MeetFrogeApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  sendPcmFrame: (buffer) => {
    ipcRenderer.send('loopback:frame', buffer)
  },

  onSessionState: (cb) => {
    const listener = (_e: unknown, status: unknown): void => cb(status)
    ipcRenderer.on('session:state', listener)
    return () => ipcRenderer.removeListener('session:state', listener)
  },

  onLoopbackStats: (cb) => {
    const listener = (_e: unknown, stats: unknown): void => cb(stats)
    ipcRenderer.on('loopback:stats', listener)
    return () => ipcRenderer.removeListener('loopback:stats', listener)
  },

  onJobsUpdate: (cb) => {
    const listener = (_e: unknown, job: unknown): void => cb(job)
    ipcRenderer.on('jobs:update', listener)
    return () => ipcRenderer.removeListener('jobs:update', listener)
  },
}

contextBridge.exposeInMainWorld('meetfroge', Object.freeze(api))
