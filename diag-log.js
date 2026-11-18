// A small local timing log for problems that only show up in daily use, like
// the island being slow to open after sleep: %APPDATA%\island\island.log,
// moved to island.old.log at 512 KB. Only timings and states go in, never
// song titles, file names or Claude Code text. Nothing leaves the machine.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const FLUSH_MS = 2000;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

class DiagLog {
  constructor(dir) {
    this.file = path.join(dir, 'island.log');
    this.old = path.join(dir, 'island.old.log');
    this.lines = [];
    this.timer = null;
    try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
  }

  write(...parts) {
    this.lines.push(`${stamp()} ${parts.filter((p) => p !== '' && p != null).join(' ')}\n`);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.lines.length) return;
    const text = this.lines.join('');
    this.lines = [];
    try {
      if (this.size + text.length > MAX_BYTES) {
        fs.renameSync(this.file, this.old);
        this.size = 0;
      }
    } catch {}
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text);
      this.size += Buffer.byteLength(text);
    } catch {}
  }
}

module.exports = { DiagLog };
