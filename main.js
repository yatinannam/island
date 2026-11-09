// island: hover-reveal top island for Windows.
// Run:     bun install && bun run start
// Flags:   --open   start with the island pinned open (for testing)
//          --solid  start with glass off
// Env:     ISLAND_DEBUG=1 log open/close; ISLAND_SHOT=file.png save a capture of the page once open
// Hotkeys: Ctrl+Alt+I pin/unpin the island, Ctrl+Alt+Q quit.

const {
  app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu,
  desktopCapturer, nativeTheme, systemPreferences, nativeImage, shell,
} = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MediaHelper } = require('./media/helper');
const { Settings } = require('./settings');
const { Shelf } = require('./shelf');
const { trayImage } = require('./icon');
const { isPromoted, setPromoted } = require('./tray-visibility');

// Expanded island shape, in DIP. Must match --w / --h / --shelf-h in island.html.
const SHAPE_W = 380;
const SHAPE_H = 140;        // music only
const SHELF_H = 76;         // extra height when the file shelf shows
// Window is bigger than the shape so the spring overshoot, the top "ears"
// and the shadow are not clipped. Sized for the tallest island once, since
// the window is never resized or moved (see closeIsland).
const PAD_X = 48;
const PAD_B = 48;
const WIN_W = SHAPE_W + PAD_X * 2;
const WIN_H = SHAPE_H + SHELF_H + PAD_B;
let shapeH = SHAPE_H;       // current island height, reported by the renderer

const HOT_W = 240;          // hot zone width, centered on the top edge
const HOT_H = 3;            // px from the top edge that triggers
const LEAVE_PAD = 10;       // tolerance around the shape before leaving counts
const TICK_MS = 16;
// Open delay (dwell on the hot zone) and close delay come from settings.

// Settings flyout: as wide as Windows' Quick Settings, and placed like it.
const SETTINGS_W = 360;
const SETTINGS_MARGIN = 12;     // gap to the screen edge and the taskbar
const SETTINGS_FADE_OUT_MS = 120;

let win = null;
let settingsWin = null;
let settingsHiddenAt = 0;
let settingsShownAt = 0;
let settingsH = 600;            // content height the flyout page asked for
let settingsHideTimer = null;
let tray = null;
let ready = false;
let isOpen = false;
let pinned = false;
let previewing = false;     // island held open while the settings flyout is in use
let leaveSince = 0;
let hotSince = 0;
let current = null; // display the island is on

const settings = new Settings(app.getPath('userData'));
// Glass = blurred capture of the screen behind the island. It needs the
// window excluded from capture, which also hides it from screenshots.
let forceSolid = process.argv.includes('--solid');
let theme = { dark: true, transparency: true };
const sourceIds = new Map(); // display id -> desktopCapturer source id

// Packaged: smtc.exe ships in resources. Development: compiled on first run.
const media = new MediaHelper({ exe: app.isPackaged ? path.join(process.resourcesPath, 'smtc.exe') : null });
const shelf = new Shelf(app.getPath('userData'));

const DEBUG = process.env.ISLAND_DEBUG === '1';
const log = (...a) => { if (DEBUG) console.log('[island]', ...a); };

if (!app.requestSingleInstanceLock() || process.argv.includes('--quit')) {
  // Either another copy is running (it gets our argv), or we were only
  // asked to quit and nothing was running.
  app.quit();
}
// `electron . --quit` closes the running copy cleanly; launching again
// without it opens the settings flyout.
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--quit')) app.quit();
  else if (settingsWin) showSettings();
});

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
    height: shapeH,
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
  const s = settings.values;
  return {
    glass: s.glass && !forceSolid && theme.transparency,
    dark: theme.dark,
    transparency: s.transparency,
    songColor: s.songColor,
  };
}

function applyConfig() {
  if (!win || win.isDestroyed()) return;
  win.setContentProtection(config().glass);
  send('config', config());
  if (isOpen && config().glass) sendCapture(current); // switched to glass while open
  sendSettings();
}

async function refreshTheme() {
  const next = await readTheme();
  if (next.dark !== theme.dark || next.transparency !== theme.transparency) {
    const iconChanged = next.dark !== theme.dark;
    theme = next;
    if (iconChanged && tray) tray.setImage(trayImage(theme.dark));
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
      // Must stay on (the default). With it off, Electron never tells Chromium
      // the page was hidden, so when Windows hides the window (display off in
      // standby, lock screen, covered, hide()) Chromium hides its input child
      // window (Chrome_RenderWidgetHostHWND) and never shows it again. Clicks
      // then hit the top-level window, which eats the button-down
      // (MA_NOACTIVATEANDEAT, the window can't activate): dead clicks after sleep.
      backgroundThrottling: true,
    },
  });
  // Electron creates this frameless transparent window ~5 DIP too wide
  // (481 for 476), which put the island 3 physical px right of center.
  // Setting the bounds again gives the requested size.
  win.setBounds(windowBounds(screen.getPrimaryDisplay()));
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(config().glass);
  // Transparent parts never block clicks. The renderer turns mouse input back
  // on while the cursor is over the shape itself.
  win.setIgnoreMouseEvents(true);
  win.loadFile('island.html');
  win.webContents.once('did-finish-load', () => {
    ready = true;
    if (process.env.ISLAND_CSS) win.webContents.insertCSS(process.env.ISLAND_CSS); // dev: style overrides for screenshots
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
  current = d;
  // Only move when the display changed: see closeIsland for why the window
  // otherwise stays put.
  const b = windowBounds(d);
  const now = win.getBounds();
  if (b.x !== now.x || b.y !== now.y) win.setBounds(b);
  win.setAlwaysOnTop(true, 'screen-saver'); // re-assert: other topmost windows may sit above us
  sendCapture(d);
  if (!win.isVisible()) win.showInactive(); // first open only
  send('island-state', 'open');
  refreshTheme();
  shelf.prune(); // files moved elsewhere since last time drop off
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
  previewing = false;
  held = false;
  send('island-state', 'closed');
  // The window stays where it is, fully transparent and click-through.
  // Hiding it, or moving it off-screen, after a click made Electron stop
  // delivering clicks to it on later opens: the controls went dead.
  setMouse(false);
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

// The window is click-through except while the cursor is over the island.
// Decided here from the polled cursor: Electron's { forward: true } mouse
// forwarding never reached the page on Windows, so clicks fell through.
let mouseOn = false;
function setMouse(on) {
  if (on === mouseOn || !win || win.isDestroyed()) return;
  mouseOn = on;
  log('mouse', on ? 'on' : 'off');
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true);
}

function overShape(p, d) {
  const r = shapeRect(d);
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

// True while the progress bar is being dragged: keep the island open and
// taking the mouse even if the drag wanders outside it.
let held = false;

function tick() {
  const p = screen.getCursorScreenPoint();
  setMouse(isOpen && (held || overShape(p, current)));
  if (!isOpen) {
    const d = displayAt(p);
    if (!inHotZone(p, d)) {
      hotSince = 0;
    } else if (!hotSince) {
      hotSince = Date.now();
    } else if (Date.now() - hotSince >= settings.values.openDelay) {
      hotSince = 0;
      log('open: cursor', p, 'display', d.bounds, 'scale', d.scaleFactor);
      openIsland(d);
    }
    return;
  }
  if (pinned) return;
  if (held || inShape(p, current)) {
    leaveSince = 0;
  } else if (!leaveSince) {
    leaveSince = Date.now();
  } else if (Date.now() - leaveSince > settings.values.closeDelay) {
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

// ---- settings flyout --------------------------------------------------------

function loginItem() {
  // In development the app runs as electron.exe <project dir>.
  return { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
}

function settingsPayload() {
  let accent = '#0078d4';
  try { accent = '#' + systemPreferences.getAccentColor().slice(0, 6); } catch {}
  return {
    values: settings.values,
    startWithWindows: app.getLoginItemSettings(loginItem()).openAtLogin,
    trayShown,
    windowsTransparency: theme.transparency,
    forceSolid,
    pinned: isOpen && pinned && !previewing,
    accent,
    shelfCount: shelf.items.length,
    version: app.getVersion(),
  };
}

function sendSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settingsPayload());
}

function createSettingsWindow() {
  settingsWin = new BrowserWindow({
    width: SETTINGS_W,
    height: settingsH,
    // Sizes are the page's size. Sizing the outer frame made the flyout grow
    // a few px on every open at 125% scaling.
    useContentSize: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundMaterial: 'acrylic',   // same material as Windows' own tray flyouts
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js') },
  });
  settingsWin.loadFile('settings.html');
  // Closing the tray overflow popup can blur us right after showing; ignore that.
  settingsWin.on('blur', () => { if (Date.now() - settingsShownAt > 400) hideSettings(); });
}

// Like Windows' own tray flyouts (Quick Settings, notifications): in the
// corner of the work area on the tray's side, 12 px from the screen edge and
// the taskbar. Taller than the work area: the page scrolls.
function placeSettings() {
  if (!tray || !settingsWin || settingsWin.isDestroyed()) return;
  const icon = tray.getBounds();
  const center = { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 };
  const work = screen.getDisplayNearestPoint(center).workArea;
  const m = SETTINGS_MARGIN;
  const w = SETTINGS_W;
  const h = Math.round(Math.min(settingsH, work.height - m * 2));
  const right = center.x >= work.x + work.width / 2;
  const below = center.y < work.y + work.height / 2; // taskbar at the top
  const b = {
    x: Math.round(right ? work.x + work.width - w - m : work.x + m),
    y: Math.round(below ? work.y + m : work.y + work.height - h - m),
    width: w,
    height: h,
  };
  const now = settingsWin.getContentBounds();
  if (b.x !== now.x || b.y !== now.y || b.width !== now.width || b.height !== now.height) {
    settingsWin.setContentBounds(b);
  }
}

// Whether the tray icon is on the taskbar; the user can also change it in
// Windows settings, so re-read it each time the flyout opens.
let trayShown = false;
async function refreshTrayShown() {
  trayShown = await isPromoted(TRAY_GUID);
  sendSettings();
}

function showSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) createSettingsWindow();
  clearTimeout(settingsHideTimer); // shown again while fading out
  settingsHideTimer = null;
  refreshTrayShown();
  sendSettings();
  placeSettings();
  settingsShownAt = Date.now();
  settingsWin.show();
  settingsWin.focus();
  settingsWin.webContents.send('settings-shown');
  log('settings shown at', settingsWin.getBounds(), 'tray', tray.getBounds(), 'focused', settingsWin.isFocused());
}

// The page fades its content out before the window hides. Windows shows a
// window's last frame when it comes back, so the next open starts from the
// empty panel and fades the content in, like Windows' own flyouts.
function hideSettings() {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.isVisible() || settingsHideTimer) return;
  log('settings hidden');
  settingsHiddenAt = Date.now();
  settingsWin.webContents.send('settings-hiding');
  settingsHideTimer = setTimeout(() => {
    settingsHideTimer = null;
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
  }, SETTINGS_FADE_OUT_MS);
  if (previewing) closeIsland();
}

function toggleSettings() {
  // Clicking the tray icon blurs the flyout first; don't reopen it right away.
  if (Date.now() - settingsHiddenAt < 300) return;
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) hideSettings();
  else showSettings();
}

// Hold the island open on the primary display so look changes show live.
function preview() {
  if (isOpen) return;
  pinned = true;
  openIsland(screen.getPrimaryDisplay());
  previewing = true;
}

// ---- tray ------------------------------------------------------------------

// A stable GUID lets Windows recognise the icon across restarts, so its
// "always show" choice sticks. While unsigned, Windows ties a GUID to one
// exe path, so derive it from the path: the dev copy, a test build and the
// installed app each get their own, and the same one every run.
function guidForPath(p) {
  const h = require('crypto').createHash('sha1').update(`island-tray:${p.toLowerCase()}`).digest('hex');
  const variant = (8 | (parseInt(h[16], 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const TRAY_GUID = guidForPath(process.execPath);

function trayTooltip() {
  const m = media.state;
  if (!m || m.none || !m.title) return 'island';
  const line = m.artist ? `${m.title} · ${m.artist}` : m.title;
  return `island\n${line}`.slice(0, 127); // Windows caps tooltips at 127 chars
}

function createTray() {
  tray = new Tray(trayImage(theme.dark), TRAY_GUID);
  tray.setToolTip(trayTooltip());
  // Left click: settings flyout. Right click: menu.
  tray.on('click', toggleSettings);
  const menu = Menu.buildFromTemplate([
    { label: 'Settings', click: showSettings },
    { label: 'Pin island open (Ctrl+Alt+I)', click: togglePinned },
    { type: 'separator' },
    { label: 'Quit (Ctrl+Alt+Q)', click: () => app.quit() },
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
  // Show the icon on the taskbar instead of the ^ overflow, once. After
  // that it's the user's call, from our settings or Windows' own.
  if (!settings.values.trayPromotedGuids.includes(TRAY_GUID)) {
    setPromoted(TRAY_GUID, true).then((ok) => {
      log('tray promoted:', ok, TRAY_GUID);
      if (ok) {
        settings.update({ trayPromotedGuids: [...settings.values.trayPromotedGuids, TRAY_GUID].slice(-10) });
        sendSettings();
      }
    });
  }
}

function registerShortcut(accel, fn) {
  if (!globalShortcut.register(accel, fn)) {
    console.warn(`[island] could not register ${accel}, another app is using it`);
  }
}

// ---- IPC -------------------------------------------------------------------

ipcMain.on('debug', (_e, msg) => log('renderer:', String(msg)));

ipcMain.on('hold', (_e, on) => {
  held = !!on && isOpen;
  log('hold', held);
});

ipcMain.on('media-cmd', (_e, cmd) => {
  log('media-cmd', cmd);
  media.command(String(cmd));
});

ipcMain.handle('snapshot', async () => ({
  config: config(), media: media.state, art: media.art, shelf: await shelfPayload(),
}));

// ---- file shelf --------------------------------------------------------------

const thumbs = new Map(); // path -> data URL

async function thumbFor(item) {
  if (thumbs.has(item.path)) return thumbs.get(item.path);
  let img = null;
  try {
    // Windows shell thumbnail: real previews for images, videos, PDFs; icons otherwise.
    img = await nativeImage.createThumbnailFromPath(item.path, { width: 112, height: 112 });
  } catch {}
  if (!img || img.isEmpty()) {
    try { img = await app.getFileIcon(item.path, { size: 'large' }); } catch {}
  }
  const url = img && !img.isEmpty() ? img.toDataURL() : null;
  thumbs.set(item.path, url);
  return url;
}

async function shelfPayload() {
  return Promise.all(shelf.items.map(async (i) => ({
    id: i.id, name: i.name, dir: i.dir, thumb: await thumbFor(i),
  })));
}

async function sendShelf() {
  send('shelf', await shelfPayload());
}

shelf.on('change', () => {
  for (const p of thumbs.keys()) if (!shelf.items.some((i) => i.path === p)) thumbs.delete(p);
  sendShelf();
  sendSettings(); // file count in the flyout
});

ipcMain.on('shape-size', (_e, h) => {
  const v = Number(h);
  if (Number.isFinite(v)) shapeH = Math.min(SHAPE_H + SHELF_H, Math.max(SHAPE_H, v));
});

ipcMain.on('shelf-add', (_e, paths) => {
  if (Array.isArray(paths)) log('shelf added', shelf.add(paths));
});

ipcMain.on('shelf-add-data', (_e, file) => {
  if (file && file.bytes) log('shelf data', file.name, shelf.addData(file.name, file.bytes));
});

ipcMain.on('shelf-remove', (_e, id) => shelf.remove(String(id)));
ipcMain.on('shelf-clear', () => shelf.clear());

ipcMain.on('shelf-open', (_e, id) => {
  const item = shelf.get(String(id));
  if (item) shell.openPath(item.path).then((err) => log('shelf open', item.name, err || 'ok'));
});

// Drag files out of the shelf into any app or folder. Windows decides copy
// or move like Explorer does; moved files drop off the shelf afterwards.
ipcMain.on('shelf-drag', async (e, ids) => {
  const items = (Array.isArray(ids) ? ids : []).map((id) => shelf.get(String(id))).filter(Boolean)
    .filter((i) => fs.existsSync(i.path));
  if (!items.length) return;
  let icon = nativeImage.createFromDataURL((await thumbFor(items[0])) || '');
  if (icon.isEmpty()) icon = await app.getFileIcon(items[0].path, { size: 'normal' });
  else icon = icon.resize({ width: 64 });
  log('shelf drag', items.map((i) => i.name));
  e.sender.startDrag({ file: items[0].path, files: items.map((i) => i.path), icon });
  setTimeout(() => shelf.prune(), 500);
});

ipcMain.handle('settings-get', () => settingsPayload());

ipcMain.on('settings-set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const looks = ['glass', 'transparency', 'songColor'].some((k) => k in patch);
  settings.update(patch);
  if (looks) preview();
  applyConfig();
});

ipcMain.on('settings-action', (_e, action) => {
  if (action === 'quit') app.quit();
  else if (action === 'hide') hideSettings();
  else if (action === 'pin') {
    if (previewing) { previewing = false; pinned = true; } // keep the preview open for good
    else togglePinned();
    sendSettings();
  } else if (action === 'start-with-windows-on' || action === 'start-with-windows-off') {
    app.setLoginItemSettings({ ...loginItem(), openAtLogin: action.endsWith('-on') });
    sendSettings();
  } else if (action === 'tray-shown-on' || action === 'tray-shown-off') {
    setPromoted(TRAY_GUID, action.endsWith('-on')).then(refreshTrayShown);
  } else if (action === 'shelf-clear') {
    shelf.clear();
  }
});

// The page reports its natural height (not the window's), so this settles
// instead of feeding back. Placed while hidden too, so it opens already sized.
ipcMain.on('settings-size', (_e, h) => {
  const v = Math.round(Number(h));
  if (!Number.isFinite(v) || v === settingsH) return;
  settingsH = Math.min(Math.max(v, 200), 1200);
  placeSettings();
});

media.on('state', (s) => {
  log('media', s.none ? 'none' : `${s.status} "${s.title}"`);
  send('media-state', s);
  if (tray) tray.setToolTip(trayTooltip());
});
media.on('art', (a) => send('media-art', a));
media.on('error', (e) => log('media:', e.message));

// ---- app -------------------------------------------------------------------

app.whenReady().then(async () => {
  // `--start-with-windows on|off`: set the login item for this exe (scripts, installs).
  const sww = process.argv.indexOf('--start-with-windows');
  if (sww >= 0 && ['on', 'off'].includes(process.argv[sww + 1])) {
    app.setLoginItemSettings({ ...loginItem(), openAtLogin: process.argv[sww + 1] === 'on' });
  }
  settings.load();
  shelf.load();
  theme = await readTheme();
  createWindow();
  createTray();
  createSettingsWindow();
  if (process.argv.includes('--settings')) settingsWin.webContents.once('did-finish-load', () => setTimeout(showSettings, 300));
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
  settings.save();
});
