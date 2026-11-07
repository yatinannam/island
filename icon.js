// The island icon: a screen outline with the island hanging from its top
// edge. Drawn from signed distance fields so every size is crisp, with one
// representation per DPI scale for the tray.

const { nativeImage } = require('electron');

// Shapes in a 16x16 design grid.
const SCREEN = { cx: 8, cy: 8.25, hx: 6.5, hy: 5.75, r: 2.6, stroke: 1.5 };
const ISLAND = { x0: 4.5, x1: 11.5, top: 2.5, bottom: 6.4, r: 1.7 };

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function inside(px, py) {
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

// BGRA pixels, 4x4 supersampled for anti-aliasing.
function render(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const k = 16 / size;
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          if (inside((x + (sx + 0.5) / n) * k, (y + (sy + 0.5) / n) * k)) hits++;
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r;
      buf[i + 3] = Math.round((hits / (n * n)) * 255);
    }
  }
  return buf;
}

// Tray icon for a dark or light taskbar, at 100/125/150/200% scale.
function trayImage(darkTaskbar) {
  const color = darkTaskbar ? [255, 255, 255] : [26, 26, 26];
  const image = nativeImage.createFromBitmap(render(16, color), { width: 16, height: 16, scaleFactor: 1 });
  for (const [scale, size] of [[1.25, 20], [1.5, 24], [2, 32]]) {
    const rep = nativeImage.createFromBitmap(render(size, color), { width: size, height: size, scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: scale, width: size, height: size, dataURL: rep.toDataURL() });
  }
  return image;
}

module.exports = { trayImage, render };
