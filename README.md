# island

Spike to prove: hover-reveal island, click-through ripple overlay, glass look.

## Run (Windows 11)

    bun install
    bun run start        # transparent window + fake glass
    bun run acrylic      # real DWM acrylic blur (window is rectangular)

The first run downloads the Electron binary (about 100MB), so it is slow once.

Move the cursor to the very top edge, center of the primary screen.

Hotkeys: Ctrl+Alt+I toggles the island, Ctrl+Alt+Q quits.

## What to check

1. Island appears on hover at top center, closes ~0.35s after cursor leaves.
2. Rings spread from the island and you can still click apps under them.
3. Island does not steal focus (type in another app while it is open).
4. Compare `npm start` vs `npm run acrylic`: which glass looks right?
5. Open a fullscreen video/game: note whether island/ripple show over it.
6. Idle CPU in Task Manager (poller runs at ~60Hz).
