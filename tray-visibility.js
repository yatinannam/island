// Windows hides new tray icons in the overflow (^) menu and remembers the
// user's choice per icon in HKCU\Control Panel\NotifyIconSettings\<id>,
// value IsPromoted (1 = always shown on the taskbar). The icon is matched by
// the GUID we pass to Tray, so the choice survives restarts.

const { execFile } = require('child_process');

const ROOT = 'HKCU\\Control Panel\\NotifyIconSettings';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Registry key of the entry whose IconGuid is ours, or null if Explorer
// hasn't written it yet. Reads only IconGuid values: a full-data search is
// very slow because every entry holds a PNG snapshot of its icon.
async function findKey(guid) {
  const out = await reg(['query', ROOT, '/s', '/v', 'IconGuid']);
  const want = `{${guid.toUpperCase()}}`;
  let key = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) key = line.trim();
    else if (key && line.includes('IconGuid') && line.toUpperCase().includes(want)) return key;
  }
  return null;
}

async function waitForKey(guid, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const key = await findKey(guid);
    if (key) return key;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function readPromoted(key) {
  const out = await reg(['query', key, '/v', 'IsPromoted']);
  return /IsPromoted\s+REG_DWORD\s+0x1\b/i.test(out);
}

async function isPromoted(guid) {
  const key = await findKey(guid);
  return key ? readPromoted(key) : false;
}

// Explorer applies the value live, but right after it creates the entry it
// may still write its own default over ours; check and write again.
async function setPromoted(guid, on) {
  const key = await waitForKey(guid);
  if (!key) return false;
  for (let i = 0; i < 4; i++) {
    await reg(['add', key, '/v', 'IsPromoted', '/t', 'REG_DWORD', '/d', on ? '1' : '0', '/f']);
    await new Promise((r) => setTimeout(r, 1500));
    if ((await readPromoted(key)) === on) return true;
  }
  return false;
}

module.exports = { isPromoted, setPromoted };
