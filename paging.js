// Page scrolling for the island: the pages follow a touchpad swipe and then
// settle on a page with a spring. One page per swipe, however long.
//
// A Windows precision touchpad, as Chromium reports it (recorded on Yatin's
// laptop, 874 events): while the fingers move, wheel events every ~16 ms with
// large deltas (100-1000 px per event on a quick swipe); when they lift, one
// event with no delta at all; then momentum for about a second, fading
// (289, 105, 89 ... 8, 7). Right after the lift the momentum can jump
// (0, 2, 271) and even run along the other axis. A quick next swipe starts
// while the momentum still runs, with no pause: it kicks back in hard
// (7 -> 20 -> 99), or turns the other way. A mouse wheel click is one event
// worth a whole page.
//
// The pages never jump: a spring always moves them. While the fingers are
// down it chases the finger position closely (critically damped, so it
// smooths the big steps without overshooting); on release it keeps its speed
// and settles on the page.
//
// No DOM here: island.html feeds it wheel events and frames and draws `pos`.
// Loaded as a plain script (window.createPager) and, for tests, by Node.

(function (root) {
  const GAIN = 0.75;          // page px per wheel px while the fingers are down
  const TRACK_W = 34;         // chase spring while tracking (critically damped, 1/s)
  const TRACK_MAX_V = 3000;   // px/s: a whole page takes at least ~8 frames
  const SETTLE_K = 300;       // settle spring: stiffness ...
  const SETTLE_C = 27;        // ... and damping (a little overshoot)
  const MAX_V = 1400;         // px/s carried into the settle, so a flick doesn't overshoot far
  const RUBBER = 44;          // px the pages give past the first or last page
  const COMMIT = 0.25;        // released past this share of a page (with its speed): next page
  const CLICK_MIN = 40;       // wheel px of a lone step that counts as a wheel click
  const PROJECT_S = 0.12;     // how far ahead the finger speed counts at release
  const IDLE_MS = 80;         // no events while tracking (events come every ~16 ms): settle
  const QUIET_MS = 200;       // no events at all: the gesture (and its momentum) is over
  // Nothing is a new swipe this soon after the lift (the momentum's first
  // events jump and wander: 0, 2, 271), or after the next page was reached
  // with the fingers still down (their big steps vary: 369, 947).
  const AFTER_LIFT_MS = 150;
  const AFTER_COMMIT_MS = 300;
  const KICK_MIN = 20;        // a new swipe kicks in at least this hard ...
  const KICK_RATIO = 2.5;     // ... and this much harder than the step before
  const TURN_MIN = 3;         // or turns the other way at least this much

  function createPager({ width, count, onPage = () => {}, onRender = () => {} }) {
    const W = width;
    let n = count;
    let page = 0;              // the page it rests on or heads to
    let pos = 0, vel = 0;      // along the track, px and px/s
    let target = 0;
    let tracking = false;      // chase spring (true) or settle spring
    let g = null;              // the gesture in progress
    let lastFrame = 0;

    const clampPage = (p) => Math.max(0, Math.min(n - 1, p));
    const exists = (p) => p >= 0 && p < n;
    const clampV = (v, m) => Math.max(-m, Math.min(m, v));

    function setPage(p) {
      if (p === page) return;
      page = p;
      onPage(page);
    }

    function settleTo(p) {
      setPage(clampPage(p));
      tracking = false;
      target = page * W;
      vel = clampV(vel, MAX_V);
    }

    // One frame at time t (ms); returns whether more frames are needed.
    function frame(t) {
      const dt = lastFrame ? Math.min(0.05, Math.max(0.001, (t - lastFrame) / 1000)) : 1 / 60;
      lastFrame = t;
      if (g && !g.locked && t - g.lastT > IDLE_MS) release(false);
      const k = tracking ? TRACK_W * TRACK_W : SETTLE_K;
      const c = tracking ? 2 * TRACK_W : SETTLE_C;
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const h = dt / steps;
        vel += (-k * (pos - target) - c * vel) * h;
        if (tracking) vel = clampV(vel, TRACK_MAX_V);
        pos += vel * h;
      }
      const resting = Math.abs(pos - target) < 0.25 && Math.abs(vel) < 4;
      if (resting && !tracking) { pos = target; vel = 0; }
      onRender(pos);
      const more = !resting || tracking || (g && !g.locked);
      if (!more) lastFrame = 0;
      return !!more;
    }

    // Fingers lifted (or stopped): pick the page from where the pages are and,
    // after a lift, where the fingers were heading; the spring takes them there.
    function release(lifted, t) {
      if (!g || g.locked) return;
      const off = (tracking ? target : pos) - g.base * W; // where the fingers put it
      const proj = off + (lifted ? clampV(g.v, MAX_V) * PROJECT_S : 0);
      const s = Math.sign(proj);
      // One or two big steps and nothing more: a wheel click not recognised as one.
      const click = !lifted && g.events <= 2 && Math.abs(g.raw) >= CLICK_MIN * GAIN;
      settleTo(s && (Math.abs(proj) > W * COMMIT || click) && exists(g.base + s) ? g.base + s : g.base);
      if (lifted) lock(t, true); // momentum follows: not a new swipe
      else g = null;
    }

    function lock(t, lifted) {
      g.locked = true;
      g.lifted = g.lifted || lifted;
      g.lockAt = t;
      g.momDir = 0;
    }

    // e: { t (ms), dx, dy, notch (a mouse wheel click) }. Returns true when
    // the pager took the event (the page itself should not scroll).
    function wheel(e) {
      const { t, dx, dy } = e;
      if (g && t - g.lastT > QUIET_MS) {
        if (!g.locked) release(false, t);
        g = null;
      }
      const mag = Math.max(Math.abs(dx), Math.abs(dy));
      if (!mag) { // the fingers lifted
        if (g) {
          if (g.locked) lock(t, true);
          else release(true, t);
          g.lastT = t;
        }
        return true;
      }
      // The event's way along the pages: right and down are forward.
      const way = Math.sign(Math.abs(dx) > Math.abs(dy) ? dx : dy);
      if (g && g.locked) {
        const settled = t - g.lockAt >= (g.lifted ? AFTER_LIFT_MS : AFTER_COMMIT_MS);
        const kick = settled && mag >= KICK_MIN && mag > g.lastMag * KICK_RATIO;
        const turned = settled && g.lifted && g.momDir && way !== g.momDir && mag >= TURN_MIN;
        g.lastT = t;
        g.lastMag = mag;
        if (!kick && !turned) { // momentum, or the rest of a swipe that already arrived
          g.momDir = way;
          return true;
        }
        g = null;
      }
      if (!g) {
        g = {
          axis: Math.abs(dx) > Math.abs(dy) ? 'x' : 'y', base: page, raw: pos - page * W,
          v: 0, lastT: t, locked: false, lifted: false, lockAt: 0, lastMag: 0, momDir: 0, events: 0,
        };
      }
      const d = g.axis === 'x' ? dx : dy;
      const dt = Math.max(8, t - g.lastT);
      g.lastT = t;
      g.lastMag = mag;
      if (!d) return true;
      g.events++;
      if (e.notch) { // a whole page, like a click
        settleTo(g.base + Math.sign(d));
        lock(t, true);
        return true;
      }
      g.v = g.v * 0.3 + (d * GAIN * 1000 / dt) * 0.7;
      // One page per swipe: the pages follow up to the next page and stop there.
      g.raw = Math.max(-W, Math.min(W, g.raw + d * GAIN));
      const s = Math.sign(g.raw);
      let off = g.raw;
      if (s && !exists(g.base + s)) off = s * RUBBER * (1 - Math.exp(-Math.abs(g.raw) / (RUBBER * 2)));
      tracking = true;
      target = g.base * W + off;
      if (s && exists(g.base + s) && Math.abs(g.raw) >= W) {
        settleTo(g.base + s); // the next page is reached while the fingers still push
        lock(t, false);
      }
      return true;
    }

    // Whether wheel events belong to a page swipe right now (a list that
    // slides under the cursor mid-swipe must not take them).
    function active(t) {
      return !!g && t - g.lastT <= QUIET_MS;
    }

    // Dots, a file dragged in: animate there.
    function go(p) {
      g = null;
      settleTo(p);
    }

    // Opening the island: be there already.
    function jump(p) {
      g = null;
      setPage(clampPage(p));
      tracking = false;
      pos = target = page * W;
      vel = 0;
      onRender(pos);
    }

    function setCount(c) {
      n = Math.max(1, c);
      if (page > n - 1) jump(n - 1);
    }

    return {
      wheel, frame, go, jump, active, setCount,
      get page() { return page; },
      get pos() { return pos; },
      get count() { return n; },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPager };
  else root.createPager = createPager;
})(typeof window !== 'undefined' ? window : globalThis);
