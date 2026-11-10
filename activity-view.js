// Live activities in the island: the peek pill, the Activity page and the
// banner shown while the island is open. Main (activity/hub.js) decides what
// shows and when; this only draws it, plays the chimes and reports clicks.
// Loaded after island.html's own script, whose globals it uses ($, body,
// setPage, renderDots, activityBadge, kick, stopCapture, stopTimer).
(() => {
  const ICONS = {
    ok: '<svg class="ic ic-ok" viewBox="0 0 16 16"><circle class="f" cx="8" cy="8" r="7"/><path d="M4.9 8.3 7 10.4l4.1-4.6"/></svg>',
    warn: '<svg class="ic ic-warn" viewBox="0 0 16 16"><circle class="f" cx="8" cy="8" r="7"/><path d="M8 4.4v4.4M8 11.3v.2"/></svg>',
    err: '<svg class="ic ic-err" viewBox="0 0 16 16"><circle class="f" cx="8" cy="8" r="7"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6"/></svg>',
    spin: '<svg class="ic ic-spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"/></svg>',
    dim: '<svg class="ic ic-dim" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5"/></svg>',
  };
  const GO = '<svg class="go" viewBox="0 0 12 12"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>';
  const X = '<svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8"/></svg>';
  const IDLE_MS = 2 * 60 * 1000; // working, but no news for this long: probably stopped with Esc

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }

  // Peek / banner text: [icon] label  status  detail
  function peekParts(p) {
    switch (p.kind) {
      case 'finished': return { icon: ICONS.ok, status: 'finished', detail: dur(p.durationMs) };
      case 'failed': return { icon: ICONS.err, status: 'ended on an error', detail: dur(p.durationMs) };
      case 'waiting': return { icon: ICONS.warn, status: 'waiting for you', detail: '' };
      case 'question': return { icon: ICONS.warn, status: 'has a question', detail: '' };
      default: return { icon: ICONS.warn, status: p.tool ? `needs you · ${p.tool}` : 'needs you', detail: '' };
    }
  }

  // ---- chimes ------------------------------------------------------------------
  // Two short soft tones made here: rising for finished, a double tap for
  // needs-you, falling for an error. Plays at the system volume.

  let lastChime = 0;
  function chime(kind) {
    const now = performance.now();
    if (now - lastChime < 900) return; // two at once: one chime
    lastChime = now;
    const notes = kind === 'finished' ? [[659.25, 0], [987.77, 0.12]]
      : kind === 'failed' ? [[587.33, 0], [392, 0.14]]
      : [[880, 0], [880, 0.17]];
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.14;
      master.connect(ctx.destination);
      const t0 = ctx.currentTime + 0.03;
      for (const [f, at] of notes) {
        // A sine and a quieter octave above, decaying like a small bell
        for (const [mult, amp, decay] of [[1, 1, 0.6], [2, 0.16, 0.28]]) {
          const o = ctx.createOscillator();
          o.frequency.value = f * mult;
          const g = ctx.createGain();
          const t = t0 + at;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(amp, t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
          o.connect(g).connect(master);
          o.start(t);
          o.stop(t + decay + 0.05);
        }
      }
      setTimeout(() => ctx.close(), 1500);
    } catch {}
  }

  // ---- peek pill -----------------------------------------------------------------

  let peekData = null;

  window.island.onPeek((p) => {
    peekData = p;
    if (p) {
      const parts = peekParts(p);
      $('pillIcon').innerHTML = parts.icon;
      $('pillLabel').textContent = p.label;
      $('pillStatus').textContent = parts.status;
      $('pillDetail').textContent = parts.detail;
      body.classList.add('peek');
      if (p.chime) chime(p.kind);
    } else {
      body.classList.remove('peek');
      // Same as closing: keep the glass capture briefly, then stop it.
      if (!body.classList.contains('open')) {
        clearTimeout(stopTimer);
        stopTimer = setTimeout(stopCapture, 4000);
      }
    }
    kick();
  });

  $('pill').addEventListener('click', (e) => {
    if (!peekData) return;
    if (e.target.closest('#pillX')) window.island.peekDismiss(peekData.session);
    else window.island.peekClick(peekData.session);
  });

  // ---- banner (island open) -----------------------------------------------------------

  let bannerTimer = 0;
  window.island.onBanner((p) => {
    const parts = peekParts(p);
    const el = $('banner');
    el.innerHTML = `${parts.icon}<b>${esc(p.label)}</b><span>${esc(parts.status)}${parts.detail ? ' ' + esc(parts.detail) : ''}</span>`;
    el.classList.add('on');
    if (p.chime) chime(p.kind);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('on'), 4000);
  });

  // ---- Activity page ------------------------------------------------------------------

  let activity = { connected: 'off', sessions: [] };

  function rowParts(s) {
    const subs = s.subagents ? ` · ${s.subagents} subagent${s.subagents === 1 ? '' : 's'} done` : '';
    switch (s.state) {
      case 'working':
        if (Date.now() - s.lastEventAt > IDLE_MS) return { icon: ICONS.dim, what: 'idle', when: ago(s.lastEventAt) };
        return { icon: ICONS.spin, what: 'working' + subs, when: dur(Date.now() - s.turnStart) };
      case 'needs':
        return {
          icon: ICONS.warn,
          what: s.needsKind === 'waiting' ? 'waiting for you' : s.needsKind === 'question' ? 'has a question'
            : s.tool ? `needs you · ${s.tool}` : 'needs you',
          when: '',
        };
      case 'finished': return { icon: ICONS.ok, what: `finished in ${dur(s.durationMs)}${subs}`, when: ago(s.endedAt) };
      case 'failed': return { icon: ICONS.err, what: 'ended on an error', when: ago(s.endedAt) };
      case 'stopped': return { icon: ICONS.dim, what: 'closed', when: ago(s.endedAt) };
      default: return { icon: ICONS.dim, what: 'ready', when: '' };
    }
  }

  // Rows are kept and updated in place (rebuilding them every second would
  // drop the hover under the cursor); only a changed shape rebuilds a row.
  const rows = new Map(); // session id -> { row, shape, html }

  function buildRow(s) {
    const row = document.createElement('div');
    row.className = 'act-row' + (s.canJump ? ' jump' : '');
    row.title = s.canJump ? 'Go to its terminal' : '';
    row.innerHTML = '<span class="i"></span><span class="name"></span><span class="what"></span><span class="when"></span>'
      + (s.canJump ? `<button class="go" title="Go to its terminal">${GO}</button>` : '')
      + (s.state !== 'working' ? `<button class="x" title="${s.state === 'needs' ? 'Dismiss' : 'Remove'}">${X}</button>` : '');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.x')) window.island.activityDismiss(s.id);
      else if (s.canJump) window.island.activityJump(s.id);
    });
    return row;
  }

  function renderActivity() {
    const list = $('actList');
    const sessions = activity.sessions;
    const order = [];
    for (const s of sessions) {
      const shape = `${s.canJump}|${s.state}`;
      let r = rows.get(s.id);
      if (!r || r.shape !== shape) {
        const row = buildRow(s);
        if (r) r.row.replaceWith(row);
        r = { row, shape, icon: '' };
        rows.set(s.id, r);
      }
      const parts = rowParts(s);
      if (r.icon !== parts.icon) { r.row.querySelector('.i').innerHTML = parts.icon; r.icon = parts.icon; }
      const set = (sel, text) => { const el = r.row.querySelector(sel); if (el.textContent !== text) el.textContent = text; };
      set('.name', s.label);
      set('.what', parts.what);
      set('.when', parts.when);
      order.push(r.row);
    }
    for (const [id, r] of rows) {
      if (!sessions.some((s) => s.id === id)) { r.row.remove(); rows.delete(id); }
    }
    if (order.some((row, i) => list.children[i] !== row)) list.replaceChildren(...order);
    const working = sessions.filter((s) => s.state === 'working' && Date.now() - s.lastEventAt <= IDLE_MS).length;
    const needs = sessions.filter((s) => s.state === 'needs').length;
    $('actSummary').textContent = [needs && `${needs} waiting on you`, working && `${working} working`].filter(Boolean).join(' · ');
    $('act').classList.toggle('act-none', !sessions.length);
    $('actEmpty').innerHTML = activity.connected === 'off' || activity.connected === 'partial'
      ? 'Not connected<small>Turn on Connect Claude Code in island settings</small>'
      : 'No sessions yet<small>Claude Code sessions show up here</small>';
    activityBadge = { n: working + needs, warn: needs > 0 };
    renderDots();
  }

  window.island.onActivity((a) => {
    activity = a && Array.isArray(a.sessions) ? a : { connected: 'off', sessions: [] };
    renderActivity();
  });

  // Elapsed times tick while the Activity page is in view.
  setInterval(() => {
    if (body.classList.contains('open') && page === 2) renderActivity();
  }, 1000);

  window.island.snapshot().then((snap) => {
    if (snap.activity) activity = snap.activity;
    renderActivity();
  });
})();
