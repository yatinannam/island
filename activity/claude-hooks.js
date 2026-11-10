// "Connect Claude Code": adds island's hooks to ~/.claude/settings.json, and
// removes exactly those again. Everything else in the file (other hooks,
// plugins, settings) is kept. The file is backed up before every change.
//
// Each hook runs islandctl.exe directly (exec form, no shell) in the
// background (async), so Claude Code never waits for it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = path.join(os.homedir(), '.claude', 'settings.island-backup.json');

const EVENTS = [
  'UserPromptSubmit',     // working
  'Stop', 'StopFailure',  // finished / ended on an error
  'Notification',         // needs you: permission prompt, question
  'PermissionRequest',    // which tool a permission prompt is for
  'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', // Claude moved on: clears needs-you
  'SubagentStop',         // counted on the session
  'SessionEnd',           // session closed
];

const isOurs = (h) => !!h && h.type === 'command' && typeof h.command === 'string'
  && /islandctl\.exe$/i.test(h.command) && Array.isArray(h.args) && h.args[0] === 'hook';

function read() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings.json is not a JSON object');
  return data;
}

function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BACKUP);
  const tmp = `${FILE}.island-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

// Our hook entries removed; empty groups and events dropped. Returns whether anything changed.
function strip(data) {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isOurs(h));
      if (rest.length !== g.hooks.length) changed = true;
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (kept.length) hooks[event] = kept;
    else { delete hooks[event]; changed = true; }
  }
  if (!Object.keys(hooks).length) delete data.hooks;
  return changed;
}

// 'on' (all hooks, pointing at exe), 'other' (ours, but another islandctl.exe,
// e.g. a dev copy), 'partial', or 'off'.
function status(exe) {
  let data;
  try { data = read(); } catch { return 'off'; }
  const found = new Map();
  for (const [event, groups] of Object.entries(data.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) if (isOurs(h)) found.set(event, h.command);
    }
  }
  if (!found.size) return 'off';
  if (EVENTS.some((e) => !found.has(e))) return 'partial';
  const same = [...found.values()].every((c) => path.resolve(c).toLowerCase() === path.resolve(exe).toLowerCase());
  return same ? 'on' : 'other';
}

function connect(exe) {
  const data = read();
  strip(data);
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {};
  for (const event of EVENTS) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    groups.push({ hooks: [{ type: 'command', command: exe, args: ['hook'], async: true, timeout: 10 }] });
    data.hooks[event] = groups;
  }
  write(data);
}

function disconnect() {
  const data = read();
  if (strip(data)) write(data);
}

module.exports = { status, connect, disconnect, FILE, BACKUP, EVENTS };
