// Renders the README images in docs/images from the real island.html and
// preload.js: glass mode, with a generated wallpaper handed to the glass as
// the "screen capture", so the blur and tint are the real rendering code.
// Rendered offscreen at 2x; nothing shows on screen.
//
//   electron scripts/readme-images.js <scene> <out.png>
//   scenes: hero, music, shelf, claude, peek-a, peek-b (the two halves of
//   peeks.png), and `join <a.png> <b.png> <out.png>` to put the halves together.
//
// One page load per process (a second load in the same process fails), so
// each scene is its own run. Images get rounded corners so they sit as cards
// on light and dark GitHub themes.

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const Z = 2;
const RADIUS = 24; // px at 2x
// CSS size of each scene; peek halves share one wallpaper 760 wide (offset ox)
const SCENES = {
  hero: { w: 760, h: 224 },  // at most 768 wide: offscreen windows are clamped to the screen
  music: { w: 720, h: 170 },
  shelf: { w: 720, h: 170 },
  claude: { w: 720, h: 170 },
  'peek-a': { w: 380, h: 72, full: 760, ox: 0 },
  'peek-b': { w: 380, h: 72, full: 760, ox: 380 },
};

// Rounded corners: alpha 0 outside a quarter circle at each corner (anti-aliased).
function roundCorners(img, r) {
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap(); // BGRA
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x < r ? r - x - 0.5 : x >= w - r ? x - (w - r) + 0.5 : 0;
      const dy = y < r ? r - y - 0.5 : y >= h - r ? y - (h - r) + 0.5 : 0;
      if (!dx || !dy) continue;
      const cover = Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
      const i = (y * w + x) * 4;
      px[i + 3] = Math.round(px[i + 3] * cover);
    }
  }
  return nativeImage.createFromBitmap(px, { width: w, height: h });
}

function crop(img, w, h) {
  const s = img.getSize();
  return s.width === w && s.height === h ? img : img.crop({ x: 0, y: 0, width: Math.min(w, s.width), height: Math.min(h, s.height) });
}

if (process.argv.includes('join')) {
  const [a, b, out] = process.argv.slice(-3);
  app.whenReady().then(() => {
    const A = nativeImage.createFromPath(a), B = nativeImage.createFromPath(b);
    const { width: w, height: h } = A.getSize();
    const pa = A.toBitmap(), pb = B.toBitmap();
    const px = Buffer.alloc(w * 2 * h * 4);
    for (let y = 0; y < h; y++) {
      pa.copy(px, y * w * 2 * 4, y * w * 4, (y + 1) * w * 4);
      pb.copy(px, (y * w * 2 + w) * 4, y * w * 4, (y + 1) * w * 4);
    }
    const img = roundCorners(nativeImage.createFromBitmap(px, { width: w * 2, height: h }), RADIUS);
    fs.writeFileSync(out, img.toPNG());
    console.log('joined', `${w * 2}x${h}`);
    app.exit(0);
  });
} else {
  const [scene, out] = process.argv.slice(-2);
  const S = SCENES[scene];
  if (!S) { console.error('unknown scene', scene); process.exit(1); }
  const { w: W, h: H } = S;
  const FW = S.full || W, OX = S.ox || 0;
  const peek = scene.startsWith('peek');
  const now = Date.now();
  const hero = scene === 'hero';
  const media = {
    app: 'x', title: hero ? 'Paper Lanterns' : 'Night Ferry', artist: hero ? 'Ines Kade' : 'Marisol Tern', album: '',
    status: 'playing', position: hero ? 71000 : 108000, duration: hero ? 204000 : 241000, updatedAt: now,
    canToggle: true, canNext: true, canPrev: true, canSeek: true,
  };
  const sessions = [
    { id: 'a', label: 'island', state: 'needs', needsKind: 'permission', tool: 'Bash', turnStart: now - 50000, durationMs: 0, endedAt: 0, lastEventAt: now - 3000, subagents: 0, canJump: true },
    { id: 'b', label: 'ZeroEmit', state: 'working', needsKind: null, tool: '', turnStart: now - 91000, durationMs: 0, endedAt: 0, lastEventAt: now - 2000, subagents: 2, canJump: true },
    { id: 'c', label: 'api', state: 'finished', needsKind: null, tool: '', turnStart: 0, durationMs: 134000, endedAt: now - 180000, lastEventAt: 0, subagents: 0, canJump: true },
  ];
  // Claude Code is off by default: its page and dot only in its own scenes.
  const claudeOn = scene === 'claude' || peek;
  ipcMain.handle('snapshot', async () => ({
    config: { glass: true, dark: true, transparency: 35, songColor: hero ? 40 : 22 },
    media, art: null, shelf: [], activity: { connected: claudeOn ? 'on' : 'off', sessions: [] },
  }));
  ipcMain.on('debug', () => {});
  ipcMain.on('shape-size', () => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const PAGE_SETUP = `(() => {
    const W = ${W}, H = ${H}, FW = ${FW}, OX = ${OX};
    // Dark silk wallpaper: soft folds of light on near-black, FW wide
    const wp = document.createElement('canvas');
    wp.width = FW * 2; wp.height = H * 2;
    const x = wp.getContext('2d');
    x.scale(2, 2);
    const base = x.createLinearGradient(0, 0, FW, H);
    base.addColorStop(0, '#18181b'); base.addColorStop(1, '#060607');
    x.fillStyle = base; x.fillRect(0, 0, FW, H);
    const fold = (p, color, width, blur) => {
      x.save(); x.filter = 'blur(' + blur + 'px)'; x.strokeStyle = color; x.lineWidth = width; x.lineCap = 'round';
      x.beginPath(); x.moveTo(p[0] * FW, p[1] * H);
      x.bezierCurveTo(p[2] * FW, p[3] * H, p[4] * FW, p[5] * H, p[6] * FW, p[7] * H);
      x.stroke(); x.restore();
    };
    fold([-0.1, 0.62, 0.25, 0.30, 0.55, 0.95, 1.1, 0.45], 'rgba(255,255,255,0.16)', H * 0.22, 26);
    fold([-0.1, 0.20, 0.30, 0.05, 0.60, 0.55, 1.1, 0.10], 'rgba(255,255,255,0.10)', H * 0.16, 30);
    fold([0.2, 1.1, 0.45, 0.70, 0.75, 0.95, 1.1, 0.70], 'rgba(255,255,255,0.09)', H * 0.25, 34);
    fold([-0.1, 0.62, 0.25, 0.30, 0.55, 0.95, 1.1, 0.45], 'rgba(255,255,255,0.10)', H * 0.03, 6);
    fold([0.6, -0.1, 0.80, 0.30, 0.90, 0.20, 1.1, 0.55], 'rgba(255,255,255,0.08)', H * 0.12, 22);
    // This window shows the slice of the wallpaper from OX
    const slice = document.createElement('canvas');
    slice.width = W * 2; slice.height = H * 2;
    slice.getContext('2d').drawImage(wp, OX * 2, 0, W * 2, H * 2, 0, 0, W * 2, H * 2);
    document.documentElement.style.background = 'url(' + slice.toDataURL('image/png') + ') 0 0 / 100% 100% no-repeat';
    document.body.style.background = 'transparent';
    // The glass captures "the screen": hand it the same slice.
    const live = document.createElement('canvas');
    live.width = W; live.height = H;
    const lx = live.getContext('2d');
    let tick = 0;
    setInterval(() => { lx.drawImage(slice, 0, 0, W, H); lx.fillStyle = 'rgba(0,0,0,' + (0.001 * (tick++ % 2)) + ')'; lx.fillRect(0, 0, 1, 1); }, 60);
    lx.drawImage(slice, 0, 0, W, H);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (c && c.audio) throw new Error('no audio in screenshots'); // the equalizer keeps its CSS animation
      return live.captureStream(15);
    };
    // Album art: dusk over the water (Night Ferry) or warm lanterns (Paper Lanterns)
    const a = document.createElement('canvas');
    a.width = a.height = 300;
    const ax = a.getContext('2d');
    if (${hero}) {
      const g = ax.createLinearGradient(0, 0, 300, 300);
      g.addColorStop(0, '#f7b267'); g.addColorStop(0.55, '#e8655a'); g.addColorStop(1, '#8c2f5c');
      ax.fillStyle = g; ax.fillRect(0, 0, 300, 300);
      [[92, 118, 34], [196, 92, 26], [168, 196, 40], [70, 222, 20]].forEach(([cx, cy, r]) => {
        const l = ax.createRadialGradient(cx, cy, 2, cx, cy, r);
        l.addColorStop(0, 'rgba(255,248,220,1)'); l.addColorStop(0.6, 'rgba(255,214,140,0.9)'); l.addColorStop(1, 'rgba(255,190,110,0)');
        ax.fillStyle = l; ax.beginPath(); ax.arc(cx, cy, r, 0, Math.PI * 2); ax.fill();
      });
    } else {
      const sky = ax.createLinearGradient(0, 0, 0, 170);
      sky.addColorStop(0, '#6f68d2'); sky.addColorStop(1, '#b3abf2');
      ax.fillStyle = sky; ax.fillRect(0, 0, 300, 170);
      ax.fillStyle = '#ffffff'; ax.beginPath(); ax.arc(150, 170, 52, Math.PI, 0); ax.fill();
      const sea = ax.createLinearGradient(0, 170, 0, 300);
      sea.addColorStop(0, '#2a3466'); sea.addColorStop(1, '#141a36');
      ax.fillStyle = sea; ax.fillRect(0, 170, 300, 130);
      ax.strokeStyle = 'rgba(235,235,255,0.85)'; ax.lineCap = 'round';
      [[190, 120, 6], [214, 92, 5], [236, 64, 4], [256, 38, 3]].forEach(([y, w, lw]) => { ax.lineWidth = lw; ax.beginPath(); ax.moveTo(150 - w / 2, y); ax.lineTo(150 + w / 2, y); ax.stroke(); });
    }
    window.__art = a.toDataURL('image/png');
    // Shelf thumbnails
    const thumb = (draw) => { const t = document.createElement('canvas'); t.width = t.height = 112; draw(t.getContext('2d')); return t.toDataURL('image/png'); };
    const photo = (c1, c2, c3) => thumb((t) => {
      t.clearRect(0, 0, 112, 112);
      t.save(); t.beginPath(); t.roundRect(8, 18, 96, 76, 8); t.clip();
      const g = t.createLinearGradient(0, 18, 0, 94); g.addColorStop(0, c1); g.addColorStop(0.6, c2); g.addColorStop(1, c3);
      t.fillStyle = g; t.fillRect(8, 18, 96, 76);
      t.fillStyle = 'rgba(0,0,0,0.35)'; t.beginPath(); t.moveTo(8, 94); t.lineTo(40, 60); t.lineTo(62, 80); t.lineTo(82, 64); t.lineTo(104, 94); t.fill();
      t.restore();
    });
    window.__shelf = [
      { id: '1', name: 'Lisbon.jpg', dir: false, thumb: photo('#f7b267', '#f4845f', '#7b2d26') },
      { id: '2', name: 'Moodboard.png', dir: false, thumb: photo('#a18cd1', '#fbc2eb', '#5b4b8a') },
      { id: '3', name: 'Brief.pdf', dir: false, thumb: null },
      { id: '4', name: 'Screenshot.png', dir: false, thumb: photo('#89f7fe', '#66a6ff', '#23395b') },
      { id: '5', name: 'notes.md', dir: false, thumb: null },
    ];
    return 1;
  })()`;

  app.whenReady().then(async () => {
    const w = new BrowserWindow({
      width: W * Z, height: H * Z, show: false, enableLargerThanScreen: true, frame: false, backgroundColor: '#000000',
      webPreferences: { offscreen: true, zoomFactor: Z, preload: path.join(ROOT, 'preload.js') },
    });
    await w.loadFile(path.join(ROOT, 'island.html'));
    w.webContents.setZoomFactor(Z);
    const js = (s) => w.webContents.executeJavaScript(s);
    const send = (c, v) => w.webContents.send(c, v);
    await js(PAGE_SETUP);
    await sleep(300);
    await js('setArt(window.__art); ' + (scene === 'shelf' ? 'renderShelf(window.__shelf);' : '') + ' 1');
    if (claudeOn) send('activity', { connected: 'on', sessions });
    send('capture', { sourceId: 'wallpaper', display: { x: 0, y: 0, width: W, height: H }, window: { x: 0, y: 0, width: W, height: H } });
    await sleep(300);
    const pageFor = { hero: 0, music: 0, shelf: 1, claude: 2 };
    if (scene in pageFor) {
      send('open-page', pageFor[scene]);
      send('island-state', 'open');
    } else {
      send('peek', scene === 'peek-a'
        ? { key: 1, session: 'c', kind: 'finished', label: 'api', tool: '', durationMs: 134000, chime: false }
        : { key: 2, session: 'a', kind: 'permission', label: 'island', tool: 'Bash', durationMs: 0, chime: false });
    }
    await sleep(2200);
    await js(`document.querySelectorAll('.eq i').forEach((b, i) => { b.style.animation = 'none'; b.style.transform = 'scaleY(' + [0.55, 0.95, 0.4, 0.75][i] + ')'; }); 1`);
    await sleep(150);
    let img = crop(await w.webContents.capturePage(), W * Z, H * Z);
    if (!peek) img = roundCorners(img, RADIUS); // halves get their corners when joined
    fs.writeFileSync(out, img.toPNG());
    console.log(scene, `${img.getSize().width}x${img.getSize().height}`);
    app.exit(0);
  });
}
