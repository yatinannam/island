const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  onState: (cb) => ipcRenderer.on('island-state', (_e, state) => cb(state)),
  onRipple: (cb) => ipcRenderer.on('ripple', (_e, origin) => cb(origin)),
});
