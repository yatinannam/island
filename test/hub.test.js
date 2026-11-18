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

module.exports = { makeHub };
