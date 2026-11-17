'use strict';

/* ── GROUND STATION PAGE: THE HERO ───────────────────────────
   1. The cycling frames. The hero is a still background (the whole starter
      render) with three hardware-only frames on top (omnis, starter, yagis,
      transparent everywhere else). Every 2 seconds the next frame fades in
      over 0.5s (the transition in css/ground-station.css) on top of the
      current one, which stays fully shown until the fade is done. Markup
      order sets the order: omnis, starter, yagis, then around again. It
      starts on the starter frame, which matches the background.
      - Starts only once the background and all three frames have loaded and
        decoded, so a switch never shows a blank or half-drawn frame. A frame
        that isn't ready yet (say the phone was just turned and the other
        size is loading) is skipped until it is.
      - Pauses while the tab is hidden or the hero is scrolled out of view.
      - With reduced motion it never runs, and CSS shows only the starter.
   2. The nav. While any of the hero is still under the nav, the body keeps
      .gs-nav-hero (light nav text over the photo). Past the hero it's
      removed and the nav is the usual cream one. */
(function () {
  const hero = document.querySelector('.gs-hero');
  if (!hero) return;
  const nav    = document.getElementById('nav');
  const frames = Array.from(hero.querySelectorAll('.gs-frame'));
  const layers = Array.from(hero.querySelectorAll('.gs-layer img'));   // background and frames

  const STEP_MS = 2000;   // how long each frame stays up
  const FADE_MS = 500;    // same as the CSS transition
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');

  let at = Math.max(0, frames.findIndex(f => f.classList.contains('is-on')));
  let timer = 0, cleanup = 0, ready = false, inView = true;

  const shown = (pic) => { const img = pic.querySelector('img'); return img.complete && img.naturalWidth > 0; };

  const advance = () => {
    const nextAt = (at + 1) % frames.length;
    if (!shown(frames[nextAt])) return;          // try again next time
    const cur = frames[at], next = frames[nextAt];
    at = nextAt;
    clearTimeout(cleanup);
    frames.forEach(f => { if (f !== cur) f.classList.remove('is-prev'); });
    cur.classList.replace('is-on', 'is-prev');   // stays shown underneath
    next.classList.add('is-on');                 // fades in on top
    cleanup = setTimeout(() => cur.classList.remove('is-prev'), FADE_MS + 50);
  };

  const start = () => {
    if (timer || !ready || still.matches || document.hidden || !inView || frames.length < 2) return;
    timer = setInterval(advance, STEP_MS);
  };
  const stop = () => { clearInterval(timer); timer = 0; };

  const loaded = (img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
  Promise.all(layers.map(loaded)).then(() => {
    if (!layers.every(img => img.complete && img.naturalWidth > 0)) return;   // something failed: keep the still
    ready = true;
    start();
  });

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  still.addEventListener('change', () => (still.matches ? stop() : start()));

  /* Hero position: the nav style and the scrolled-away pause */
  const check = () => {
    const bottom = hero.getBoundingClientRect().bottom;
    document.body.classList.toggle('gs-nav-hero', bottom > (nav ? nav.offsetHeight : 64));
    const was = inView;
    inView = bottom > 0;
    if (inView !== was) (inView ? start() : stop());
  };
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  check();
})();
