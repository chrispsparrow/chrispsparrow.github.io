'use strict';

/* ── GROUND STATION PAGE: THE CYCLING RENDERS ────────────────
   The three renders at the top of ground-station/index.html take turns once
   a second, in markup order (omnis, starter, yagis, then around again). The
   new one fades in over 150ms (the transition in css/ground-station.css) on
   top of the old one, which stays fully shown until the fade is done.
   - Starts only once all three have loaded and decoded, so a switch never
     shows a blank or half-drawn frame. If one fails to load, the first
     render just stays up.
   - Stops while the tab is hidden and picks up again when it's back.
   - With reduced motion it never runs, and CSS shows only the starter
     render. */
(function () {
  const box = document.querySelector('.gs-cycle');
  if (!box) return;
  const frames = Array.from(box.querySelectorAll('.gs-frame'));
  if (frames.length < 2) return;

  const STEP_MS = 1000;   // how long each render stays up
  const FADE_MS = 150;    // same as the CSS transition
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');

  let at = Math.max(0, frames.findIndex(f => f.classList.contains('is-on')));
  let timer = 0, cleanup = 0, ready = false;

  const advance = () => {
    const cur = frames[at];
    at = (at + 1) % frames.length;
    const next = frames[at];
    clearTimeout(cleanup);
    frames.forEach(f => { if (f !== cur) f.classList.remove('is-prev'); });
    cur.classList.replace('is-on', 'is-prev');   // stays shown underneath
    next.classList.add('is-on');                 // fades in on top
    cleanup = setTimeout(() => cur.classList.remove('is-prev'), FADE_MS + 50);
  };

  const start = () => {
    if (timer || !ready || still.matches || document.hidden) return;
    timer = setInterval(advance, STEP_MS);
  };
  const stop = () => { clearInterval(timer); timer = 0; };

  const loaded = (img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
  Promise.all(frames.map(loaded)).then(() => {
    if (!frames.every(f => f.complete && f.naturalWidth > 0)) return;
    ready = true;
    start();
  });

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  still.addEventListener('change', () => (still.matches ? stop() : start()));
})();
