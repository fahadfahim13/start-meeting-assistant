// Minimal contextBridge surface. Mirrors the production rule: an explicit object
// literal, never a passthrough of ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('spike', {
  ready: () => ipcRenderer.send('spike:ready'),
  format: (fmt) => ipcRenderer.send('spike:format', fmt),
  // Transferable ArrayBuffer, not a structured clone, to avoid copy amplification
  // on a real-time path.
  pcm: (arrayBuffer) => ipcRenderer.send('spike:pcm', arrayBuffer),
  error: (message) => ipcRenderer.send('spike:error', message),
})
