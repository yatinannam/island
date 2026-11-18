// Which subagent lines show under a session (activity-rows.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { agentLines } = require('../activity-rows');

const NOW = 1_000_000;
const agent = (id, state, extra = {}) => ({
  id, label: id, type: 'Explore', state, tool: '', startedAt: NOW - 60000, endedAt: 0, lastEventAt: NOW - 1000, ...extra,
});

test('a done agent shows for 10 s, then folds into the count', () => {
  const r = agentLines([
    agent('a', 'done', { endedAt: NOW - 5000 }),
    agent('b', 'done', { endedAt: NOW - 11000 }),
  ], NOW);
  assert.deepStrictEqual(r.shown.map((a) => [a.id, a.show]), [['a', 'done']]);
  assert.strictEqual(r.folded, 1);
  assert.strictEqual(r.hidden, 0);
});

test('order: needs, then running oldest first, then done', () => {
  const r = agentLines([
    agent('done1', 'done', { endedAt: NOW - 1000 }),
    agent('young', 'running', { startedAt: NOW - 10000 }),
    agent('old', 'running', { startedAt: NOW - 50000 }),
    agent('asks', 'needs'),
  ], NOW);
  assert.deepStrictEqual(r.shown.map((a) => a.id), ['asks', 'old', 'young']);
  assert.strictEqual(r.hidden, 1);
  assert.strictEqual(r.running, 3);
});

test('at most 3 lines; the rest counted as hidden', () => {
  const r = agentLines(['a', 'b', 'c', 'd', 'e'].map((id, i) => agent(id, 'running', { startedAt: NOW - 1000 * (10 - i) })), NOW);
  assert.strictEqual(r.shown.length, 3);
  assert.strictEqual(r.hidden, 2);
});

test('no events for 2 minutes: idle, and not counted as running', () => {
  const r = agentLines([
    agent('quiet', 'running', { lastEventAt: NOW - 121000 }),
    agent('busy', 'running'),
  ], NOW);
  assert.deepStrictEqual(r.shown.map((a) => [a.id, a.show]), [['quiet', 'idle'], ['busy', 'running']]);
  assert.strictEqual(r.running, 1);
  assert.strictEqual(r.idle, 1);
});

test('no agents: nothing to show', () => {
  assert.deepStrictEqual(agentLines([], NOW), { shown: [], hidden: 0, folded: 0, running: 0, idle: 0 });
  assert.deepStrictEqual(agentLines(undefined, NOW), { shown: [], hidden: 0, folded: 0, running: 0, idle: 0 });
});
