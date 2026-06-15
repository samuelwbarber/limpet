// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winux', {
  onData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  sendInput: (d) => ipcRenderer.send('term:input', d),
  resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
  dropFiles: (paths) => ipcRenderer.invoke('term:drop-files', paths),
  clipboardCopy: (text) => ipcRenderer.invoke('clip:write', text),
  clipboardPaste: () => ipcRenderer.invoke('clip:read'),
  onReels: (cb) => ipcRenderer.on('reels:toggle', (_e, url) => cb(url)),
});
