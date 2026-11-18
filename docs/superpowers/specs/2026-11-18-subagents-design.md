# Subagents on the Claude Code page: design

2026-11-18. Approved approach and rules: Yatin. Calls marked *(my call)* are Claude's and open to correction.

## Why

When a Claude Code session runs subagents, its row on the island's Claude Code page flips between working, finished and working again. Yatin finds that confusing. He wants the subagents shown as their own lines under the main session, so it is clear they run independently of it. His sketch: the session row, and under it, indented with a tree connector, `agent 1  working`.

## What Claude Code sends (recorded 2026-11-18, Claude Code 2.1.327)

Recorded with a throwaway `claude -p` and logging-only hooks (scratch settings file, user settings not loaded):

- Every event of a session, subagents included, carries the **main session's `session_id`**. Events fired inside a subagent also carry `agent_id` (e.g. `af44e017436eb004e`) and `agent_type` (`Explore`, `Plan`, `general-purpose`, ...). The main agent's own events have neither.
- `SubagentStart` (`agent_id`, `agent_type`) fires when a subagent starts; `SubagentStop` (same, plus `last_assistant_message`, `background_tasks`) when it ends.
- Foreground subagents (two in parallel): `PreToolUse Agent`, `SubagentStart A`, `PreToolUse Agent`, `SubagentStart B`, A's and B's tool events interleaved, `SubagentStop A`, `PostToolUse Agent` (main), `SubagentStop B`, `PostToolUse Agent`, then the main `Stop` with `background_tasks: []`.
- Background subagent: `SubagentStart`, then the **main `Stop` while it still runs**, with `background_tasks: [{"id": "<agent_id>", "type": "subagent", "status": "running", "description": "Read c.txt word", "agent_type": "Explore"}]`. Then the subagent's tool events, `SubagentStop`, then a **`UserPromptSubmit` whose `prompt` starts with `<task-notification>`** (the subagent reporting back, not the user typing), and a final `Stop` with `background_tasks: []`.

Why the row flips today: `islandctl` drops `agent_id`, so `hub.js` applies subagent events to the main row. After the main `Stop` ("finished", maybe a peek), the background subagent's next tool event looks like the start of a missed turn (`midTurn`, "working"), the report-back `UserPromptSubmit` starts a new turn and resets the subagent counter, and the final `Stop` finishes it again.

## Goals

- The session row shows the main agent only. Each subagent gets its own line under it with its own state.
- One "finished" per task (Yatin chose this): while subagents still run after the main agent's reply, the session stays in progress ("waiting on N agents"). It finishes, and peeks under the existing rules, once, after the last one is done and the main agent has wrapped up.
- Works for foreground (also parallel) and background subagents.

## Non-goals

- Agent teams / teammates, background shells and monitors as lines (only `type: "subagent"`). A long-running background shell must not keep a session "waiting" forever.
- Subagent descriptions as labels ("Read c.txt word"): only `background_tasks` has them, and only for background agents. Labels are the agent type *(my call; can come later)*.
- Clicking a single subagent line to do something of its own: it jumps to the session's terminal like the session row.

## Anti-goals

- The session row flipping between finished and working within one task.
- A peek or chime per subagent.
- The island changing size: the page stays 380x140; the list scrolls.

## Approaches

1. **Track subagents from hook events** (picked). `SubagentStart`/`SubagentStop` and `agent_id` on tool events maintain each session's subagents; the main `Stop`'s `background_tasks` is the truth for which are still running; the `<task-notification>` prefix marks a report-back. Cheap, uses data Claude Code already sends, one new hook (`SubagentStart`).
2. Read subagent transcripts (`<session>/subagents/agent-<id>.jsonl`). More detail (descriptions, progress), but file polling, path guessing and reading conversation content island has so far never touched. Rejected.
3. Only stop the flipping (ignore subagent events for the session's state, add the waiting state) without lines. Smaller, but not what Yatin asked for. Rejected.

## Behavior

### State

Per session, as today, plus:

- A new session state **`waiting`**: the main agent has replied but subagents of this task still run. Shown with the working spinner; counts as working in the header summary, the dot badge and the list order (same rank as working); never peeks. Any event of the session, subagents' included, keeps its `lastEventAt` fresh, so a session busy only in subagents does not go idle.
- `agents`: a map `agent_id -> { type, label, state, tool, startedAt, lastEventAt, endedAt, askTool }`, `state` one of `running`, `needs`, `done`. At most 20 per session; the oldest done ones go first *(my call)*.
- `agentsUsed`: how many subagents this task ran (for "finished in 3m · 4 agents"). Reset when the user starts a new task.

### Events

- **`SubagentStart`**: add the agent as `running`. If the session is not working, needs or waiting, it becomes working with `turnStart` now (island started mid-task, as `midTurn` does today).
- **Any event with `agent_id`** (tool events, permission events, `SubagentStop`): belongs to that agent, never to the main agent. Unknown id: the agent is created (island started mid-run). Tool events set its `tool` and `lastEventAt`. They do not change the session's main state, except for needs-you (below) and the mid-task start (as above).
- **`SubagentStop`**: the agent is `done`. If the session is `waiting` and no agent runs any more, it stays `waiting` for the report-back; if no main-agent event comes within 60 s, it finishes then *(my call: a safety net, never seen in the recording)*.
- **`UserPromptSubmit` that is a report-back** (`<task-notification>` prefix): the same task goes on. The session becomes working; `turnStart`, `agentsUsed` and the agents stay.
- **`UserPromptSubmit` from the user**: a new task, as today (`turnStart` now, needs cleared). Done agents are cleared; running ones stay (a background agent can outlive the turn that started it).
- **Main `Stop`**: `background_tasks` running subagent ids are the truth. Agents island thinks are running but are not listed become `done` (a missed `SubagentStop`). If any are listed, the session becomes `waiting` (no peek). Otherwise it finishes as today: duration from `turnStart`, finished peek when the task ran 10 s or more and its terminal is not in front.
- **`StopFailure`**: as today ("ended on an error"); agents are left as they are.
- **`SessionEnd`, or the Claude process gone**: all agents `done`, as the session closes.
- **Needs you inside a subagent**: a `PermissionRequest` with `agent_id` stores the tool on that agent and remembers it as the asker. The `Notification` (`permission_prompt`) that follows makes the session `needs` (amber, peeks as today) and the asking agent `needs`. If the `Notification` itself carries `agent_id`, that is used instead (not recorded: `claude -p` shows no prompts). The agent's next tool event (`PostToolUse`, `PostToolUseFailure`, `PermissionDenied`) clears both, back to working (or waiting).
- **Idle**: an agent with no events for 2 minutes shows as idle (dim), like the session row today. A session that is waiting with only idle agents shows as idle.

### Page

Mockups (real `island.html`, glass, mock rows): `images/subagents-waiting.png`, `images/subagents-needs.png`.

![waiting on agents](images/subagents-waiting.png)
![a subagent needs you](images/subagents-needs.png)

- The session row (30 px) keeps its layout. Its text: working `working` (`working · 2 agents` while agents run); waiting `waiting on 3 agents`; needs `needs you · Bash`; finished `finished in 3m · 4 agents` (agents part only when the task used any).
- Under it, one line per agent (22 px), Yatin's tree connector (`├`, `└` drawn as lines), a 12 px status icon, the label, what it is doing, and how long. Label: the agent type, `general-purpose` shown as `Agent`, repeats numbered (`Explore`, `Explore 2`) within the session *(my call)*. What: the last tool it used, `needs you · Bash`, or `done`. When: time since it started; for done ones, how long it ran.
- A done agent keeps its line with a check for 10 s, then folds into the session row's count *(my call)*.
- At most 3 agent lines per session, needs first, then running (oldest first), then done; more show as one 18 px line `+2 more · 1 done` *(my call)*. The list scrolls as today.
- Agent lines have no x and no arrow; clicking one jumps to the session's terminal.
- Header summary: `1 working · 3 agents` (agents = running across sessions), `1 needs you · ...` as today.
- Peeks and banners: no new kinds. The finished peek reads `island finished · 3m 10s · 4 agents`.

## Pipeline changes

- **`activity/islandctl.cs`**: also forwards `agent_id` (as `agentId`, at most 40 chars), a `notif: 1` flag when `prompt` starts with `<task-notification>` (the prompt itself is never forwarded), and `bgAgents`: the ids of `background_tasks` entries with `type` `subagent` and `status` `running`, comma-separated. The scanner reads that one array; everything else stays skipped.
- **`activity/claude-hooks.js`**: `SubagentStart` joins `EVENTS`. Existing connections then read as `partial`; island reconnects them by itself (rewrites its own hooks) when every hook it already has points at its own `islandctl.exe` and only events added since are missing *(my call: otherwise every 0.4 user sees "Not fully connected" after the update)*. Logged in `island.log`.
- **`activity/hub.js`**: the rules above; `list()` adds `waiting`, `agentsUsed` and the visible agents.
- **`activity-view.js`, `island.html`**: the lines, the summary, the peek text.
- **Docs**: `SECURITY.md` (islandctl also forwards the agent id and type, and running background agent ids), README Claude Code section, `docs/ARCHITECTURE.md`, `CLAUDE.md`.
- Version 0.5.0.

## Testing

- Hub rules in Node with a fake `ctl`, fed the recorded sequences (foreground parallel, background with report-back) plus constructed ones (missed `SubagentStop`, a subagent's permission prompt, island started mid-run, a new user prompt while a background agent runs, the 60 s safety net). The session must never show finished between the first prompt and the last `Stop`, and must peek once.
- `islandctl probe` on the recorded JSON (with `background_tasks`, `agent_id`, a report-back prompt).
- End to end without touching Yatin's Claude settings: the dev island (installed one quit) plus `claude -p --settings <scratch>` whose hooks run the dev `islandctl hook`, then screenshots of the page over CDP.
- Hooks upgrade: with `CLAUDE_CONFIG_DIR` pointing at a scratch folder holding a 0.4-style connection.
- Not testable by script: a real permission prompt inside a subagent in an interactive session, and real mouse clicks on agent lines. Yatin checks those.

## Left to the builder

CSS details of the tree lines and the fold-in animation (none needed), the exact text of the idle and more lines, and the internal shape of the payload, within the rules above.
