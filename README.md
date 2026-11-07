# island

A Mac-style island for Windows 11. Rest the cursor on the top-center edge of any screen and a glass island springs down from the edge with whatever is playing and a shelf for files. Move away and it tucks back up.

## Install

    bun install
    bun run dist

This builds `dist\island-setup-<version>.exe`. Run it to install island for your user (no admin needed) into `%LOCALAPPDATA%\Programs\island`, with a Start menu entry and an uninstaller in Windows Settings > Apps.

The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC" when it runs on another machine: click "More info", then "Run anyway".

## Develop

    bun install
    bun run start        # normal: hover the top edge to open
    bun run dev          # starts with the island pinned open
    bun run quit         # closes a running copy

The first run downloads the Electron binary (about 100MB) and compiles the media helper, so it is slow once.

- Left-click the tray icon for settings. Right-click it for Pin and Quit.
- Ctrl+Alt+I pins the island open (or closes it). Ctrl+Alt+Q quits.
- `--solid` starts with glass off. `--settings` opens the settings flyout on start. `--start-with-windows on|off` sets the login item for that exe.
- Set `ISLAND_DEBUG=1` to log open/close, clicks on the island, shelf and media events.

The tray icon is put on the taskbar (not the hidden `^` menu) on first run. Turn that off with "Always show icon on taskbar" in settings, or in Windows Settings > Personalization > Taskbar > Other system tray icons.

## Settings

The tray flyout uses Windows' own acrylic material and your Windows accent color. While you change a look setting, the island stays open so you see the result live.

- **Background:** Glass or Solid.
- **Transparency:** how much of what's behind shows through the glass.
- **Song color:** how strongly the artwork's color tints the island, strongest around the cover (0 turns it off). Fades between tracks; works in Solid too.
- **Open delay / Close delay:** how long the cursor rests on the top edge before it opens, and how long it stays away before it closes.
- **Start with Windows.**
- **Always show icon on taskbar.**

Settings are saved to `%APPDATA%\island\settings.json`.

## Music

Works with anything that shows up in the Windows media flyout: Spotify, browsers (YouTube, YouTube Music, SoundCloud), Media Player, and more. Shows artwork, title, artist and progress; play/pause, next, previous; click or drag the bar to seek when the app allows it. The equalizer bars are a neutral white two-tone; the artwork's color goes into the background instead (Song color).

`media/smtc.cs` is a small C# program that talks to the Windows System Media Transport Controls API. In development it is compiled on first run with the C# compiler that ships with Windows (.NET Framework `csc.exe`); the installer ships it prebuilt. It streams JSON lines to the app and takes commands on stdin.

## File shelf

A place to park files for a moment. Drag files (or folders, or an image out of a browser) to the top edge: the island opens, and dropping on it adds them to a row under the music. Drag a file back out into any app or folder, or use the "drag all" button for everything at once. Double-click opens a file, × removes it from the shelf.

The shelf holds references to your files, not copies, so big files cost nothing. Dragging out works like dragging from Explorer: Windows picks copy or move depending on where you drop (hold Ctrl to copy). If a file gets moved away, it leaves the shelf. Things with no file on disk, like a browser image, are saved under `%APPDATA%\island\shelf-files`. The shelf survives restarts (`shelf.json`).

## Glass

Windows cannot blur behind a rounded transparent window, so the island captures the screen behind itself (its own window is excluded from capture), blurs it, and paints it inside the notch shape, with the same layers as Windows acrylic: blur, luminosity, tint and a little noise. It follows the Windows theme (dark or light) and the "Transparency effects" switch.

Two trade-offs:

- With glass on, the island does not appear in screenshots or screen recordings. Switch to Solid in settings to record it.
- Capture runs only while the island is open and stops 4 seconds after it closes. Open with glass costs about 0.3 of a CPU core; closed costs about 1.5% of one core.

## How it works

- One transparent, always-on-top, non-focusable window sits at the top center of the display under the cursor. Once shown it stays there; while the island is closed it is fully transparent and click-through.
- The main process polls the cursor every 16ms. Resting in the 240x3px hot zone for the open delay (150ms) opens the island. Leaving it for the close delay (120ms) closes it, with a stiffer spring than the open.
- The window takes the mouse only while the cursor is over the island, decided from the same cursor polling, so the area around it never blocks clicks.
- Open and close use a real damped-spring curve, generated at startup and fed to CSS as a `linear()` easing. A canvas paints the notch shape each frame to follow it.

## Inspiration

- [Pillar](https://github.com/warpirate/pillar-dynamic-island-for-windows) (MIT), a Tauri island with media, volume, battery and timer modules.
- [notchX](https://github.com/rahozosman/notchX), a Flutter island with pages for media, calendar, shelf and timers. All rights reserved; ideas only, no code.
