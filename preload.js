const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  hold: (on) => ipcRenderer.send('hold', !!on),
  shapeSize: (h) => ipcRenderer.send('shape-size', Number(h)),
  onShelf: listen('shelf'),
  // Path on disk of a dropped File, or '' when it only exists in memory.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  shelfAdd: (paths) => ipcRenderer.send('shelf-add', paths.map(String)),
  shelfAddData: (name, bytes) => ipcRenderer.send('shelf-add-data', { name: String(name), bytes }),
  shelfRemove: (id) => ipcRenderer.send('shelf-remove', String(id)),
  shelfClear: () => ipcRenderer.send('shelf-clear'),
  shelfOpen: (id) => ipcRenderer.send('shelf-open', String(id)),
  shelfDrag: (ids) => ipcRenderer.send('shelf-drag', ids.map(String)),
  // Live activities (Claude Code)
  onOpenPage: listen('open-page'),
  onPeek: listen('peek'),
  onBanner: listen('banner'),
  onActivity: listen('activity'),
  peekClick: (id) => ipcRenderer.send('peek-click', String(id)),
  peekDismiss: (id) => ipcRenderer.send('peek-dismiss', String(id)),
  activityJump: (id) => ipcRenderer.send('activity-jump', String(id)),
  activityDismiss: (id) => ipcRenderer.send('activity-dismiss', String(id)),
});
