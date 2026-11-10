// Updates from GitHub Releases, without dependencies.
//
// Checks the repository's latest release (GitHub's REST API), downloads its
// installer, and verifies it against the SHA-256 digest GitHub publishes for
// every release asset (and its size). A file that does not match is deleted.
// Installing runs the NSIS installer silently with --updated (it waits for
// island to exit) and --force-run (it starts island again afterwards).
//
// Only github.com/yatinannam/island is trusted. For tests, ISLAND_UPDATE_URL
// may point the check at a local server (http://127.0.0.1 or localhost only),
// and then downloads must come from that same server.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'yatinannam/island';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const ASSET = /^island-setup-(\d+\.\d+\.\d+)\.exe$/;
const MAX_BYTES = 400 * 1024 * 1024;

// [major, minor, patch] or null
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function localOverride(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url || '');
}

class Updater extends EventEmitter {
  // fetch: Electron's net.fetch (system proxy) or a fetch for tests.
  constructor({ version, dir, fetch, log = () => {}, apiUrl }) {
    super();
    this.version = version;
    this.dir = dir;
    this.fetch = fetch;
    this.log = log;
    this.api = localOverride(apiUrl) ? apiUrl : API;
    this.allowed = this.api === API ? DOWNLOADS : new URL(this.api).origin + '/';
    // idle | checking | current | downloading | ready | error
    this.state = { status: 'idle', version: null, progress: 0, error: '', checkedAt: 0 };
    this.file = null;
    this.busy = false;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  // One check, and the download if there is something newer.
  async check() {
    if (this.busy) return this.state;
    if (this.state.status === 'ready') return this.state;
    this.busy = true;
    this.set({ status: 'checking', error: '' });
    try {
      const res = await this.fetch(this.api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'island-updater' } });
      if (!res.ok) throw new Error(`release check failed (HTTP ${res.status})`);
      const rel = await res.json();
      const latest = parse(rel && rel.tag_name) ? String(rel.tag_name).replace(/^v/, '') : null;
      if (!latest || rel.draft || rel.prerelease) throw new Error('no usable release');
      if (!newer(latest, this.version)) {
        this.set({ status: 'current', version: latest, checkedAt: Date.now() });
        this.log('update: up to date', this.version);
        return this.state;
      }
      const asset = (rel.assets || []).find((a) => {
        const m = ASSET.exec(a && a.name);
        return m && m[1] === latest;
      });
      if (!asset) throw new Error(`release ${latest} has no installer`);
      const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
      if (!digest) throw new Error(`release ${latest} has no SHA-256 digest`);
      if (!String(asset.browser_download_url).startsWith(this.allowed)) throw new Error('installer is not from the island repository');
      if (!(asset.size > 0 && asset.size <= MAX_BYTES)) throw new Error('installer size is not plausible');
      await this.download(latest, asset.browser_download_url, asset.size, digest[1].toLowerCase());
    } catch (e) {
      this.log('update:', e.message);
      this.set({ status: 'error', error: e.message, checkedAt: Date.now() });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async download(version, url, size, sha256) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `island-setup-${version}.exe`;
    const file = path.join(this.dir, name);
    // Older downloads go.
    for (const f of fs.readdirSync(this.dir)) {
      if (f !== name) remove(path.join(this.dir, f));
    }
    // Already downloaded and intact (e.g. before a restart).
    if (fs.existsSync(file) && (await hashFile(file)) === sha256) {
      this.ready(version, file);
      return;
    }
    this.set({ status: 'downloading', version, progress: 0 });
    this.log('update: downloading', version);
    const res = await this.fetch(url, { headers: { 'User-Agent': 'island-updater' } });
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const part = file + '.part';
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let got = 0, lastEmit = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > size) throw new Error('download is larger than published');
        hash.update(value);
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - lastEmit > 500) { lastEmit = now; this.set({ progress: got / size }); }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw e;
    }
    if (got !== size || hash.digest('hex') !== sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('downloaded installer does not match the published SHA-256');
    }
    fs.renameSync(part, file);
    this.ready(version, file);
  }

  // At startup: installers of this version or older (already installed) and
  // unfinished downloads go; a newer one that was ready is kept for check().
  // Right after an update the installer that started island may still be
  // running from this folder, so a file can be locked: skip it, next time.
  clean() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) {
      const m = ASSET.exec(f);
      if (!m || !newer(m[1], this.version)) remove(path.join(this.dir, f));
    }
  }

  ready(version, file) {
    this.file = file;
    this.log('update: ready', version);
    this.set({ status: 'ready', version, progress: 1, checkedAt: Date.now() });
  }

  // Starts the installer and returns true; the caller quits island right
  // after. relaunch: start island again when done (not when quitting).
  install({ relaunch }) {
    if (this.state.status !== 'ready' || !this.file || !fs.existsSync(this.file)) return false;
    const args = ['--updated', '/S'];
    if (relaunch) args.push('--force-run');
    this.log('update: installing', this.state.version, args.join(' '));
    spawn(this.file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }
}

function remove(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function hashFile(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', () => resolve(null))
      .on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { Updater, newer, parse };
