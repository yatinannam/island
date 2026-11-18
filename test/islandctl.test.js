// islandctl.exe probe: what a hook event turns into on the pipe.
// Builds activity/bin/islandctl.exe with Windows' csc.exe when it is out of date.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { build } = require('../activity/helper');

let exe;
before(async () => { exe = await build(); });

function probe(hook) {
  const r = spawnSync(exe, ['probe'], { input: JSON.stringify(hook), encoding: 'utf8' });
  const line = r.stdout.trim();
  return { line, m: JSON.parse(line) };
}

const base = { session_id: 's1', cwd: 'C:\\work\\island' };

test('SubagentStart forwards the agent id and type', () => {
  const { m } = probe({ ...base, hook_event_name: 'SubagentStart', agent_id: 'af44e017436eb004e', agent_type: 'Explore' });
  assert.strictEqual(m.agentId, 'af44e017436eb004e');
  assert.strictEqual(m.agent, 'Explore');
});

test('a report-back prompt sets notif and its text is not forwarded', () => {
  const { m, line } = probe({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>' });
  assert.strictEqual(m.notif, 1);
  assert.ok(!line.includes('task-id'), line);
});

test('a typed prompt sets no notif and is not forwarded', () => {
  const { m, line } = probe({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' });
  assert.strictEqual(m.notif, undefined);
  assert.ok(!line.includes('fix the bug'), line);
});

test('Stop lists only running background subagents', () => {
  const { m } = probe({
    ...base,
    hook_event_name: 'Stop',
    background_tasks: [
      { id: 'ac85', type: 'subagent', status: 'running', description: 'Read "c.txt"', agent_type: 'Explore' },
      { id: 'sh1', type: 'shell', status: 'running', description: 'dev server' },
      { id: 'old', type: 'subagent', status: 'completed', agent_type: 'Plan' },
    ],
    session_crons: [],
  });
  assert.deepStrictEqual(m.bgAgents, ['ac85']);
});

test('Stop with no background tasks gives an empty list; without the field, none', () => {
  assert.deepStrictEqual(probe({ ...base, hook_event_name: 'Stop', background_tasks: [] }).m.bgAgents, []);
  assert.strictEqual(probe({ ...base, hook_event_name: 'Stop' }).m.bgAgents, undefined);
});

test('big nested tool input is still skipped', () => {
  const { m } = probe({
    ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'a1',
    tool_input: { file_path: 'x', nested: [{ background_tasks: [{ id: 'nope', type: 'subagent', status: 'running' }] }] },
    tool_response: 'x'.repeat(200000),
  });
  assert.strictEqual(m.tool, 'Read');
  assert.strictEqual(m.agentId, 'a1');
  assert.strictEqual(m.bgAgents, undefined);
});
