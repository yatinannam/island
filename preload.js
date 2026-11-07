const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  onState: (cb) => ipcRenderer.on('island-state', (_e, state) => cb(state)),
  setHover: (over) => ipcRenderer.send('hover', !!over),
});
