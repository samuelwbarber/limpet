// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winux', {
  onData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('term:exit', () => cb()),
  onMode: (cb) => ipcRenderer.on('term:mode', (_e, m) => cb(m)),
  sendInput: (d) => ipcRenderer.send('term:input', d),
  resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
});
