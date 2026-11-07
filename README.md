# island

A Mac-style island for Windows 11. Rest the cursor on the top-center edge of any screen and a black island springs down from the edge. Move away and it tucks back up.

## Run

    bun install
    bun run start        # normal: hover the top edge to open
    bun run dev          # starts with the island pinned open

The first run downloads the Electron binary (about 100MB), so it is slow once.

- Ctrl+Alt+I pins the island open (or closes it).
- Ctrl+Alt+Q quits. The tray icon also has Quit.
- Set `ISLAND_DEBUG=1` to log open/close events with cursor coordinates.

## How it works

- One transparent, always-on-top, non-focusable window sits at the top center of the display under the cursor. It is hidden while the island is closed, so nothing covers fullscreen games or video.
- The main process polls the cursor every 16ms. Resting in the 240x3px hot zone for 150ms opens the island. Leaving the island for 300ms closes it.
- The window ignores the mouse except over the island shape itself, so the area around it never blocks clicks.
- Open and close use a real damped-spring curve, generated at startup and fed to CSS as a `linear()` easing.

## Status

The island shell is done. The music card shows demo data until the media module is built.
