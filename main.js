// island: hover-reveal top island for Windows.
// Run:     bun install && bun run start
// Flags:   --open   start with the island pinned open (for testing)
//          --solid  start with glass off
// Env:     ISLAND_DEBUG=1 log open/close; ISLAND_SHOT=file.png save a capture of the page once open
// Hotkeys: Ctrl+Alt+I pin/unpin the island, Ctrl+Alt+Q quit.

const {
  app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage,
  desktopCapturer, nativeTheme,
} = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MediaHelper } = require('./media/helper');

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

// Glass = blurred capture of the screen behind the island. It needs the
// window excluded from capture, which also hides it from screenshots.
let glassWanted = !process.argv.includes('--solid');
let theme = { dark: true, transparency: true };
const sourceIds = new Map(); // display id -> desktopCapturer source id

const media = new MediaHelper();

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

// ---- theme and glass ------------------------------------------------------

// Follow the taskbar's theme and the "Transparency effects" switch.
function readTheme() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'],
      { windowsHide: true }, (_err, out) => {
        const dword = (name, fallback) => {
          const m = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(out || '');
          return m ? parseInt(m[1], 16) : fallback;
        };
        resolve({
          dark: dword('SystemUsesLightTheme', 0) === 0,
          transparency: dword('EnableTransparency', 1) === 1,
        });
      });
  });
}

function config() {
  return { glass: glassWanted && theme.transparency, dark: theme.dark };
}

function applyConfig() {
  if (!win || win.isDestroyed()) return;
  win.setContentProtection(config().glass);
  send('config', config());
  updateTrayMenu();
}

async function refreshTheme() {
  const next = await readTheme();
  if (next.dark !== theme.dark || next.transparency !== theme.transparency) {
    theme = next;
    applyConfig();
  }
}

async function captureSource(d) {
  if (sourceIds.has(d.id)) return sourceIds.get(d.id);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  sourceIds.clear();
  for (const s of sources) sourceIds.set(Number(s.display_id), s.id);
  return sourceIds.get(d.id) || (sources[0] && sources[0].id) || null;
}

async function sendCapture(d) {
  if (!config().glass) return;
  try {
    const sourceId = await captureSource(d);
    if (sourceId) send('capture', { sourceId, display: d.bounds, window: windowBounds(d) });
  } catch (e) {
    log('capture source failed', e.message);
  }
}

// ---- window ----------------------------------------------------------------

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
  win.setContentProtection(config().glass);
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
  sendCapture(d);
  win.showInactive();
  send('island-state', 'open');
  refreshTheme();
  if (process.env.ISLAND_SHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.ISLAND_SHOT, img.toPNG());
      log('saved', process.env.ISLAND_SHOT);
    }, 1800);
  }
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

// ---- tray ------------------------------------------------------------------

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

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Pin island open (Ctrl+Alt+I)', click: togglePinned },
    {
      label: 'Glass background (hidden from screenshots)',
      type: 'checkbox',
      checked: glassWanted,
      enabled: theme.transparency,
      click: (item) => { glassWanted = item.checked; applyConfig(); },
    },
    { type: 'separator' },
    { label: 'Quit (Ctrl+Alt+Q)', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('island');
  updateTrayMenu();
}

function registerShortcut(accel, fn) {
  if (!globalShortcut.register(accel, fn)) {
    console.warn(`[island] could not register ${accel}, another app is using it`);
  }
}

// ---- IPC -------------------------------------------------------------------

ipcMain.on('hover', (_e, over) => {
  if (!win || win.isDestroyed()) return;
  if (over && isOpen) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('media-cmd', (_e, cmd) => media.command(String(cmd)));

ipcMain.handle('snapshot', () => ({ config: config(), media: media.state, art: media.art }));

media.on('state', (s) => send('media-state', s));
media.on('art', (a) => send('media-art', a));
media.on('error', (e) => log('media:', e.message));

// ---- app -------------------------------------------------------------------

app.whenReady().then(async () => {
  theme = await readTheme();
  createWindow();
  createTray();
  media.start();
  setInterval(tick, TICK_MS);
  registerShortcut('Control+Alt+I', togglePinned);
  registerShortcut('Control+Alt+Q', () => app.quit());
  nativeTheme.on('updated', refreshTheme);
  const displaysChanged = () => {
    sourceIds.clear();
    if (isOpen) closeIsland();
  };
  screen.on('display-removed', displaysChanged);
  screen.on('display-added', displaysChanged);
  screen.on('display-metrics-changed', () => sourceIds.clear());
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  media.stop();
});
