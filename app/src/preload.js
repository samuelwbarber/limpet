// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winux', {
  // terminal stream
  onData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onReset: (cb) => ipcRenderer.on('term:reset', () => cb()),
  sendInput: (d) => ipcRenderer.send('term:input', d),
  resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
  // session state
  onActive: (cb) => ipcRenderer.on('term:active', (_e, p) => cb(p)),
  onCwd: (cb) => ipcRenderer.on('ssh:cwd', (_e, p) => cb(p)),
  onEnded: (cb) => ipcRenderer.on('ssh:ended', (_e, p) => cb(p)),
  // ssh control
  sshConnect: (opts) => ipcRenderer.send('ssh:connect', opts),
  sshDisconnect: () => ipcRenderer.send('ssh:disconnect'),
  sshUpload: (paths) => ipcRenderer.invoke('ssh:upload', { paths }),
});
