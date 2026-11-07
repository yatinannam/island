# Security Policy

## Supported versions

Only the latest release on the [Releases page](https://github.com/yatinannam/island/releases) receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately through GitHub: *Security* tab → *Report a vulnerability* ([private vulnerability reporting](https://github.com/yatinannam/island/security/advisories/new)).

Include the version, Windows build, steps to reproduce and the impact you observed. You can expect an acknowledgement within 7 days and a fix or a decision within 30 days. Reporters are credited in the release notes unless they ask not to be.

## What island accesses

island runs entirely on your machine and **makes no network requests**. For review purposes, this is everything it touches:

| Area | Access | Why |
|---|---|---|
| Screen content | Captures the region behind the island with `desktopCapturer` while it is open in glass mode (stops 4 s after closing) | To blur it into the glass. Frames stay in memory in the renderer, are never written to disk or sent anywhere. Turn on *Solid* to disable capture entirely. |
| Media sessions | Reads the current Windows media session (title, artist, artwork, position) and sends play/pause/skip/seek through `smtc.exe` | Now-playing controls. |
| Files | Reads paths and shell thumbnails of files you drop on the shelf; writes dropped in-memory blobs to `%APPDATA%\island\shelf-files` | File shelf. The app only ever deletes files inside `shelf-files`; it never deletes or modifies your originals. Dragging out is a normal Windows drag; the drop target decides copy or move. |
| App data | `%APPDATA%\island\settings.json`, `shelf.json` | Preferences and the shelf list. |
| Registry | Reads `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`; reads/writes `IsPromoted` for its own entry under `HKCU\Control Panel\NotifyIconSettings`; writes its own `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value when *Start with Windows* is on | Theme sync, keeping the tray icon visible, auto-start. Current user only; no admin rights. |
| Child process | Spawns `smtc.exe` (ships with the installer; compiled locally from `media/smtc.cs` in development) | WinRT media APIs. It exits when the app exits. |

## Hardening

- Renderers run with `contextIsolation`, `sandbox` and without `nodeIntegration`; preloads expose a minimal `contextBridge` API. Only local files are loaded; no remote content, no `webview`.
- Media commands from the renderer are validated against `^(toggle|next|prev|seek \d+)$` before reaching the helper. Shelf IPC only accepts absolute paths and known item ids; dropped blobs are size-limited (200 MB) and their names sanitized.
- The island window is excluded from screen capture (`WDA_EXCLUDEFROMCAPTURE`) in glass mode; this is also why it does not appear in screenshots.

## Binaries

Releases are **not code-signed**. Verify the installer's SHA-256 against the value in the release notes before running it, or build it yourself from source (`bun run dist`, see [CONTRIBUTING.md](CONTRIBUTING.md)).
