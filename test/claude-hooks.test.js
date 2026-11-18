// island's hooks in Claude Code's settings, in a scratch config folder
// (CLAUDE_CONFIG_DIR is read when claude-hooks.js loads).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hooks-'));
process.env.CLAUDE_CONFIG_DIR = dir;
const hooks = require('../activity/claude-hooks');

const EXE = 'C:\\x\\islandctl.exe';
const foreign = { type: 'command', command: 'C:\\tools\\notify.exe' };

// A 0.4-style connection: every event island had then, all pointing at `exe`.
function oldConnection(exe, skip = []) {
  const h = { Stop: [{ hooks: [foreign] }] };
  for (const event of hooks.EVENTS) {
    if (event === 'SubagentStart' || skip.includes(event)) continue;
    h[event] = [...(h[event] || []), { hooks: [{ type: 'command', command: exe, args: ['hook'], async: true, timeout: 10 }] }];
  }
  return { theme: 'dark', hooks: h };
}
const write = (data) => fs.writeFileSync(hooks.FILE, JSON.stringify(data, null, 2) + '\n');
const read = () => JSON.parse(fs.readFileSync(hooks.FILE, 'utf8'));

beforeEach(() => { try { fs.unlinkSync(hooks.FILE); } catch {} });

test('SubagentStart is one of island\'s hooks', () => {
  assert.ok(hooks.EVENTS.includes('SubagentStart'));
});

test('a 0.4 connection upgrades itself and keeps everything else', () => {
  write(oldConnection(EXE));
  assert.strictEqual(hooks.status(EXE), 'partial');
  assert.strictEqual(hooks.upgrade(EXE), true);
  assert.strictEqual(hooks.status(EXE), 'on');
  const data = read();
  assert.strictEqual(data.theme, 'dark');
  assert.ok(data.hooks.Stop.some((g) => g.hooks.some((h) => h.command === foreign.command)));
});

test('hooks of another islandctl (a dev copy) are left alone', () => {
  write(oldConnection('C:\\other\\islandctl.exe'));
  const before = fs.readFileSync(hooks.FILE, 'utf8');
  assert.strictEqual(hooks.upgrade(EXE), false);
  assert.strictEqual(fs.readFileSync(hooks.FILE, 'utf8'), before);
});

test('a connection missing an old event is not repaired silently', () => {
  write(oldConnection(EXE, ['Stop']));
  const before = fs.readFileSync(hooks.FILE, 'utf8');
  assert.strictEqual(hooks.upgrade(EXE), false);
  assert.strictEqual(fs.readFileSync(hooks.FILE, 'utf8'), before);
});

test('nothing connected: nothing written', () => {
  write({ theme: 'dark' });
  assert.strictEqual(hooks.upgrade(EXE), false);
  assert.deepStrictEqual(read(), { theme: 'dark' });
});
