// Bridge between the sandboxed renderer and the main process. Terminal
// channels are tagged with a session id — one session per tab.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('limpet', {
  createSession: () => ipcRenderer.invoke('term:create'),
  sessionReady: (id) => ipcRenderer.invoke('term:ready', id),
  closeSession: (id) => ipcRenderer.send('term:close', id),
  detachSession: (id, options) => ipcRenderer.invoke('term:detach', { id, options }),
  onData: (cb) => ipcRenderer.on('term:data', (_e, p) => cb(p)),
  onExit: (cb) => ipcRenderer.on('term:exit', (_e, p) => cb(p)),
  sendInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  dropFiles: (id, paths) => ipcRenderer.invoke('term:drop-files', { id, paths }),
  considerBackdrop: (id, snapshot) => ipcRenderer.invoke('term:backdrop-candidate', { id, snapshot }),
  onBackdrop: (cb) => ipcRenderer.on('term:backdrop', (_e, p) => cb(p)),
  onBackdropStatus: (cb) => ipcRenderer.on('term:backdrop-status', (_e, p) => cb(p)),
  clipboardCopy: (text) => ipcRenderer.invoke('clip:write', text),
  clipboardPaste: () => ipcRenderer.invoke('clip:read'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  onReels: (cb) => ipcRenderer.on('reels:toggle', (_e, url) => cb(url)),
});
