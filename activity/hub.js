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
// - Subagents: each is its own entry under its session (events fired inside
//   one carry its agent id), never the session's own state. While they still
//   run after the main agent's reply, the session is "waiting" (no peek); it
//   finishes, and peeks, once: when the main agent wraps up after the last
//   one. A subagent's permission prompt is a needs-you of its session.
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
const MAX_AGENTS = 20;          // per session
const ASKER_MS = 10000;         // a permission request this recent says which agent a prompt is for
// Waiting, the last subagent ended, and the main agent never came back (the
// report-back normally follows within a second): finish anyway.
const WAIT_DONE_MS = 60 * 1000;
const TICK_MS = 250;
const HOLD_POLL_MS = 2000;
// SHQueryUserNotificationState: QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN,
// QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_APP (fullscreen store app)
const HOLD_QUNS = new Set([2, 3, 4, 6, 7]);

const EVENTS = new Set([
  'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd',
]);
const AGENT_ID = /^[\w-]{1,40}$/;
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

  // Runs while Claude Code is on in settings; stop() forgets everything.
  start() {
    if (this.server) return;
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
    this.server = null;
    this.queue = [];
    if (this.current) this.hide(false);
    if (this.sessions.size) {
      this.sessions.clear();
      this.emitSessions();
    }
  }

  get running() {
    return !!this.server;
  }

  onLine(line) {
    if (!this.server) return;
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
      // Subagents: events fired inside one carry its id; Stop lists the ones
      // still running in the background; a report-back prompt is not the user typing.
      agentId: typeof m.agentId === 'string' && AGENT_ID.test(m.agentId) ? m.agentId : '',
      agent: str(m.agent, 40),
      notif: m.notif === 1,
      bgAgents: Array.isArray(m.bgAgents)
        ? m.bgAgents.filter((id) => typeof id === 'string' && AGENT_ID.test(id)).slice(0, 20) : null,
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
        needsKind: null, needsAt: 0, tool: '', askTool: '', pid: 0, hwnd: 0, lastEventAt: 0,
        // Subagents: id -> agent; how many this task ran; the main agent has
        // replied (Stop) while some still run; which agent a needs-you is
        // for ('' = the main agent); the last agent that asked for permission;
        // when the last agent of a waiting session ended.
        agents: new Map(), agentsUsed: 0, mainDone: false, needsAgent: '', asker: null, waitDoneAt: 0,
      };
      this.sessions.set(s.id, s);
      this.trim(s.id); // never the new one: it starts "idle", the lowest rank but stopped
    }
    return s;
  }

  label(s) {
    return s.num > 1 ? `${s.project} ${s.num}` : s.project;
  }

  onEvent(e) {
    const s = this.session(e);
    s.lastEventAt = Math.max(s.lastEventAt, e.t); // subagents' events too: a session busy in them is not idle
    if (e.pid) s.pid = e.pid;
    if (e.hwnd) s.hwnd = e.hwnd;
    if (e.agentId) this.onAgentEvent(s, e);
    else this.onMainEvent(s, e);
    this.log('activity', e.event, e.agentId ? `agent ${e.agent || e.agentId}` : '', e.ntype || e.tool || '',
      this.label(s), '->', s.state);
    this.emitSessions();
  }

  // The main agent's events: the session's own state.
  onMainEvent(s, e) {
    switch (e.event) {
      case 'UserPromptSubmit':
        if (e.notif) {
          // A subagent (or another background task) reporting back: the same
          // task goes on. After the task had finished, a new stretch of work.
          if (s.state !== 'working' && s.state !== 'waiting' && s.state !== 'needs') {
            s.turnStart = e.t;
            s.agentsUsed = this.active(s).length;
            this.drop(s.id);
          }
          s.mainDone = false;
          if (s.state !== 'needs') s.state = 'working';
          break;
        }
        // The user: a new task. Running agents (background ones can outlive
        // the turn that started them) stay; done ones go.
        s.state = 'working';
        s.turnStart = e.t;
        s.tool = '';
        s.needsKind = null;
        s.needsAgent = '';
        s.asker = null;
        s.mainDone = false;
        s.waitDoneAt = 0;
        for (const [id, a] of s.agents) if (a.state === 'done') s.agents.delete(id);
        s.agentsUsed = s.agents.size;
        this.drop(s.id);
        break;
      case 'PermissionRequest':
        s.askTool = e.tool; // the permission_prompt notification that follows has no tool name
        s.asker = null;     // the main agent asks
        this.midTurn(s, e);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        this.midTurn(s, e);
        // Claude moved on: the prompt was answered. Only the main agent's own
        // prompt: one of its subagents may still be waiting on you.
        if (s.state === 'needs' && !s.needsAgent && e.t > s.needsAt) this.clearNeeds(s, e.t);
        break;
      case 'Notification': {
        const kind = NEEDS[e.ntype];
        if (!kind) break;
        // The notification has no agent id: a permission request from an agent
        // just before it means that agent is the one asking.
        const a = s.asker && e.t - s.asker.at < ASKER_MS ? s.agents.get(s.asker.id) : null;
        this.markNeeds(s, kind, e, a || null);
        break;
      }
      case 'Stop': {
        // Background subagents Claude Code still runs. One island thinks runs
        // but is not listed ended without a SubagentStop reaching us.
        if (e.bgAgents) {
          const still = new Set(e.bgAgents);
          for (const a of s.agents.values()) if (a.state !== 'done' && !still.has(a.id)) this.endAgent(s, a, e.t);
          for (const id of e.bgAgents) if (!s.agents.has(id)) this.agentFor(s, { agentId: id, agent: '', t: e.t, event: '' });
        }
        if (!this.active(s).length) { this.finish(s, e.t, false); break; }
        // The main agent replied, its subagents still work: the task goes on.
        s.mainDone = true;
        s.waitDoneAt = 0;
        if (s.state !== 'needs' || !s.needsAgent) {
          s.state = 'waiting';
          s.needsKind = null;
          s.needsAgent = '';
          s.tool = '';
          this.drop(s.id);
        }
        break;
      }
      case 'StopFailure':
        this.finish(s, e.t, true);
        break;
      case 'SubagentStart':
      case 'SubagentStop':
        this.midTurn(s, e); // from an islandctl without agent ids
        break;
      case 'SessionEnd':
        s.state = 'stopped';
        s.endedAt = e.t;
        s.needsKind = null;
        s.needsAgent = '';
        s.mainDone = false;
        for (const a of s.agents.values()) this.endAgent(s, a, e.t);
        this.drop(s.id);
        break;
    }
  }

  // Events fired inside a subagent: that agent's line, never the main state,
  // except a needs-you (the session needs you) and a missed turn start.
  onAgentEvent(s, e) {
    if (s.state !== 'waiting') this.midTurn(s, e);
    const a = this.agentFor(s, e);
    a.lastEventAt = Math.max(a.lastEventAt, e.t);
    if (a.state === 'done') return; // late events of a finished agent
    switch (e.event) {
      case 'SubagentStop':
        this.endAgent(s, a, e.t);
        break;
      case 'PermissionRequest':
        a.askTool = e.tool;
        s.asker = { id: a.id, at: e.t };
        break;
      case 'Notification': {
        const kind = NEEDS[e.ntype];
        if (kind) this.markNeeds(s, kind, e, a);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        if (e.tool) a.tool = e.tool;
        if (a.state === 'needs' && e.t > a.needsAt) a.state = 'running';
        // Its own prompt; or, with the main agent done (so not asking), one we
        // could not tie to an agent.
        if (s.state === 'needs' && e.t > s.needsAt && (s.needsAgent === a.id || (!s.needsAgent && s.mainDone))) {
          this.clearNeeds(s, e.t);
        }
        break;
    }
  }

  // The agent for an event, created when new (also when island started
  // mid-run). Labels: the agent type, general-purpose as "Agent", repeats
  // numbered within the session.
  agentFor(s, e) {
    let a = s.agents.get(e.agentId);
    if (!a) {
      const type = e.agent || '';
      const base = !type || type === 'general-purpose' ? 'Agent' : type;
      let num = 1;
      for (const o of s.agents.values()) if (o.base === base) num = Math.max(num, o.num + 1);
      a = {
        id: e.agentId, type, base, num, label: num > 1 ? `${base} ${num}` : base,
        state: 'running', tool: '', askTool: '', startedAt: e.t, endedAt: 0, lastEventAt: e.t, needsAt: 0,
      };
      s.agents.set(a.id, a);
      s.agentsUsed++;
      this.trimAgents(s);
    } else if (e.event === 'SubagentStart' && a.state === 'done') {
      a.state = 'running'; // resumed
      a.endedAt = 0;
    }
    return a;
  }

  // At most MAX_AGENTS per session: the oldest done ones go first.
  trimAgents(s) {
    while (s.agents.size > MAX_AGENTS) {
      const list = [...s.agents.values()];
      const done = list.filter((a) => a.state === 'done').sort((x, y) => x.endedAt - y.endedAt);
      const victim = done[0] || list.sort((x, y) => x.startedAt - y.startedAt)[0];
      s.agents.delete(victim.id);
    }
  }

  active(s) {
    return [...s.agents.values()].filter((a) => a.state !== 'done');
  }

  endAgent(s, a, t) {
    if (a.state === 'done') return;
    a.state = 'done';
    a.endedAt = t;
    if (s.needsAgent === a.id) this.clearNeeds(s, t);
    if (s.state === 'waiting' && !this.active(s).length && !s.waitDoneAt) s.waitDoneAt = t;
  }

  markNeeds(s, kind, e, a) {
    s.state = 'needs';
    s.needsKind = kind;
    s.needsAt = e.t;
    s.needsAgent = a ? a.id : '';
    if (a) {
      a.state = 'needs';
      a.needsAt = e.t;
    }
    const asked = a ? a.askTool : s.askTool;
    s.tool = kind === 'permission' ? (asked || toolIn(e.message)) : '';
    this.add(s, 'needs');
  }

  // The prompt was answered: back to work, or to waiting on subagents.
  clearNeeds(s, t) {
    s.needsKind = null;
    s.needsAgent = '';
    s.tool = '';
    s.state = s.mainDone ? 'waiting' : 'working';
    if (s.state === 'waiting' && !this.active(s).length && !s.waitDoneAt) s.waitDoneAt = t;
    this.drop(s.id);
  }

  // The task is over: finished (or ended on an error), peeks when it ran long enough.
  finish(s, t, failed) {
    s.state = failed ? 'failed' : 'finished';
    s.endedAt = t;
    s.durationMs = s.turnStart ? Math.max(0, t - s.turnStart) : 0;
    s.needsKind = null;
    s.needsAgent = '';
    s.tool = '';
    s.mainDone = false;
    s.waitDoneAt = 0;
    this.drop(s.id);
    if (s.durationMs >= MIN_TURN_MS) this.add(s, s.state);
  }

  // Tool and subagent events only happen during a turn. One for a session not
  // known to be working means island missed the turn's start (it started or
  // restarted mid-turn, e.g. after an update): count the turn from here, so
  // its finish still peeks. Not for events older than the last finish (async
  // hooks can arrive a little out of order). A main-agent event while waiting
  // on subagents: the main agent works again.
  midTurn(s, e) {
    if (s.state === 'working' || s.state === 'needs' || e.t <= s.endedAt) return;
    if (s.state === 'waiting') {
      s.state = 'working';
      s.mainDone = false;
      s.waitDoneAt = 0;
      return;
    }
    s.state = 'working';
    s.turnStart = e.t;
    s.tool = '';
    s.mainDone = false;
    s.agentsUsed = this.active(s).length;
  }

  // ---- peeks -----------------------------------------------------------------

  async add(s, kind) {
    const p = { key: ++this.seq, session: s.id, kind, at: Date.now(), shown: 0, held: false, bannered: false, chimed: false };
    if (kind !== 'needs' && await this.terminalInFront(s)) {
      this.log('activity: terminal in front, no peek for', this.label(s));
      return;
    }
    // Moved on while we asked (a new prompt, closed, removed, Claude Code turned off).
    if (this.sessions.get(s.id) !== s || s.state !== kind) return;
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
      agents: p.kind === 'needs' ? 0 : s.agentsUsed,
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

  // Sessions whose Claude process is gone end as "stopped"; old ones go; a
  // session left waiting with no subagent running finishes.
  sweep(now = Date.now()) {
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.state !== 'stopped' && s.pid && !alive(s.pid)) {
        s.state = 'stopped';
        s.endedAt = now;
        s.needsKind = null;
        s.needsAgent = '';
        s.mainDone = false;
        for (const a of s.agents.values()) this.endAgent(s, a, now);
        this.drop(s.id);
        changed = true;
      } else if (s.state === 'waiting' && s.waitDoneAt && !this.active(s).length && now - s.waitDoneAt > WAIT_DONE_MS) {
        this.finish(s, now, false);
        changed = true;
      }
    }
    if (this.trim()) changed = true;
    if (changed) this.emitSessions();
  }

  trim(keep) {
    const now = Date.now();
    let changed = false;
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'stopped' && now - s.endedAt > KEEP_STOPPED_MS) { this.sessions.delete(s.id); changed = true; }
    }
    const extra = this.sessions.size - MAX_SESSIONS;
    if (extra > 0) {
      const old = [...this.sessions.values()].filter((s) => s.id !== keep)
        .sort((a, b) => rank(b) - rank(a) || a.lastEventAt - b.lastEventAt).slice(0, extra);
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
        agentsUsed: s.agentsUsed,
        agents: [...s.agents.values()].map((a) => ({
          id: a.id, label: a.label, type: a.type, state: a.state, tool: a.tool, askTool: a.askTool,
          startedAt: a.startedAt, endedAt: a.endedAt, lastEventAt: a.lastEventAt,
        })),
        canJump: !!s.hwnd && s.state !== 'stopped',
      }));
  }

  emitSessions() {
    this.emit('sessions', this.list());
  }
}

function rank(s) {
  return { needs: 0, working: 1, waiting: 1, failed: 2, finished: 2, idle: 3, stopped: 4 }[s.state] ?? 3;
}

// "Claude needs your permission to use Bash" -> "Bash"
function toolIn(message) {
  const m = /permission to use ([\w:.-]+)/i.exec(message || '');
  return m ? m[1] : '';
}

module.exports = { Hub, pipeName };
