const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (patch) => ipcRenderer.send('settings-set', patch),
  action: (name) => ipcRenderer.send('settings-action', String(name)),
  resize: (height) => ipcRenderer.send('settings-size', height),
  onUpdate: (cb) => ipcRenderer.on('settings', (_e, payload) => cb(payload)),
  onShown: (cb) => ipcRenderer.on('settings-shown', () => cb()),
});
