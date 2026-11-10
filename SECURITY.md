# Security Policy

## Supported versions

Only the latest release on the [Releases page](https://github.com/yatinannam/island/releases) receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately through GitHub: *Security* tab → *Report a vulnerability* ([private vulnerability reporting](https://github.com/yatinannam/island/security/advisories/new)).

Include the version, Windows build, steps to reproduce and the impact you observed. You can expect an acknowledgement within 7 days and a fix or a decision within 30 days. Reporters are credited in the release notes unless they ask not to be.

## What island accesses

island runs on your machine. Its only network traffic is the update check described below, which you can turn off; the Claude Code pipe is local only. For review purposes, this is everything it touches:

| Area | Access | Why |
|---|---|---|
| Screen content | Captures the region behind the island with `desktopCapturer` while it is open in glass mode (stops 4 s after closing) | To blur it into the glass. Frames stay in memory in the renderer, are never written to disk or sent anywhere. Turn on *Solid* to disable capture entirely. |
| System audio | Listens to the sound your default output device plays (loopback, not the microphone) while the island is open and something is playing (stops 4 s after) | To move the equalizer bars with the music. Only four loudness levels are computed per frame; the audio is never recorded, written to disk or sent anywhere. Windows shows no microphone-in-use indicator for it because no microphone is opened. |
| Media sessions | Reads the current Windows media session (title, artist, artwork, position) and sends play/pause/skip/seek through `smtc.exe` | Now-playing controls. |
| Files | Reads paths and shell thumbnails of files you drop on the shelf; writes dropped in-memory blobs to `%APPDATA%\island\shelf-files` | File shelf. The app only ever deletes files inside `shelf-files`; it never deletes or modifies your originals. Dragging out is a normal Windows drag; the drop target decides copy or move. |
| App data | `%APPDATA%\island\settings.json`, `shelf.json` | Preferences and the shelf list. |
| Registry | Reads `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`; reads/writes `IsPromoted` for its own entry under `HKCU\Control Panel\NotifyIconSettings`; writes its own `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value when *Start with Windows* is on | Theme sync, keeping the tray icon visible, auto-start. Current user only; no admin rights. |
| Child process | Spawns `smtc.exe` (ships with the installer; compiled locally from `media/smtc.cs` in development) | WinRT media APIs. It exits when the app exits. |
| Local pipe | Listens on the named pipe `\\.\pipe\island-<username>` (default pipe security: only your account, administrators and SYSTEM can write to it) for one-line JSON events from `islandctl.exe` | Live activities. Messages are data to display only: validated against a fixed event list, string lengths capped, rate-limited; nothing in a message is ever run or opened. |
| Claude Code settings | Only when you turn on *Claude Code* (off by default): reads `~/.claude/settings.json` (or the one in `CLAUDE_CONFIG_DIR`), backs it up to `settings.island-backup.json` next to it, adds hooks that run `islandctl.exe hook`; turning it off removes exactly those hooks. Refuses to touch the file if it is not valid JSON. | Claude Code reports session events (working, finished, needs you) to the island. `islandctl.exe` forwards only the event name, session id, working directory, notification type and text, tool name, and the Claude process and terminal window ids; never prompts, tool input or output. The island shows only the folder name, status and tool name. |
| Network (updates) | With *Update automatically* on (the default): a minute after start and every 6 hours, one HTTPS request to `api.github.com/repos/yatinannam/island/releases/latest`; when it lists a newer version, the installer download from `github.com/yatinannam/island/releases/download/` into `%TEMP%\island-update`. *Check now* in Settings does the same once, even with automatic updates off. No identifiers or usage data are sent; GitHub sees the request like any download. | Keeping installs current. The installer is only run after its size and SHA-256 match the digest GitHub publishes for the release asset, and only files from this repository are accepted. It installs silently while the PC is idle (or when you choose *Restart*) and starts island again. |
| Windows state | `islandctl.exe` reads the foreground window, the shell's notification state (`SHQueryUserNotificationState`) and the Do Not Disturb profile (WNF quiet-hours state); it can bring a terminal window to the front when you click a peek or press Ctrl+Alt+J | Holding peeks during fullscreen apps and Do Not Disturb, not peeking at a terminal you are already looking at, jumping to a session's terminal. |

## Hardening

- Renderers run with `contextIsolation`, `sandbox` and without `nodeIntegration`; preloads expose a minimal `contextBridge` API. Only local files are loaded; no remote content, no `webview`.
- Live-activity messages from the pipe are parsed as data and validated (known event names, session ids `^[\w.-]{1,100}$`, capped strings, integer pids and window handles); peek clicks can only focus a window handle that came from a hook, through `islandctl.exe focus`.
- Media commands from the renderer are validated against `^(toggle|next|prev|seek \d+)$` before reaching the helper. Shelf IPC only accepts absolute paths and known item ids; dropped blobs are size-limited (200 MB) and their names sanitized.
- The island window is excluded from screen capture (`WDA_EXCLUDEFROMCAPTURE`) in glass mode; this is also why it does not appear in screenshots.

## Binaries

Releases are **not code-signed**. Automatic updates verify the download against GitHub's published SHA-256, which protects against corrupted or swapped files in transit, not against a compromised GitHub account; code signing would add that. Verify the installer's SHA-256 against the value in the release notes before running it, or build it yourself from source (`bun run dist`, see [CONTRIBUTING.md](CONTRIBUTING.md)).
