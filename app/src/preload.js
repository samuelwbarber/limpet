// Bridge between the sandboxed renderer and the main process. Terminal
// channels are tagged with a session id — one session per tab.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('limpet', {
  createSession: () => ipcRenderer.invoke('term:create'),
  closeSession: (id) => ipcRenderer.send('term:close', id),
  onData: (cb) => ipcRenderer.on('term:data', (_e, p) => cb(p)),
  onExit: (cb) => ipcRenderer.on('term:exit', (_e, p) => cb(p)),
  sendInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  dropFiles: (id, paths) => ipcRenderer.invoke('term:drop-files', { id, paths }),
  clipboardCopy: (text) => ipcRenderer.invoke('clip:write', text),
  clipboardPaste: () => ipcRenderer.invoke('clip:read'),
  onReels: (cb) => ipcRenderer.on('reels:toggle', (_e, url) => cb(url)),
});
