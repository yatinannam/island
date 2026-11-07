# island

Windows 11 app that gives a Mac-style top "island": it appears when the cursor hits the top-center edge of the screen, shows a glass pill (music first, more modules later), and fires a ring ripple across the screen. Owner: Yatin (yatinannam). He tests on Windows 11; the Linux dev environment cannot run Electron, so code is only syntax-checked there.

## Stack and decisions

- Electron with **bun** as package manager and script runner (`bun install`, `bun run start`, `bun run acrylic`). Do not use npm.
- Electron 45 downloads its binary on first run, not at install, so no `trustedDependencies` is needed.
- Two separate windows, because a transparent Electron window cannot be clicked through selectively:
  - **Island window:** 400x160, frameless, always-on-top, non-focusable, top-center. Hidden until opened.
  - **Ripple window:** full display, transparent, `setIgnoreMouseEvents(true)`, hidden until a ripple fires, hidden again after about 1.7s.
- Hover is detected by polling `screen.getCursorScreenPoint()` every 16ms in the main process against a 300px-wide, 2px-high hot zone. The island closes 350ms after the cursor leaves its bounds.
- Ripple is three staggered expanding rings drawn on a canvas, originating at the island. It is a ring only, not a full-screen wave and not real distortion of other apps.
- Two glass modes: default (transparent window, CSS fake glass) and `--acrylic` (`backgroundMaterial: 'acrylic'`, rectangular window). Yatin has not yet chosen between them.
- Hotkeys for testing: Ctrl+Alt+I toggles the island, Ctrl+Alt+Q quits.

## Status

Spike is pushed and untested on real hardware. Waiting on Yatin's results for: acrylic vs fake glass, click-through under the rings, no focus stealing, behavior over fullscreen apps, idle CPU of the poller.

## Roadmap

1. Island shell polish: peek and expanded states, spring animation, multi-monitor.
2. Media module: read Windows System Media Transport Controls (`GlobalSystemMediaTransportControlsSessionManager`, Windows 10 1809+) through a small helper exe (C# or Rust) that streams JSON over stdio. Album art, play/pause/next, scrub bar, glow tinted from the art's dominant color.
3. Ripple tinted to match the glow.
4. Extras in order: timer, clipboard history, file shelf, voice mode (mic waveform and live transcript).
5. Ship: tray icon, start with Windows, settings page, hide when a fullscreen app is active.

## Known limits

- Overlays do not show over exclusive-fullscreen games.
- Acrylic means a rectangular window with Windows-rounded corners, not a pill.
- Keep the hot zone to the center of the top edge so maximized-window buttons at the top right still work.

## Working agreement

Small commits straight to `main`. Say plainly when something could not be tested because it needs Windows.
