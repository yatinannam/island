// Live activities: Claude Code sessions, reported by islandctl.exe (run as a
// Claude Code hook) over a named pipe, turned into a session list for the
// island's Activity page and into "peeks": the closed island dropping a small
// pill on its own.
//
// Rules (decided with Yatin):
// - Working: no peek, only listed. Finished: peek for 5s, only if the turn
//   ran 10s or more and its terminal is not the foreground window.
// - Needs you (a permission prompt, a question): peek always,
//   stays until that session moves on, the peek is clicked or dismissed.
// - Subagent finished: counted on the session, no peek.
// - Held while a fullscreen app, a presentation, quiet time or Do Not Disturb
//   is on, and while the PC is locked; shown afterwards without a chime. Held
//   for more than 30 min: dropped (still listed).
// - Several at once: one after another, needs-you first. A needs-you peek
//   that stays up gives way to newer ones after 5s and comes back after.
// - While the island is open: a one-line banner instead.
// The pipe only carries data to show; nothing in a message is ever run.

const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const FINISHED_PEEK_MS = 5000;
const MIN_TURN_MS = 10000;
const YIELD_MS = 5000;          // a needs-you peek gives way to waiting peeks after this
const GAP_MS = 350;             // between two peeks, so one retracts before the next drops
const MAX_HELD_MS = 30 * 60 * 1000;
const KEEP_STOPPED_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 12;
const TICK_MS = 250;
const HOLD_POLL_MS = 2000;
// SHQueryUserNotificationState: QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN,
// QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_APP (fullscreen store app)
const HOLD_QUNS = new Set([2, 3, 4, 6, 7]);

const EVENTS = new Set([
  'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied',
  'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
]);
// Notification types that mean "Claude is blocked on you". Not idle_prompt
// (Claude finished a while ago and you haven't typed): that session is just
// finished, and Yatin found an amber "waiting for you" on it confusing.
const NEEDS = {
  permission_prompt: 'permission',
  elicitation_dialog: 'question',
  elicitation_url_dialog: 'question',
  agent_needs_input: 'question',
};

function pipeName() {
  const user = os.userInfo().username.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `\\\\.\\pipe\\island-${user}`;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, just not ours to signal
  }
}

class Hub extends EventEmitter {
  // ctl: activity/helper Ctl (state, focus). sound(): whether to chime.
  constructor({ ctl, log = () => {}, sound = () => true }) {
    super();
    this.ctl = ctl;
    this.log = log;
    this.sound = sound;
    this.sessions = new Map();
    this.queue = [];          // peeks waiting or showing
    this.current = null;      // { p, elapsed }
    this.nextAt = 0;
    this.islandOpen = false;
    this.locked = false;
    this.hover = false;
    this.busy = false;
    this.lastPoll = 0;
    this.seq = 0;
    this.lastTick = Date.now();
    this.burst = { at: 0, n: 0 };
  }

  start() {
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
        if (buf.length > 64 * 1024) { sock.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          this.onLine(line);
        }
      });
      sock.on('error', () => {});
    });
    this.server.on('error', (e) => this.log('activity pipe:', e.message));
    this.server.listen(pipeName(), () => this.log('activity pipe listening', pipeName()));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.staleTimer = setInterval(() => this.sweep(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.staleTimer);
    if (this.server) this.server.close();
  }

  onLine(line) {
    const now = Date.now();
    if (now - this.burst.at > 1000) this.burst = { at: now, n: 0 };
    if (++this.burst.n > 200) return; // flood
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || m.v !== 1 || m.src !== 'claude' || !EVENTS.has(m.event)) return;
    if (typeof m.session !== 'string' || !/^[\w.-]{1,100}$/.test(m.session)) return;
    this.onEvent({
      event: m.event,
      session: m.session,
      cwd: str(m.cwd, 500),
      ntype: str(m.ntype, 60),
      message: str(m.message, 300),
      tool: str(m.tool, 80),
      pid: int(m.pid),
      hwnd: int(m.hwnd),
      t: Number.isFinite(m.t) && Math.abs(m.t - now) < 60000 ? m.t : now,
    });
  }

  session(e) {
    let s = this.sessions.get(e.session);
    if (!s) {
      const project = (path.win32.basename(e.cwd || '') || 'Claude').slice(0, 40);
      const used = new Set([...this.sessions.values()]
        .filter((o) => o.project === project && o.state !== 'stopped').map((o) => o.num));
      let num = 1;
      while (used.has(num)) num++;
      s = {
        id: e.session, project, num, state: 'idle', turnStart: 0, endedAt: 0, durationMs: 0,
        needsKind: null, needsAt: 0, tool: '', askTool: '', subagents: 0, pid: 0, hwnd: 0, lastEventAt: 0,
      };
      this.sessions.set(s.id, s);
      this.trim();
    }
    return s;
  }

  label(s) {
    return s.num > 1 ? `${s.project} ${s.num}` : s.project;
  }

  onEvent(e) {
    const s = this.session(e);
    s.lastEventAt = Math.max(s.lastEventAt, e.t);
    if (e.pid) s.pid = e.pid;
    if (e.hwnd) s.hwnd = e.hwnd;
    switch (e.event) {
      case 'UserPromptSubmit':
        s.state = 'working';
        s.turnStart = e.t;
        s.subagents = 0;
        s.tool = '';
        s.needsKind = null;
        this.drop(s.id);
        break;
      case 'PermissionRequest':
        s.askTool = e.tool; // the permission_prompt notification that follows has no tool name
        this.midTurn(s, e);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        this.midTurn(s, e);
        // Claude moved on: the prompt was answered.
        if (s.state === 'needs' && e.t > s.needsAt) {
          s.state = 'working';
          s.needsKind = null;
          s.tool = '';
          this.drop(s.id);
        }
        break;
      case 'Notification': {
        const kind = NEEDS[e.ntype];
        if (!kind) break;
        s.state = 'needs';
        s.needsKind = kind;
        s.needsAt = e.t;
        s.tool = kind === 'permission' ? (s.askTool || toolIn(e.message)) : '';
        this.add(s, 'needs');
        break;
      }
      case 'Stop':
      case 'StopFailure':
        s.state = e.event === 'Stop' ? 'finished' : 'failed';
        s.endedAt = e.t;
        s.durationMs = s.turnStart ? Math.max(0, e.t - s.turnStart) : 0;
        s.needsKind = null;
        s.tool = '';
        this.drop(s.id);
        if (s.durationMs >= MIN_TURN_MS) this.add(s, s.state);
        break;
      case 'SubagentStop':
        this.midTurn(s, e);
        s.subagents++;
        break;
      case 'SessionEnd':
        s.state = 'stopped';
        s.endedAt = e.t;
        s.needsKind = null;
        this.drop(s.id);
        break;
    }
    this.log('activity', e.event, e.ntype || e.tool || '', this.label(s), '->', s.state);
    this.emitSessions();
  }

  // Tool and subagent events only happen during a turn. One for a session not
  // known to be working means island missed the turn's start (it started or
  // restarted mid-turn, e.g. after an update): count the turn from here, so
  // its finish still peeks. Not for events older than the last finish (async
  // hooks can arrive a little out of order).
  midTurn(s, e) {
    if (s.state === 'working' || s.state === 'needs' || e.t <= s.endedAt) return;
    s.state = 'working';
    s.turnStart = e.t;
    s.subagents = 0;
    s.tool = '';
  }

  // ---- peeks -----------------------------------------------------------------

  async add(s, kind) {
    const p = { key: ++this.seq, session: s.id, kind, at: Date.now(), shown: 0, held: false, bannered: false, chimed: false };
    if (kind !== 'needs' && await this.terminalInFront(s)) {
      this.log('activity: terminal in front, no peek for', this.label(s));
      return;
    }
    if (this.sessions.get(s.id) !== s) return;
    this.queue = this.queue.filter((q) => q.session !== s.id);
    if (this.current && this.current.p.session === s.id) this.hide(false);
    this.queue.push(p);
    this.schedule();
  }

  async terminalInFront(s) {
    if (!s.hwnd) return false;
    const st = await this.ctl.state();
    return !!st && (st.fgRoot === s.hwnd || st.fg === s.hwnd);
  }

  // Remove a session's peeks (it moved on, was opened or dismissed).
  drop(sessionId) {
    this.queue = this.queue.filter((q) => q.session !== sessionId);
    if (this.current && this.current.p.session === sessionId) this.hide(false);
  }

  hide(keep) {
    if (!this.current) return;
    const { p } = this.current;
    if (!keep) this.queue = this.queue.filter((q) => q !== p);
    this.current = null;
    this.nextAt = Date.now() + GAP_MS;
    this.emit('peek', null);
  }

  // Chimes once per peek, and never for one that was held back (fullscreen,
  // quiet time, locked): that news is old by the time it shows.
  payload(p) {
    const s = this.sessions.get(p.session);
    const chime = !p.held && !p.chimed;
    p.chimed = true;
    return {
      key: p.key,
      session: p.session,
      kind: p.kind === 'needs' ? (s.needsKind || 'permission') : p.kind,
      label: this.label(s),
      tool: p.kind === 'needs' ? s.tool : '',
      durationMs: p.kind === 'needs' ? 0 : s.durationMs,
      chime: chime && this.sound(),
    };
  }

  // Pick what shows next: needs-you not shown yet, then others in order,
  // then needs-you peeks that already had a turn.
  pick() {
    const fresh = this.queue.filter((q) => !q.shown);
    return fresh.find((q) => q.kind === 'needs') || fresh[0] || this.queue.find((q) => q.kind === 'needs') || null;
  }

  async schedule() {
    if (this.scheduling) { this.again = true; return; }
    this.scheduling = true;
    try {
      do {
        this.again = false;
        await this.scheduleOnce();
      } while (this.again);
    } finally {
      this.scheduling = false;
    }
  }

  async scheduleOnce() {
    const now = Date.now();
    // Held too long: only listed.
    this.queue = this.queue.filter((q) => !(q.held && now - q.at > MAX_HELD_MS));
    if (this.islandOpen) {
      for (const q of this.queue) {
        if (q.bannered) continue;
        q.bannered = true;
        this.emit('banner', this.payload(q));
      }
      // Finished ones were seen now; needs-you comes back after the island closes.
      this.queue = this.queue.filter((q) => q.kind === 'needs');
      return;
    }
    if (this.current || !this.queue.length || now < this.nextAt) return;
    if (this.locked) { this.queue.forEach((q) => { q.held = true; }); return; }
    const st = await this.ctl.state();
    this.lastPoll = Date.now();
    // dnd: Windows' quiet-hours profile (1 = Do Not Disturb, 2 = alarms only);
    // the notification state alone does not show Do Not Disturb.
    this.busy = !!st && (HOLD_QUNS.has(st.quns) || st.dnd > 0);
    if (this.busy) { this.queue.forEach((q) => { q.held = true; }); return; }
    if (this.current || this.islandOpen || this.locked) return; // changed while waiting
    const p = this.pick();
    if (!p) return;
    const s = this.sessions.get(p.session);
    if (!s) { this.queue = this.queue.filter((q) => q !== p); return; }
    // Shown later than it happened: its terminal may be in front by now.
    if (p.kind !== 'needs' && p.held && st && s.hwnd && (st.fgRoot === s.hwnd || st.fg === s.hwnd)) {
      this.queue = this.queue.filter((q) => q !== p);
      this.again = true;
      return;
    }
    p.shown++;
    this.current = { p, elapsed: 0 };
    const payload = this.payload(p);
    this.log('activity peek', p.kind, this.label(s), payload.chime ? '(chime)' : '');
    this.emit('peek', payload);
  }

  tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (this.current) {
      if (!this.hover) this.current.elapsed += dt;
      const { p, elapsed } = this.current;
      if (p.kind !== 'needs') {
        if (elapsed >= FINISHED_PEEK_MS) this.hide(false);
      } else if (elapsed >= YIELD_MS && this.queue.some((q) => q !== p && !q.shown)) {
        this.hide(true); // stays queued, comes back after the others
      }
    }
    if (!this.current && this.queue.length) {
      const waitingOnHold = this.busy && now - this.lastPoll < HOLD_POLL_MS;
      if (!waitingOnHold) this.schedule();
    }
  }

  // Sessions whose Claude process is gone end as "stopped"; old ones go.
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.state !== 'stopped' && s.pid && !alive(s.pid)) {
        s.state = 'stopped';
        s.endedAt = now;
        s.needsKind = null;
        this.drop(s.id);
        changed = true;
      }
    }
    if (this.trim()) changed = true;
    if (changed) this.emitSessions();
  }

  trim() {
    const now = Date.now();
    let changed = false;
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'stopped' && now - s.endedAt > KEEP_STOPPED_MS) { this.sessions.delete(s.id); changed = true; }
    }
    const extra = this.sessions.size - MAX_SESSIONS;
    if (extra > 0) {
      const old = [...this.sessions.values()].sort((a, b) => rank(b) - rank(a) || a.lastEventAt - b.lastEventAt).slice(0, extra);
      for (const s of old) { this.sessions.delete(s.id); this.drop(s.id); }
      changed = true;
    }
    return changed;
  }

  // ---- from main ---------------------------------------------------------------

  setHover(on) {
    this.hover = !!on;
  }

  setIslandOpen(open) {
    if (open === this.islandOpen) return;
    this.islandOpen = open;
    if (open && this.current) {
      // Opening from a peek: finished ones are seen now; needs-you stays.
      const { p } = this.current;
      p.bannered = true;
      this.hide(p.kind === 'needs');
    }
    this.nextAt = Date.now() + (open ? 0 : GAP_MS);
    this.schedule();
  }

  setLocked(on) {
    this.locked = !!on;
    if (on && this.current) this.hide(true);
    if (!on) this.schedule();
  }

  get peeking() {
    return !!this.current;
  }

  // Bring the session's terminal to the front and clear its peek.
  async jump(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.drop(s.id);
    const ok = await this.ctl.focus(s.hwnd);
    this.log('activity jump', this.label(s), ok ? 'ok' : 'failed');
    return ok;
  }

  // Ctrl+Alt+J: the latest session that needs you, else the latest that finished.
  jumpLatest() {
    const list = [...this.sessions.values()];
    const needs = list.filter((s) => s.state === 'needs').sort((a, b) => b.needsAt - a.needsAt)[0];
    const done = list.filter((s) => s.state === 'finished' || s.state === 'failed').sort((a, b) => b.endedAt - a.endedAt)[0];
    const s = needs || done;
    return s ? this.jump(s.id) : Promise.resolve(false);
  }

  // The pill's x: hide this peek. Activity page x: also remove the session
  // from the list, whatever its state; it comes back with its next event.
  dismiss(sessionId, forget) {
    this.drop(sessionId);
    if (forget) this.sessions.delete(sessionId);
    this.emitSessions();
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => rank(a) - rank(b) || (b.endedAt || b.lastEventAt) - (a.endedAt || a.lastEventAt))
      .map((s) => ({
        id: s.id,
        label: this.label(s),
        state: s.state,
        needsKind: s.needsKind,
        tool: s.tool,
        turnStart: s.turnStart,
        durationMs: s.durationMs,
        endedAt: s.endedAt,
        lastEventAt: s.lastEventAt,
        subagents: s.subagents,
        canJump: !!s.hwnd && s.state !== 'stopped',
      }));
  }

  emitSessions() {
    this.emit('sessions', this.list());
  }
}

function rank(s) {
  return { needs: 0, working: 1, failed: 2, finished: 2, idle: 3, stopped: 4 }[s.state] ?? 3;
}

// "Claude needs your permission to use Bash" -> "Bash"
function toolIn(message) {
  const m = /permission to use ([\w:.-]+)/i.exec(message || '');
  return m ? m[1] : '';
}

module.exports = { Hub, pipeName };
