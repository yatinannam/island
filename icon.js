// The island icon: a screen outline with the island hanging from its top
// edge. Drawn from signed distance fields so every size is crisp.
// - trayImage(): monochrome tray icon, one representation per DPI scale.
// - renderApp(): full-color app icon (installer, exe), used by scripts/make-icon.js.
// Pure Node except trayImage, so the build script can use it without Electron.

// Shapes in a 16x16 design grid.
const SCREEN = { cx: 8, cy: 8.25, hx: 6.5, hy: 5.75, r: 2.6, stroke: 1.5 };
const ISLAND = { x0: 4.5, x1: 11.5, top: 2.5, bottom: 6.4, r: 1.7 };

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Is (px, py) in the glyph, in 16-unit design space?
function inGlyph(px, py) {
  const s = SCREEN;
  const ring = Math.abs(sdRoundBox(px, py, s.cx, s.cy, s.hx, s.hy, s.r)) - s.stroke / 2;
  if (ring <= 0) return true;
  // Island: rounded only at the bottom; its top merges into the screen edge.
  const i = ISLAND;
  const hx = (i.x1 - i.x0) / 2;
  const top = i.top - i.r;
  const hy = (i.bottom - top) / 2;
  const box = sdRoundBox(px, py, i.x0 + hx, top + hy, hx, hy, i.r);
  return Math.max(box, i.top - py) <= 0;
}

// Monochrome glyph as BGRA pixels, 4x4 supersampled.
function render(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const k = 16 / size;
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          if (inGlyph((x + (sx + 0.5) / n) * k, (y + (sy + 0.5) / n) * k)) hits++;
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r;
      buf[i + 3] = Math.round((hits / (n * n)) * 255);
    }
  }
  return buf;
}

// App icon as RGBA pixels: dark rounded square with a soft vertical
// gradient and a hairline top highlight, white glyph at 62% scale.
function renderApp(size) {
  const buf = Buffer.alloc(size * size * 4);
  const n = 4;
  const radius = size * 0.225;
  const half = size / 2;
  const glyphScale = 16 / (size * 0.62);
  const glyphOrigin = size * 0.19;
  const top = [58, 58, 64], bottom = [16, 16, 18];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, glyphHits = 0, edgeHits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n, py = y + (sy + 0.5) / n;
          const d = sdRoundBox(px, py, half, half, half - 0.5, half - 0.5, radius);
          if (d > 0) continue;
          bgHits++;
          if (d > -Math.max(1, size / 128) && py < half) edgeHits++;
          if (inGlyph((px - glyphOrigin) * glyphScale, (py - glyphOrigin) * glyphScale)) glyphHits++;
        }
      }
      const i = (y * size + x) * 4;
      if (!bgHits) continue;
      const t = y / (size - 1);
      let c = top.map((v, j) => v + (bottom[j] - v) * t);
      const edge = edgeHits / bgHits;
      c = c.map((v) => v + (150 - v) * edge * 0.35);
      const glyph = glyphHits / bgHits;
      c = c.map((v) => v + (255 - v) * glyph);
      buf[i] = Math.round(c[0]); buf[i + 1] = Math.round(c[1]); buf[i + 2] = Math.round(c[2]);
      buf[i + 3] = Math.round((bgHits / (n * n)) * 255);
    }
  }
  return buf;
}

// Tray icon for a dark or light taskbar, at 100/125/150/200% scale.
function trayImage(darkTaskbar) {
  const { nativeImage } = require('electron');
  const color = darkTaskbar ? [255, 255, 255] : [26, 26, 26];
  const image = nativeImage.createFromBitmap(render(16, color), { width: 16, height: 16, scaleFactor: 1 });
  for (const [scale, size] of [[1.25, 20], [1.5, 24], [2, 32]]) {
    const rep = nativeImage.createFromBitmap(render(size, color), { width: size, height: size, scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: scale, width: size, height: size, dataURL: rep.toDataURL() });
  }
  return image;
}

module.exports = { trayImage, render, renderApp };
