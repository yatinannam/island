// island: hover-reveal top island for Windows.
// Run:     bun install && bun run start
// Flags:   --open   start with the island pinned open (for testing)
// Hotkeys: Ctrl+Alt+I pin/unpin the island, Ctrl+Alt+Q quit.

const {
  app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');

// Expanded island shape, in DIP. Must match --w / --h in island.html.
const SHAPE_W = 380;
const SHAPE_H = 140;
// Window is bigger than the shape so the spring overshoot, the top "ears"
// and the shadow are not clipped.
const PAD_X = 48;
const PAD_B = 48;
const WIN_W = SHAPE_W + PAD_X * 2;
const WIN_H = SHAPE_H + PAD_B;

const HOT_W = 240;          // hot zone width, centered on the top edge
const HOT_H = 3;            // px from the top edge that triggers
const HOT_DWELL = 150;      // ms the cursor must rest in the hot zone, so passing through to a browser tab doesn't open it
const LEAVE_PAD = 10;       // tolerance around the shape before leaving counts
const LEAVE_DELAY = 300;    // ms the cursor must stay outside before closing
const HIDE_AFTER_CLOSE = 450; // ms for the close animation before hiding the window
const TICK_MS = 16;

let win = null;
let tray = null;
let ready = false;
let isOpen = false;
let pinned = false;
let leaveSince = 0;
let hotSince = 0;
let hideTimer = null;
let current = null; // display the island is on

const DEBUG = process.env.ISLAND_DEBUG === '1';
const log = (...a) => { if (DEBUG) console.log('[island]', ...a); };

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function displayAt(p) {
  return screen.getDisplayNearestPoint(p);
}

function windowBounds(d) {
  const b = d.bounds;
  return {
    x: Math.round(b.x + (b.width - WIN_W) / 2),
    y: b.y,
    width: WIN_W,
    height: WIN_H,
  };
}

function shapeRect(d) {
  const b = d.bounds;
  return {
    x: b.x + (b.width - SHAPE_W) / 2,
    y: b.y,
    width: SHAPE_W,
    height: SHAPE_H,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(screen.getPrimaryDisplay()),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,     // never steals focus from the app you are typing in
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep animations smooth right after show
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Transparent parts never block clicks. The renderer turns mouse input back
  // on while the cursor is over the shape itself.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('island.html');
  win.webContents.once('did-finish-load', () => {
    ready = true;
    if (process.argv.includes('--open')) {
      pinned = true;
      openIsland(screen.getPrimaryDisplay());
    }
  });
}

function send(channel, value) {
  if (ready && win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function openIsland(d) {
  if (isOpen || !ready) return;
  isOpen = true;
  leaveSince = 0;
  clearTimeout(hideTimer);
  current = d;
  win.setBounds(windowBounds(d));
  win.setAlwaysOnTop(true, 'screen-saver'); // re-assert: other topmost windows may sit above us
  win.showInactive();
  send('island-state', 'open');
}

function closeIsland() {
  if (!isOpen) return;
  isOpen = false;
  pinned = false;
  send('island-state', 'closed');
  win.setIgnoreMouseEvents(true, { forward: true });
  clearTimeout(hideTimer);
  // Hide once collapsed, so nothing sits over fullscreen games and video.
  hideTimer = setTimeout(() => { if (!isOpen) win.hide(); }, HIDE_AFTER_CLOSE);
}

function inHotZone(p, d) {
  const b = d.bounds;
  const cx = b.x + b.width / 2;
  return p.y >= b.y && p.y < b.y + HOT_H && Math.abs(p.x - cx) <= HOT_W / 2;
}

function inShape(p, d) {
  const r = shapeRect(d);
  return p.x >= r.x - LEAVE_PAD && p.x <= r.x + r.width + LEAVE_PAD
      && p.y >= r.y && p.y <= r.y + r.height + LEAVE_PAD;
}

function tick() {
  const p = screen.getCursorScreenPoint();
  if (!isOpen) {
    const d = displayAt(p);
    if (!inHotZone(p, d)) {
      hotSince = 0;
    } else if (!hotSince) {
      hotSince = Date.now();
    } else if (Date.now() - hotSince >= HOT_DWELL) {
      hotSince = 0;
      log('open: cursor', p, 'display', d.bounds, 'scale', d.scaleFactor);
      openIsland(d);
    }
    return;
  }
  if (pinned) return;
  if (inShape(p, current)) {
    leaveSince = 0;
  } else if (!leaveSince) {
    leaveSince = Date.now();
  } else if (Date.now() - leaveSince > LEAVE_DELAY) {
    log('close: cursor', p, 'shape', shapeRect(current));
    closeIsland();
  }
}

function togglePinned() {
  if (isOpen) {
    closeIsland();
  } else {
    pinned = true;
    openIsland(displayAt(screen.getCursorScreenPoint()));
  }
}

// 16x16 white rounded pill for the tray, drawn as raw BGRA pixels.
function trayIcon() {
  const s = 16;
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // pill from (2,5) to (13,10), radius 3
      const cx = Math.min(Math.max(x + 0.5, 5), 11);
      const cy = 7.5;
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, 3 - dist + 0.5));
      const i = (y * s + x) * 4;
      buf[i] = buf[i + 1] = buf[i + 2] = 255;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('island');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Pin island open (Ctrl+Alt+I)', click: togglePinned },
    { type: 'separator' },
    { label: 'Quit (Ctrl+Alt+Q)', click: () => app.quit() },
  ]));
}

function registerShortcut(accel, fn) {
  if (!globalShortcut.register(accel, fn)) {
    console.warn(`[island] could not register ${accel}, another app is using it`);
  }
}

ipcMain.on('hover', (_e, over) => {
  if (!win || win.isDestroyed()) return;
  if (over && isOpen) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  setInterval(tick, TICK_MS);
  registerShortcut('Control+Alt+I', togglePinned);
  registerShortcut('Control+Alt+Q', () => app.quit());
  screen.on('display-removed', () => {
    if (isOpen) closeIsland();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
