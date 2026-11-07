// Spike: hover-reveal island + click-through ripple overlay.
// Run: npm install && npm start        (fake glass, transparent window)
//      npm run acrylic                 (real DWM acrylic blur, rectangular window)
// Hotkeys: Ctrl+Alt+I toggle island manually, Ctrl+Alt+Q quit.

const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const path = require('path');

const ACRYLIC = process.argv.includes('--acrylic');

const WIN_W = 400;
const WIN_H = 160;
const HOT_W = 300;          // hot zone width, centered at top edge
const HOT_H = 2;            // px from top edge that triggers
const LEAVE_DELAY = 350;    // ms cursor must be outside before closing
const HIDE_AFTER_CLOSE = 380; // ms to let close animation finish
const RIPPLE_MS = 1700;     // ripple window lifetime

let island, ripple;
let isOpen = false;
let leaveSince = 0;
let hideTimer = null;
let rippleTimer = null;
let manual = false;

function display() {
  return screen.getPrimaryDisplay();
}

function islandBounds() {
  const b = display().bounds;
  return {
    x: Math.round(b.x + (b.width - WIN_W) / 2),
    y: b.y,
    width: WIN_W,
    height: WIN_H,
  };
}

function createIsland() {
  const opts = {
    ...islandBounds(),
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  };
  if (ACRYLIC) {
    opts.backgroundMaterial = 'acrylic';
    opts.backgroundColor = '#00000000';
  } else {
    opts.transparent = true;
  }
  island = new BrowserWindow(opts);
  island.setAlwaysOnTop(true, 'screen-saver');
  island.loadFile('island.html', { query: { mode: ACRYLIC ? 'acrylic' : 'fake' } });
}

function createRipple() {
  const b = display().bounds;
  ripple = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  ripple.setAlwaysOnTop(true, 'screen-saver');
  ripple.setIgnoreMouseEvents(true); // fully click-through
  ripple.loadFile('ripple.html');
}

function fireRipple() {
  const b = display().bounds;
  const origin = { x: b.width / 2, y: WIN_H * 0.45, w: b.width, h: b.height };
  ripple.setBounds(b);
  ripple.showInactive();
  ripple.webContents.send('ripple', origin);
  clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => ripple.hide(), RIPPLE_MS);
}

function openIsland() {
  if (isOpen) return;
  isOpen = true;
  clearTimeout(hideTimer);
  island.setBounds(islandBounds());
  island.showInactive();
  island.webContents.send('island-state', 'open');
  fireRipple();
}

function closeIsland() {
  if (!isOpen) return;
  isOpen = false;
  manual = false;
  island.webContents.send('island-state', 'closed');
  hideTimer = setTimeout(() => island.hide(), HIDE_AFTER_CLOSE);
}

function inHotZone(p) {
  const b = display().bounds;
  const cx = b.x + b.width / 2;
  return p.y <= b.y + HOT_H && Math.abs(p.x - cx) <= HOT_W / 2;
}

function inIsland(p) {
  const r = islandBounds();
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function tick() {
  const p = screen.getCursorScreenPoint();
  if (!isOpen) {
    if (inHotZone(p)) openIsland();
    return;
  }
  if (manual) return;
  if (inIsland(p)) {
    leaveSince = 0;
  } else {
    if (!leaveSince) leaveSince = Date.now();
    if (Date.now() - leaveSince > LEAVE_DELAY) {
      leaveSince = 0;
      closeIsland();
    }
  }
}

app.whenReady().then(() => {
  console.log(`[island] mode=${ACRYLIC ? 'acrylic' : 'fake'}`);
  createIsland();
  createRipple();
  setInterval(tick, 16);

  globalShortcut.register('Control+Alt+I', () => {
    if (isOpen) closeIsland();
    else {
      manual = true;
      openIsland();
    }
  });
  globalShortcut.register('Control+Alt+Q', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
