# Subagents on the Claude Code page: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Claude Code subagent as its own line under its session, and keep the session in progress ("waiting on N agents") until its subagents are done, so it finishes and peeks once per task.

**Architecture:** `islandctl.exe hook` forwards three more facts per event (`agentId`, a report-back flag, the running background subagents from `Stop`). `activity/hub.js` routes events with an `agentId` to a per-session agent map instead of the main state, adds a `waiting` session state, and lists agents. A small UMD module (`activity-rows.js`, like `paging.js`) picks which agent lines show; `activity-view.js` draws them.

**Tech Stack:** Electron 45, plain JS (CommonJS in main, browser scripts in the page), C# 5 helper compiled by Windows' `csc.exe`, tests with `node --test` (no dependencies).

**Spec:** `docs/superpowers/specs/2026-11-18-subagents-design.md`

## Global Constraints

- C# 5 only in `islandctl.cs`: no `$""`, no `?.`. `islandctl` prints nothing in `hook` mode and always exits 0.
- The prompt text is never forwarded; only `notif: 1` when `prompt` starts with `<task-notification>`.
- Only `background_tasks` entries with `type` `subagent` and `status` `running` count. Shells, monitors and teammates never keep a session waiting.
- Labels: agent type; `general-purpose` shows as `Agent`; repeats in a session numbered `Explore 2`.
- Timings: done agent line stays 10 s; agent idle after 2 min without events; waiting session with no agent left finishes after 60 s without a main-agent event; at most 3 agent lines, then `+N more` (`· M done` when some folded); at most 20 agents kept per session.
- Page stays 380x140; session row 30 px, agent line 22 px, more line 18 px.
- New hook `SubagentStart`. A connection missing only events added after 0.4 is rewritten by island itself when all its hooks point at island's own `islandctl.exe`.
- Version 0.5.0. Build file list in `package.json` gets `activity-rows.js`.
- Do not change Yatin's `~/.claude/settings.json` from a test or the dev copy (tests use `CLAUDE_CONFIG_DIR`).

## Review Focus

- A user prompt typed while a background subagent still runs: the agent stays listed and running; the session is a new task (test in Task 2).
- A subagent's permission prompt while the main agent keeps working: a main-agent tool event must not clear the subagent's needs-you (test in Task 2).
- `Stop` from an older Claude Code with no `background_tasks`: behaves like today (no `bgAgents` field: no reconcile; finishes when no known agent runs) (test in Task 2).
- Island restarted mid-task, first event is a subagent's tool event: session working, agent created, later `Stop` peeks (test in Task 2).
- Long-running background shell (`type: "shell"`) in `background_tasks`: session finishes normally (test in Task 1, probe ignores it).

---

### Task 1: islandctl forwards agentId, notif, bgAgents

**Files:**
- Modify: `activity/islandctl.cs` (`Wanted`, `Hook`, new `RunningSubagents`)
- Modify: `activity/hub.js` (`onLine` validation only)
- Create: `test/islandctl.test.js`
- Modify: `package.json` (`"test": "node --test test/"`)

**Interfaces:**
- Produces (pipe line fields): `agentId` string (≤ 40), `agent` string (existing), `notif` number `1` (only when set), `bgAgents` JSON array of id strings (only when the hook JSON has `background_tasks`; may be `[]`).
- Produces (`hub.onEvent` input `e`): `agentId` (`''` or `/^[\w-]{1,40}$/`), `agent` (≤ 40 chars), `notif` (boolean), `bgAgents` (`null` or array of ≤ 20 valid ids).

- [ ] **Step 1: Write the failing test** `test/islandctl.test.js`: builds via `require('../activity/helper').build()`, runs `islandctl.exe probe` with stdin JSON, parses the printed line. Cases:
  - `SubagentStart` with `agent_id: "af44e017436eb004e"`, `agent_type: "Explore"` -> `agentId === 'af44e017436eb004e'`, `agent === 'Explore'`.
  - `UserPromptSubmit` with `prompt: "<task-notification>\n<task-id>x</task-id>"` -> `notif === 1`, and the printed line does not contain `task-id`.
  - `UserPromptSubmit` with `prompt: "fix the bug"` -> no `notif`, line does not contain `fix the bug`.
  - `Stop` with `background_tasks: [{id:"ac85",type:"subagent",status:"running"},{id:"sh1",type:"shell",status:"running"},{id:"old",type:"subagent",status:"completed"}]` -> `bgAgents` deep-equals `['ac85']`.
  - `Stop` with `background_tasks: []` -> `bgAgents` deep-equals `[]`; `Stop` without the key -> `bgAgents === undefined`.
- [ ] **Step 2: Run** `node --test test/islandctl.test.js` - expect FAIL (fields missing).
- [ ] **Step 3: Implement** in `islandctl.cs`: add `agent_id`, `prompt` to `Wanted`; `Field(sb, "agentId", Get(f, "agent_id"), 40)`; `notif` from `prompt.StartsWith("<task-notification>", StringComparison.Ordinal)`; `static List<string> RunningSubagents(string json)` that finds the top-level `background_tasks` array (same top-level walk as `TopLevelStrings`), and for each object element reads `id`/`type`/`status` with `TopLevelStrings(element, ...)`; emit `"bgAgents":[...]` (escaped like `Field`) when the key exists. `TopLevelStrings` grows an out-param or sibling that reports the array's span; keep everything else skipped.
- [ ] **Step 4: Implement** `onLine` in `hub.js`: pass `agentId`, `agent`, `notif`, `bgAgents` with the validation above.
- [ ] **Step 5: Run** `node --test test/islandctl.test.js` - PASS.
- [ ] **Step 6: Commit** `islandctl: forward subagent id, report-backs and running background subagents`.

### Task 2: hub rules for agents and the waiting state

**Files:**
- Modify: `activity/hub.js`
- Create: `test/hub.test.js`

**Interfaces:**
- Consumes: Task 1 event fields.
- Produces: session state `'waiting'`; `list()` items add `agents: Agent[]` and `agentsUsed: number` (and drop `subagents`), where `Agent = { id, label, type, state: 'running'|'needs'|'done', tool, startedAt, endedAt, lastEventAt }`; peek payload adds `agents: number` (`agentsUsed`, finished/failed only); `sweep(now = Date.now())`.

- [ ] **Step 1: Write the failing tests** `test/hub.test.js` with a fake `ctl` (`state()` -> `{ quns: 5, dnd: 0, fg: 0, fgRoot: 0 }`), `hub.add` replaced by a recorder of `[sessionId, kind]`, events fed to `hub.onEvent` with explicit `t`. Tests:
  - `foreground parallel`: the recorded order (Prompt t0; Start A, Start B; A/B tool events; Stop A; main PostToolUse Agent; Stop B; main Stop at t0+12000 with `bgAgents: []`) -> state never `finished` before the main Stop; after it `finished`, one `finished` add; `agentsUsed === 2`; both agents `done`.
  - `background with report-back`: Prompt t0; Start X; main Stop t0+1000 `bgAgents: ['X']` -> `waiting`, no add; X PostToolUse -> still `waiting`, X.tool `Read`; Stop X -> `waiting`; Prompt `notif` -> `working`, `turnStart === t0`; main Stop t0+15000 `bgAgents: []` -> `finished`, `durationMs === 15000`, exactly one `finished` add.
  - `missed SubagentStop`: X running, main Stop `bgAgents: []` -> X `done`, session `finished`.
  - `old Claude Code Stop` (no `bgAgents`) with no running agents -> `finished`.
  - `user prompt while background agent runs`: waiting with X running; user Prompt (no notif) -> `working`, X still `running`, done agents removed, `agentsUsed === 1`.
  - `subagent permission`: PermissionRequest `agentId: X, tool: 'Bash'`; Notification `permission_prompt` (no agentId) -> session `needs`, `tool === 'Bash'`, X `needs`, one `needs` add; main PostToolUse -> still `needs`; X PostToolUse -> session back to `working`, X `running`.
  - `subagent permission while waiting` -> clears back to `waiting`.
  - `mid-task start`: first event ever is X PostToolUse -> session `working`, X created `running`; main Stop t+12000 `bgAgents: []` -> one `finished` add.
  - `safety net`: waiting, last agent Stop at T; `sweep(T + 59000)` -> `waiting`; `sweep(T + 61000)` -> `finished`.
  - `labels`: Start `Explore`, `Explore`, `general-purpose` -> labels `Explore`, `Explore 2`, `Agent`.
  - `cap`: 25 Starts -> `list()[0].agents.length === 20`, done ones dropped first.
  - `peek payload`: after a finished task with 3 agents, `hub.payload(p).agents === 3`.
- [ ] **Step 2: Run** `node --test test/hub.test.js` - expect FAIL.
- [ ] **Step 3: Implement** in `hub.js`:
  - session fields `agents` (Map), `agentsUsed`, `mainDone`, `needsAgent`, `asker` (`{ id, at }` or null), `waitDoneAt`; drop `subagents`.
  - `agentFor(s, e)` creates/returns the agent (label rule; cap 20, oldest done first); `onAgentEvent(s, e)` for any event with `agentId`; main events go through the existing switch.
  - `finish(s, t, failed)` shared by Stop, StopFailure and the safety net (marks remaining agents `done` only for SessionEnd/closed, not for finish).
  - `back(s)` -> `s.state = s.mainDone && hasActive(s) ? 'waiting' : 'working'` used when needs clears.
  - Notification asker rule: `e.agentId`, else `s.asker` if `e.t - s.asker.at < 10000`, else main.
  - Main events clear needs only when `!s.needsAgent`; agent events only when `s.needsAgent === agent id`.
  - `midTurn` also for `waiting` (main resumed: `working`, keeps `turnStart`).
  - `sweep(now)` adds the 60 s safety net; `rank('waiting') === 1`.
  - `payload` adds `agents`.
- [ ] **Step 4: Run** `node --test test/` - PASS.
- [ ] **Step 5: Commit** `Hub: subagents as their own entries; sessions wait for them before finishing`.

### Task 3: hooks connection gets SubagentStart, old connections upgrade themselves

**Files:**
- Modify: `activity/claude-hooks.js` (`EVENTS`, new `upgrade(exe)`)
- Modify: `main.js` (`refreshClaude` calls it when `ctlExe` is known; result to `diag` and `log`)
- Create: `test/claude-hooks.test.js`

**Interfaces:**
- Produces: `upgrade(exe) -> boolean` (true when it rewrote the hooks).

- [ ] **Step 1: Write the failing test** (sets `process.env.CLAUDE_CONFIG_DIR` to a temp dir before requiring): a settings file with island's hooks for every event except `SubagentStart`, all `command` = `C:\x\islandctl.exe`, plus a foreign hook -> `status('C:\\x\\islandctl.exe') === 'partial'`; `upgrade('C:\\x\\islandctl.exe') === true`; then `status(...) === 'on'` and the foreign hook is still there. Same file but commands = `C:\other\islandctl.exe` -> `upgrade('C:\\x\\islandctl.exe') === false`, file unchanged. A file missing `Stop` (an old event) -> `upgrade` false.
- [ ] **Step 2: Run** - FAIL.
- [ ] **Step 3: Implement** `NEW_EVENTS = ['SubagentStart']`; `upgrade(exe)`: read, collect our hooks per event; true path only when found is non-empty, every found command resolves to `exe`, and every missing event is in `NEW_EVENTS`; then `connect(exe)`.
- [ ] **Step 4: Wire** `main.js` `refreshClaude`: when `ctlExe && claudeStatus === 'partial' && claudeHooks.upgrade(ctlExe)` -> re-read status, `diag.write('claude hooks upgraded')`.
- [ ] **Step 5: Run** `node --test test/` - PASS. **Commit** `Claude Code hooks: SubagentStart; 0.4 connections upgrade themselves`.

### Task 4: agent lines on the page, summary and peek text

**Files:**
- Create: `activity-rows.js` (UMD like `paging.js`: `window.agentLines` / `module.exports.agentLines`)
- Modify: `activity-view.js` (`rowParts`, `renderActivity`, `peekParts`, summary)
- Modify: `island.html` (load `activity-rows.js` before `activity-view.js`; CSS `.act-row.sub`, `.tree`, `.act-row.more`)
- Modify: `package.json` (`files` + `activity-rows.js`)
- Create: `test/activity-rows.test.js`

**Interfaces:**
- Consumes: Task 2 `list()` items.
- Produces: `agentLines(agents, now) -> { shown: Array<Agent & { show: 'running'|'needs'|'done'|'idle' }>, hidden: number, folded: number, running: number }`.

- [ ] **Step 1: Write the failing test** `test/activity-rows.test.js`: done 5 s ago shown with `show: 'done'`, done 11 s ago not shown and `folded === 1`; order needs, running (oldest `startedAt` first), done; 5 active -> 3 shown, `hidden === 2`; running with `lastEventAt` 121 s ago -> `show: 'idle'` and not counted in `running`.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement** `agentLines`. **Step 4: Run** - PASS.
- [ ] **Step 5: Implement the view:** session row texts per spec (`working · 2 agents`, `waiting on 3 agents`, idle when the session is waiting and every active agent is idle, `finished in 3m · 4 agents`); one 22 px line per shown agent with the tree span (`last` class on the final one when no more line), 12 px icon (spin / warn / ok / dim), label, what (`tool` or `working`, `needs you · <tool>`, `done`, `idle`), when (elapsed since `startedAt`, or `endedAt - startedAt` for done); the 18 px more line `+N more` (`· M done`); clicking any line jumps to the session (`activityJump`); no x/go buttons on agent lines; header summary adds `· N agents` (running across sessions) and counts waiting as working; badge counts waiting; pill detail `3m 10s · 4 agents` when `p.agents`.
- [ ] **Step 6: Verify offscreen:** scratch harness (from `scripts/readme-images.js`) sends an `activity` payload with the two mock scenes from the spec; screenshots match the mockups' structure; elapsed times tick.
- [ ] **Step 7: Commit** `Claude Code page: subagent lines under their session`.

### Task 5: end to end, docs, release build

**Files:**
- Modify: `SECURITY.md`, `README.md` (Claude Code section), `docs/ARCHITECTURE.md`, `CLAUDE.md`, `package.json` (`0.5.0`)

- [ ] **Step 1: End to end:** installed island quit; dev island running (`ISLAND_DEBUG=1`, `--remote-debugging-port=9333`); `claude -p --settings <scratch>` whose hooks run `activity/bin/islandctl.exe hook` for every island event, with `--setting-sources project,local`; prompts: two parallel Explore subagents; one background subagent with report-back. Log shows `waiting` then one `finished`; CDP screenshots of the Activity page during the run show the agent lines.
- [ ] **Step 2: Docs** per spec (SECURITY row for islandctl adds agent id/type and running background subagent ids; README one line; ARCHITECTURE hub rules; CLAUDE.md summary + what is untested).
- [ ] **Step 3: Version 0.5.0, `bun run dist`, install silently, verify** the installed app upgrades the hooks (`island.log` line `claude hooks upgraded`, settings flyout shows Claude Code on). Commit `Release 0.5.0`. Do not publish the GitHub release until Yatin has seen it (a real permission prompt inside a subagent is untested).
