// File shelf: a temporary place to drop files on the island and drag them
// out again later. Items are references to the original files (nothing is
// copied), except drops that have no file on disk (e.g. an image dragged
// out of a browser), which are written to <userData>/shelf-files.
// The list survives restarts in <userData>/shelf.json.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 50;
const MAX_DATA_BYTES = 200 * 1024 * 1024;

class Shelf extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'shelf.json');
    this.tempDir = path.join(dir, 'shelf-files');
    this.items = [];
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        this.items = raw.filter((i) => i && typeof i.path === 'string' && typeof i.id === 'string');
      }
    } catch {
      this.items = [];
    }
    this.prune();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch (e) {
      console.warn('[island] could not save shelf:', e.message);
    }
  }

  changed() {
    this.save();
    this.emit('change', this.items);
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  add(paths) {
    let added = 0;
    for (const p of paths) {
      if (typeof p !== 'string' || !p || !path.isAbsolute(p)) continue;
      if (this.items.some((i) => i.path.toLowerCase() === p.toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(p); } catch { continue; }
      this.items.push({
        id: crypto.randomUUID(),
        path: p,
        name: path.basename(p) || p,
        dir: stat.isDirectory(),
        temp: false,
        addedAt: Date.now(),
      });
      added++;
    }
    if (added) this.trim();
    if (added) this.changed();
    return added;
  }

  // A dropped file with no path on disk: keep its bytes in our own folder.
  addData(name, bytes) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_DATA_BYTES) return false;
    const safe = String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const id = crypto.randomUUID();
    const dir = path.join(this.tempDir, id);
    const p = path.join(dir, safe);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, Buffer.from(bytes));
    } catch (e) {
      console.warn('[island] could not store dropped data:', e.message);
      return false;
    }
    this.items.push({ id, path: p, name: safe, dir: false, temp: true, addedAt: Date.now() });
    this.trim();
    this.changed();
    return true;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.dispose(this.items[i]);
    this.items.splice(i, 1);
    this.changed();
  }

  clear() {
    if (!this.items.length) return;
    this.items.forEach((i) => this.dispose(i));
    this.items = [];
    this.changed();
  }

  // Drop items whose file is gone, e.g. moved out of the shelf into a folder.
  prune() {
    const before = this.items.length;
    this.items = this.items.filter((i) => fs.existsSync(i.path));
    if (this.items.length !== before) this.changed();
  }

  // Oldest go first when the shelf is full.
  trim() {
    while (this.items.length > MAX_ITEMS) this.dispose(this.items.shift());
  }

  // Only ever deletes files we created ourselves, never the user's originals.
  dispose(item) {
    if (!item.temp) return;
    const dir = path.dirname(item.path);
    if (path.dirname(dir) !== this.tempDir) return;
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { Shelf };
