const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, value) => cb(value));

contextBridge.exposeInMainWorld('island', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  onState: listen('island-state'),
  onConfig: listen('config'),
  onCapture: listen('capture'),
  onMedia: listen('media-state'),
  onArt: listen('media-art'),
  media: (cmd) => ipcRenderer.send('media-cmd', String(cmd)),
  debug: (msg) => ipcRenderer.send('debug', String(msg)),
});
