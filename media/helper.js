// Builds and runs media/smtc.exe, and turns its JSON lines into events.
// The exe is compiled on first run with the C# compiler that ships with
// Windows, so there is no native module or SDK to install.

const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SRC = path.join(__dirname, 'smtc.cs');
const BIN_DIR = path.join(__dirname, 'bin');
const EXE = path.join(BIN_DIR, 'smtc.exe');
const FW = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const WINMD = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');

function needsBuild() {
  try {
    return fs.statSync(EXE).mtimeMs < fs.statSync(SRC).mtimeMs;
  } catch {
    return true;
  }
}

function build() {
  return new Promise((resolve, reject) => {
    if (!needsBuild()) return resolve(EXE);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const args = [
      '/nologo', '/optimize+', '/target:exe', `/out:${EXE}`,
      `/r:${path.join(FW, 'System.Runtime.dll')}`,
      `/r:${path.join(FW, 'System.Runtime.InteropServices.WindowsRuntime.dll')}`,
      `/r:${path.join(WINMD, 'Windows.Foundation.winmd')}`,
      `/r:${path.join(WINMD, 'Windows.Media.winmd')}`,
      `/r:${path.join(WINMD, 'Windows.Storage.winmd')}`,
      SRC,
    ];
    execFile(path.join(FW, 'csc.exe'), args, { windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(`csc failed: ${stdout || err.message}`));
      else resolve(EXE);
    });
  });
}

class MediaHelper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = { none: true };
    this.art = null;
    this.restarts = 0;
    this.stopped = false;
  }

  async start() {
    try {
      await build();
    } catch (e) {
      this.emit('error', e);
      return;
    }
    this.spawn();
  }

  spawn() {
    if (this.stopped) return;
    const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (d) => this.emit('error', new Error(String(d))));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      // Restart with backoff; give up after a few fast failures.
      if (this.restarts++ < 5) setTimeout(() => this.spawn(), 1000 * this.restarts);
      else this.emit('error', new Error(`smtc.exe keeps exiting (code ${code})`));
    });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'state') {
      this.restarts = 0;
      delete msg.type;
      this.state = msg;
      this.emit('state', msg);
    } else if (msg.type === 'art') {
      this.art = msg.data ? { key: msg.key, url: `data:${msg.mime || 'image/jpeg'};base64,${msg.data}` } : { key: msg.key, url: null };
      this.emit('art', this.art);
    } else if (msg.type === 'error') {
      this.emit('error', new Error(msg.message));
    }
  }

  command(cmd) {
    if (!/^(toggle|next|prev|seek \d+)$/.test(cmd)) return;
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.stdin.end();
  }
}

module.exports = { MediaHelper };
