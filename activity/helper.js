// Builds activity/bin/islandctl.exe (like media/smtc.exe: with the C# compiler
// that ships with Windows) and runs its one-shot commands for the main process.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'islandctl.cs');
const BIN_DIR = path.join(__dirname, 'bin');
const EXE = path.join(BIN_DIR, 'islandctl.exe');
const FW = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');

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
    const args = ['/nologo', '/optimize+', '/target:winexe', `/out:${EXE}`, SRC];
    execFile(path.join(FW, 'csc.exe'), args, { windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(`csc failed: ${stdout || err.message}`));
      else resolve(EXE);
    });
  });
}

class Ctl {
  // exe: the packaged app ships one in resources; otherwise built on first use.
  constructor({ exe } = {}) {
    this.exe = exe || null;
  }

  async path() {
    if (!this.exe) this.exe = await build();
    return this.exe;
  }

  async run(args, timeout = 2000) {
    const exe = await this.path();
    return new Promise((resolve) => {
      execFile(exe, args, { windowsHide: true, timeout }, (_err, stdout) => resolve(String(stdout || '')));
    });
  }

  // { quns, dnd, fg, fgRoot } or null
  async state() {
    try { return JSON.parse(await this.run(['state'])); } catch { return null; }
  }

  async focus(hwnd) {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return false;
    return (await this.run(['focus', String(hwnd)])).trim() === 'ok';
  }
}

module.exports = { Ctl, build, EXE };
