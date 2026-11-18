// Live-activity rules (activity/hub.js), driven with hook events and a fake islandctl.
const { test } = require('node:test');
const assert = require('node:assert');
const { Hub } = require('../activity/hub');

const ctl = { state: async () => ({ quns: 5, dnd: 0, fg: 0, fgRoot: 0 }), focus: async () => true };

// A hub whose peeks are recorded instead of scheduled.
function makeHub() {
  const hub = new Hub({ ctl });
  const adds = [];
  hub.add = (s, kind) => { adds.push([s.id, kind]); };
  return { hub, adds };
}

// ---- pipe lines -------------------------------------------------------------------

test('onLine passes subagent fields through, validated', () => {
  const hub = new Hub({ ctl });
  const got = [];
  hub.server = {}; // listening
  hub.onEvent = (e) => got.push(e);
  const line = (m) => hub.onLine(JSON.stringify({ v: 1, src: 'claude', session: 's1', t: Date.now(), ...m }));
  line({ event: 'SubagentStart', agentId: 'af44e017436eb004e', agent: 'Explore' });
  line({ event: 'UserPromptSubmit', notif: 1 });
  line({ event: 'Stop', bgAgents: ['ac85', 'bad id!', 'x'.repeat(41), 7] });
  line({ event: 'Stop' });
  line({ event: 'PostToolUse', agentId: 'not valid!', agent: 'y'.repeat(60) });
  assert.strictEqual(got[0].agentId, 'af44e017436eb004e');
  assert.strictEqual(got[0].agent, 'Explore');
  assert.strictEqual(got[0].notif, false);
  assert.strictEqual(got[1].notif, true);
  assert.deepStrictEqual(got[2].bgAgents, ['ac85']);
  assert.strictEqual(got[3].bgAgents, null);
  assert.strictEqual(got[4].agentId, '');
  assert.strictEqual(got[4].agent.length, 40);
});

test('SubagentStart is an accepted event', () => {
  const hub = new Hub({ ctl });
  const got = [];
  hub.server = {};
  hub.onEvent = (e) => got.push(e);
  hub.onLine(JSON.stringify({ v: 1, src: 'claude', session: 's1', event: 'SubagentStart', agentId: 'a1' }));
  assert.strictEqual(got.length, 1);
});

// ---- subagents ------------------------------------------------------------------------

const T0 = 1000;

// One hook event as onLine hands it to onEvent.
function ev(hub, event, t, extra = {}) {
  hub.onEvent({
    event, session: 's1', cwd: 'C:\\work\\island', ntype: '', message: '', tool: '',
    agentId: '', agent: '', notif: false, bgAgents: null, pid: 0, hwnd: 0, t, ...extra,
  });
}
const start = (hub, t, id, type = 'Explore') => ev(hub, 'SubagentStart', t, { agentId: id, agent: type });
const stopAgent = (hub, t, id, type = 'Explore') => ev(hub, 'SubagentStop', t, { agentId: id, agent: type });
const agentTool = (hub, t, id, tool = 'Read') => ev(hub, 'PostToolUse', t, { agentId: id, agent: 'Explore', tool });
const session = (hub) => hub.list()[0];
const agentsById = (hub) => Object.fromEntries(session(hub).agents.map((a) => [a.id, a]));

test('foreground parallel subagents: one finish, after the main Stop', () => {
  const { hub, adds } = makeHub();
  const states = [];
  const step = (fn) => { fn(); states.push(session(hub).state); };
  step(() => ev(hub, 'UserPromptSubmit', T0));
  step(() => start(hub, T0 + 100, 'A'));
  step(() => start(hub, T0 + 200, 'B'));
  step(() => agentTool(hub, T0 + 300, 'A'));
  step(() => agentTool(hub, T0 + 400, 'B'));
  step(() => stopAgent(hub, T0 + 500, 'A'));
  step(() => ev(hub, 'PostToolUse', T0 + 600, { tool: 'Agent' }));
  step(() => stopAgent(hub, T0 + 700, 'B'));
  step(() => ev(hub, 'PostToolUse', T0 + 800, { tool: 'Agent' }));
  assert.ok(!states.includes('finished'), states.join());
  ev(hub, 'Stop', T0 + 12000, { bgAgents: [] });
  const s = session(hub);
  assert.strictEqual(s.state, 'finished');
  assert.deepStrictEqual(adds, [['s1', 'finished']]);
  assert.strictEqual(s.agentsUsed, 2);
  assert.deepStrictEqual(s.agents.map((a) => a.state), ['done', 'done']);
});

test('background subagent: waiting, report-back, one finish counted from the first prompt', () => {
  const { hub, adds } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'Stop', T0 + 1000, { bgAgents: ['X'] });
  assert.strictEqual(session(hub).state, 'waiting');
  assert.deepStrictEqual(adds, []);
  agentTool(hub, T0 + 2000, 'X', 'Read');
  assert.strictEqual(session(hub).state, 'waiting');
  assert.strictEqual(agentsById(hub).X.tool, 'Read');
  stopAgent(hub, T0 + 3000, 'X');
  assert.strictEqual(session(hub).state, 'waiting');
  ev(hub, 'UserPromptSubmit', T0 + 3100, { notif: true });
  assert.strictEqual(session(hub).state, 'working');
  assert.strictEqual(session(hub).turnStart, T0);
  ev(hub, 'Stop', T0 + 15000, { bgAgents: [] });
  assert.strictEqual(session(hub).state, 'finished');
  assert.strictEqual(session(hub).durationMs, 15000);
  assert.deepStrictEqual(adds, [['s1', 'finished']]);
});

test('a missed SubagentStop: Stop without the agent in background_tasks ends it', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'Stop', T0 + 12000, { bgAgents: [] });
  assert.strictEqual(agentsById(hub).X.state, 'done');
  assert.strictEqual(session(hub).state, 'finished');
});

test('Stop from a Claude Code without background_tasks finishes when no agent runs', () => {
  const { hub, adds } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  stopAgent(hub, T0 + 200, 'X');
  ev(hub, 'Stop', T0 + 12000);
  assert.strictEqual(session(hub).state, 'finished');
  assert.deepStrictEqual(adds, [['s1', 'finished']]);
});

test('a typed prompt while a background agent runs: new task, the agent stays', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  start(hub, T0 + 150, 'Y');
  stopAgent(hub, T0 + 200, 'Y');
  ev(hub, 'Stop', T0 + 1000, { bgAgents: ['X'] });
  ev(hub, 'UserPromptSubmit', T0 + 5000);
  const s = session(hub);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.turnStart, T0 + 5000);
  assert.deepStrictEqual(s.agents.map((a) => [a.id, a.state]), [['X', 'running']]);
  assert.strictEqual(s.agentsUsed, 1);
});

test('a subagent permission prompt: session needs you until that agent moves on', () => {
  const { hub, adds } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'PermissionRequest', T0 + 200, { agentId: 'X', agent: 'Explore', tool: 'Bash' });
  ev(hub, 'Notification', T0 + 300, { ntype: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  let s = session(hub);
  assert.strictEqual(s.state, 'needs');
  assert.strictEqual(s.tool, 'Bash');
  assert.strictEqual(agentsById(hub).X.state, 'needs');
  assert.deepStrictEqual(adds, [['s1', 'needs']]);
  ev(hub, 'PostToolUse', T0 + 400, { tool: 'Grep' }); // the main agent, not the one asking
  assert.strictEqual(session(hub).state, 'needs');
  agentTool(hub, T0 + 500, 'X', 'Bash');
  s = session(hub);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(agentsById(hub).X.state, 'running');
});

test('a subagent permission prompt while waiting goes back to waiting', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'Stop', T0 + 1000, { bgAgents: ['X'] });
  ev(hub, 'PermissionRequest', T0 + 2000, { agentId: 'X', agent: 'Explore', tool: 'Bash' });
  ev(hub, 'Notification', T0 + 2100, { ntype: 'permission_prompt' });
  assert.strictEqual(session(hub).state, 'needs');
  agentTool(hub, T0 + 3000, 'X', 'Bash');
  assert.strictEqual(session(hub).state, 'waiting');
});

test('while waiting, a prompt with no known asker is an agent\'s: its next tool event clears it', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'Stop', T0 + 1000, { bgAgents: ['X'] });
  ev(hub, 'Notification', T0 + 30000, { ntype: 'permission_prompt' }); // no PermissionRequest seen
  assert.strictEqual(session(hub).state, 'needs');
  agentTool(hub, T0 + 31000, 'X', 'Bash');
  assert.strictEqual(session(hub).state, 'waiting');
});

test('the main agent asking: an agent event does not clear it, a main one does', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'PermissionRequest', T0 + 200, { tool: 'Edit' });
  ev(hub, 'Notification', T0 + 300, { ntype: 'permission_prompt' });
  assert.strictEqual(session(hub).tool, 'Edit');
  agentTool(hub, T0 + 400, 'X');
  assert.strictEqual(session(hub).state, 'needs');
  ev(hub, 'PostToolUse', T0 + 500, { tool: 'Edit' });
  assert.strictEqual(session(hub).state, 'working');
});

test('island started mid-task: a subagent event starts the turn, the Stop peeks', () => {
  const { hub, adds } = makeHub();
  agentTool(hub, T0, 'X');
  const s = session(hub);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.turnStart, T0);
  assert.deepStrictEqual(s.agents.map((a) => [a.id, a.state]), [['X', 'running']]);
  ev(hub, 'Stop', T0 + 12000, { bgAgents: [] });
  assert.deepStrictEqual(adds, [['s1', 'finished']]);
});

test('waiting with no agent left and no report-back finishes after 60 s', () => {
  const { hub, adds } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'Stop', T0 + 1000, { bgAgents: ['X'] });
  const T = T0 + 20000;
  stopAgent(hub, T, 'X');
  hub.sweep(T + 59000);
  assert.strictEqual(session(hub).state, 'waiting');
  hub.sweep(T + 61000);
  assert.strictEqual(session(hub).state, 'finished');
  assert.deepStrictEqual(adds, [['s1', 'finished']]);
});

test('SessionEnd ends running agents', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 100, 'X');
  ev(hub, 'SessionEnd', T0 + 500);
  assert.strictEqual(agentsById(hub).X.state, 'done');
});

test('labels: agent type, general-purpose as Agent, repeats numbered', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  start(hub, T0 + 1, 'A', 'Explore');
  start(hub, T0 + 2, 'B', 'Explore');
  start(hub, T0 + 3, 'C', 'general-purpose');
  assert.deepStrictEqual(session(hub).agents.map((a) => a.label), ['Explore', 'Explore 2', 'Agent']);
});

test('at most 20 agents per session, done ones dropped first', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  for (let i = 0; i < 10; i++) start(hub, T0 + i, `a${i}`);
  for (let i = 0; i < 5; i++) stopAgent(hub, T0 + 20 + i, `a${i}`);
  for (let i = 10; i < 25; i++) start(hub, T0 + 30 + i, `a${i}`);
  const ids = session(hub).agents.map((a) => a.id);
  assert.strictEqual(ids.length, 20);
  for (let i = 0; i < 5; i++) assert.ok(!ids.includes(`a${i}`), `a${i} kept`);
  for (let i = 5; i < 25; i++) assert.ok(ids.includes(`a${i}`), `a${i} dropped`);
});

test('the finished peek carries how many agents the task used', () => {
  const { hub } = makeHub();
  ev(hub, 'UserPromptSubmit', T0);
  for (const id of ['A', 'B', 'C']) { start(hub, T0 + 1, id); stopAgent(hub, T0 + 2, id); }
  ev(hub, 'Stop', T0 + 12000, { bgAgents: [] });
  assert.strictEqual(hub.payload({ key: 1, session: 's1', kind: 'finished', held: false, chimed: false }).agents, 3);
});

module.exports = { makeHub };
