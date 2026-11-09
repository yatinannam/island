// Equalizer bars that follow the sound actually playing.
//
// Chromium's desktop audio capture is WASAPI loopback of the default output
// device: the mix Windows plays, not the microphone (Windows shows no
// mic-in-use indicator for it). It only works together with a desktop video
// track, so that track is stopped right away. Capture runs while the island is
// open and something is playing, and stops 4s after that ends (like the glass
// capture), so a quick re-open does not restart it.
//
// The bars follow the audio only while there is sound. Before the capture is
// up, when it fails, and after 1.5s of silence (a paused remote device, audio
// on another output), the CSS animation in island.html takes over again, so
// the bars never look stuck while something is playing.
(() => {
  const eq = document.querySelector('.eq');
  if (!eq || !navigator.mediaDevices) return;
  const bars = [...eq.querySelectorAll('i')];
  const body = document.body;

  // One frequency band per bar, low to high, in Hz.
  const BANDS = [[40, 160], [160, 600], [600, 2400], [2400, 10000]].slice(0, bars.length);
  const REST = 0.22;            // resting scale of the bars in island.html
  // Each bar follows its band's level against that band's own recent average
  // and spread, so every bar moves on loud, compressed songs and quiet ones
  // alike. Tuned on a recorded song: bars mostly between 0.3 and 0.9, around 0.55.
  const AVG_MS = 1000;          // how quickly a bar adapts to its band's loudness
  const CENTER = 0.2;           // where a bar sits at the average level (0 rest, 1 full)
  const SPREAD = 2;             // average deviations from the average for a full bar
  const MIN_DEV_DB = 2.5;       // don't blow up a steady tone into full swings
  const FLOOR_DB = -90;         // below this a band counts as empty
  const SILENT_RMS = 1e-4;      // about -80 dBFS
  const SILENT_MS = 1500;
  const STOP_AFTER_MS = 4000;
  const UP_MS = 30, DOWN_MS = 90; // smoothing: quick rise, slightly slower fall

  const style = document.createElement('style');
  // will-change: own compositor layers, so a new height doesn't repaint the
  // page around the bars every frame (a CSS animation gets that by itself).
  style.textContent = '.eq.live i { animation: none !important; transition: none !important; will-change: transform; }';
  document.head.appendChild(style);

  let stream = null, ctx = null, analyser = null, freq = null, wave = null, bins = null;
  let starting = null, stopTimer = null, raf = 0, lastT = 0, soundAt = 0, learnAt = 0, live = false;
  const avg = BANDS.map(() => null);
  const dev = BANDS.map(() => 4);
  const shown = BANDS.map(() => REST);

  const wanted = () => body.classList.contains('open') && body.classList.contains('playing');

  function start() {
    if (stream) return Promise.resolve();
    if (!starting) starting = open().finally(() => { starting = null; });
    return starting;
  }

  async function open() {
    let s = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } },
      });
      s.getVideoTracks().forEach((t) => t.stop());
      const track = s.getAudioTracks()[0];
      if (!track) throw new Error('no system audio track');
      // No output device: it only analyses, so it opens no audio stream of its own.
      try { ctx = new AudioContext({ sinkId: { type: 'none' } }); } catch { ctx = new AudioContext(); }
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.2;
      ctx.createMediaStreamSource(s).connect(analyser);
      freq = new Float32Array(analyser.frequencyBinCount);
      wave = new Float32Array(analyser.fftSize);
      const hz = analyser.fftSize / ctx.sampleRate;
      bins = BANDS.map(([lo, hi]) => {
        const a = Math.max(1, Math.round(lo * hz));
        return [a, Math.max(a + 1, Math.round(hi * hz))];
      });
      stream = s;
      // Capture ended under us (output device gone): reconnect, unless it keeps
      // ending right away, then leave the bars on the CSS animation.
      const openedAt = performance.now();
      track.addEventListener('ended', () => {
        if (stream !== s) return;
        stop(true);
        if (performance.now() - openedAt > 2000) update(true);
      });
      if (!wanted()) stopLater();
    } catch (e) {
      console.warn('equalizer: system audio capture failed', e);
      if (s) s.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close();
      ctx = null;
    }
  }

  function stop(force) {
    if (!force && wanted()) return;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    stream = ctx = analyser = null;
    cancelAnimationFrame(raf);
    raf = 0;
    setLive(false);
  }

  function stopLater() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(stop, STOP_AFTER_MS);
  }

  function setLive(on) {
    if (on === live) return;
    live = on;
    if (on) {
      // Start from wherever the CSS animation has the bars right now.
      bars.forEach((bar, i) => {
        const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(bar).transform);
        shown[i] = m ? Number(m[1].split(',')[3]) || REST : REST;
      });
      eq.classList.add('live');
    } else {
      eq.classList.remove('live');
      bars.forEach((bar) => { bar.style.transform = ''; });
    }
  }

  function tick(t) {
    raf = requestAnimationFrame(tick);
    const dt = lastT ? Math.min(100, t - lastT) : 16;
    lastT = t;

    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    if (Math.sqrt(sum / wave.length) > SILENT_RMS) soundAt = t;
    // Short gaps fall to rest; long silence hands back to the CSS animation.
    setLive(t - soundAt < SILENT_MS);
    if (!live) return;

    analyser.getFloatFrequencyData(freq);
    // Learn the level quickly at first: the first frames are only partly filled.
    if (avg[0] === null) learnAt = t;
    const a = 1 - Math.exp(-dt / (t - learnAt < 400 ? 80 : AVG_MS));
    for (let b = 0; b < bins.length; b++) {
      const [lo, hi] = bins[b];
      let p = 0;
      for (let i = lo; i < hi; i++) p += Math.pow(10, freq[i] / 10);
      const db = 10 * Math.log10(p / (hi - lo) + 1e-20);
      if (avg[b] === null) avg[b] = db;
      avg[b] += (db - avg[b]) * a;
      dev[b] += (Math.abs(db - avg[b]) - dev[b]) * a;
      const v = db < FLOOR_DB ? 0
        : Math.min(1, Math.max(0, CENTER + (db - avg[b]) / (SPREAD * Math.max(dev[b], MIN_DEV_DB))));
      const target = REST + (1 - REST) * v;
      const tau = target > shown[b] ? UP_MS : DOWN_MS;
      shown[b] += (target - shown[b]) * (1 - Math.exp(-dt / tau));
      bars[b].style.transform = `scaleY(${shown[b].toFixed(3)})`;
    }
  }

  let was = false;
  function update(force) {
    const now = wanted();
    if (now === was && !force) return;
    was = now;
    if (now) {
      clearTimeout(stopTimer);
      start().then(() => {
        if (wanted() && stream && !raf) {
          lastT = 0;
          soundAt = -Infinity;
          avg.fill(null); // relearn the level: the song may have changed
          raf = requestAnimationFrame(tick);
        }
      });
    } else {
      cancelAnimationFrame(raf);
      raf = 0;
      setLive(false);
      stopLater();
    }
  }

  new MutationObserver(() => update()).observe(body, { attributes: true, attributeFilter: ['class'] });
  update();
})();
