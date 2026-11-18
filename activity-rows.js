// Which subagent lines show under a Claude Code session on the island's
// Claude Code page. No DOM: activity-view.js draws what this picks.
// Loaded as a plain script (window.agentLines) and, for tests, by Node.

(function (root) {
  const FOLD_MS = 10 * 1000;      // a done agent keeps its line this long, then folds into the count
  const IDLE_MS = 2 * 60 * 1000;  // no events for this long: probably stopped (Esc sends no event)
  const MAX_LINES = 3;            // per session; more show as "+N more"

  const ORDER = { needs: 0, running: 1, idle: 1, done: 2 };

  // agents: the session's agents from the hub ({ id, label, state, tool,
  // startedAt, endedAt, lastEventAt }). Returns the lines to draw, each with
  // `show` (running, needs, idle, done), how many more are hidden, how many
  // done ones folded, and how many run (idle ones apart).
  function agentLines(agents, now) {
    const out = { shown: [], hidden: 0, folded: 0, running: 0, idle: 0 };
    const visible = [];
    for (const a of Array.isArray(agents) ? agents : []) {
      let show = a.state;
      if (show === 'done') {
        if (now - a.endedAt > FOLD_MS) { out.folded++; continue; }
      } else if (show === 'running' && now - a.lastEventAt > IDLE_MS) {
        show = 'idle';
      }
      if (show === 'running' || show === 'needs') out.running++;
      if (show === 'idle') out.idle++;
      visible.push({ ...a, show });
    }
    visible.sort((x, y) => (ORDER[x.show] - ORDER[y.show])
      || (x.show === 'done' ? y.endedAt - x.endedAt : x.startedAt - y.startedAt));
    out.shown = visible.slice(0, MAX_LINES);
    out.hidden = visible.length - out.shown.length;
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { agentLines, FOLD_MS, IDLE_MS, MAX_LINES };
  else root.agentLines = agentLines;
})(typeof window !== 'undefined' ? window : globalThis);
