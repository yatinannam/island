# island

A Mac-style island for Windows 11. Rest the cursor on the top-center edge of any screen and a glass island springs down from the edge with whatever is playing. Move away and it tucks back up.

## Run

    bun install
    bun run start        # normal: hover the top edge to open
    bun run dev          # starts with the island pinned open

The first run downloads the Electron binary (about 100MB) and compiles the media helper, so it is slow once.

- Left-click the tray icon for settings. Right-click it for Pin and Quit.
- Ctrl+Alt+I pins the island open (or closes it). Ctrl+Alt+Q quits.
- `--solid` starts with glass off. `--settings` opens the settings flyout on start.
- Set `ISLAND_DEBUG=1` to log open/close events and media helper errors.

## Settings

The tray flyout uses Windows' own acrylic material and your Windows accent color. While you change a look setting, the island stays open so you see the result live.

- **Background:** Glass or Solid.
- **Transparency:** how much of what's behind shows through the glass.
- **Song color:** how strongly the artwork's color tints the island, strongest around the cover (0 turns it off). Fades between tracks; works in Solid too.
- **Open delay / Close delay:** how long the cursor rests on the top edge before it opens, and how long it stays away before it closes.
- **Start with Windows.**

Settings are saved to `%APPDATA%\island\settings.json`.

## Music

Works with anything that shows up in the Windows media flyout: Spotify, browsers (YouTube, YouTube Music, SoundCloud), Media Player, and more. Shows artwork, title, artist and progress; play/pause, next, previous, and click the bar to seek when the app allows it. The equalizer bars take their color from the artwork.

`media/smtc.cs` is a small C# program that talks to the Windows System Media Transport Controls API. It is compiled on first run with the C# compiler that ships with Windows (.NET Framework `csc.exe`), so nothing extra needs installing. It streams JSON lines to the app and takes commands on stdin.

## Glass

Windows cannot blur behind a rounded transparent window, so the island captures the screen behind itself (its own window is excluded from capture), blurs it, and paints it inside the notch shape, with the same layers as Windows acrylic: blur, luminosity, tint and a little noise. It follows the Windows theme (dark or light) and the "Transparency effects" switch.

Two trade-offs:

- With glass on, the island does not appear in screenshots or screen recordings. Turn glass off from the tray menu to record it.
- Capture runs only while the island is open and stops 4 seconds after it closes. Open with glass costs about 0.3 of a CPU core; closed costs about 1.6% of one core.

## How it works

- One transparent, always-on-top, non-focusable window sits at the top center of the display under the cursor. It is hidden while the island is closed, so nothing covers fullscreen games or video.
- The main process polls the cursor every 16ms. Resting in the 240x3px hot zone for the open delay (150ms) opens the island. Leaving it for the close delay (120ms) closes it, with a stiffer spring than the open.
- The window ignores the mouse except over the island shape itself, so the area around it never blocks clicks.
- Open and close use a real damped-spring curve, generated at startup and fed to CSS as a `linear()` easing. A canvas paints the notch shape each frame to follow it.

## Inspiration

- [Pillar](https://github.com/warpirate/pillar-dynamic-island-for-windows) (MIT), a Tauri island with media, volume, battery and timer modules.
- [notchX](https://github.com/rahozosman/notchX), a Flutter island with pages for media, calendar, shelf and timers. All rights reserved; ideas only, no code.
