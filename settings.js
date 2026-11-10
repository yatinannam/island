// User settings, stored as JSON in %APPDATA%\island\settings.json.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  glass: true,          // glass background (false = solid)
  transparency: 35,     // 0..100, how see-through the glass is
  songColor: 55,        // 0..100, how much of the artwork's color tints the island (0 = off)
  openDelay: 150,       // ms the cursor rests on the top edge before opening
  closeDelay: 120,      // ms the cursor is away before closing
  claudeSound: true,    // chimes for Claude Code finished / needs-you peeks
  trayPromotedGuids: [],  // internal: tray icons (one per exe path) already moved out of the ^ overflow once
};

const LIMITS = {
  transparency: [0, 100],
  songColor: [0, 100],
  openDelay: [0, 600],
  closeDelay: [0, 1000],
};

function clean(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.glass === 'boolean') out.glass = raw.glass;
  if (typeof raw.claudeSound === 'boolean') out.claudeSound = raw.claudeSound;
  if (Array.isArray(raw.trayPromotedGuids)) {
    out.trayPromotedGuids = raw.trayPromotedGuids.filter((g) => typeof g === 'string').slice(-10);
  }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) out[key] = Math.round(Math.min(max, Math.max(min, v)));
  }
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS };
    this.saveTimer = null;
  }

  load() {
    try {
      this.values = clean(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.values = { ...DEFAULTS };
    }
    return this.values;
  }

  update(patch) {
    this.values = clean({ ...this.values, ...patch });
    // Sliders send many updates; write once they settle.
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
    return this.values;
  }

  save() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch (e) {
      console.warn('[island] could not save settings:', e.message);
    }
  }
}

module.exports = { Settings, DEFAULTS };
