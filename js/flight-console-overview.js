/* Project Overview page (projects/flight-console.html): the scroll tour.

   Four steps, driven by how far the page has scrolled through the tall .fco-tour
   wrapper while .fco-stage sticks to the window (the same idea as the Toothpaste
   Dispenser page):
     1. a close-up of the Dogtooth board
     2. zoom way out to the whole rocket, with the board in its avionics bay
     3. the rocket rises and its radio signal travels down to Manta
     4. pan along the ground to the laptop running the Flight Console

   Everything in .fco-world is one scene, measured in scene units, and the "camera"
   is one transform on it (translate, then scale). The board image lives in the bay's
   window inside the scene, so the same image is on screen the whole way from the
   close-up to the last step. The zoom from step 1 to 2 is anchored on that window:
   the scale changes at an even rate and the window glides from the middle of the
   frame to where it sits in the full rocket.

   Labels (Manta's and the laptop's) are sized in screen pixels and turned into scene
   units for the scale they are seen at, so they stay readable on a phone.

   With reduced motion there is no tour. Each step gets a still copy of the scene,
   held where that step ends, next to its sentence. The class on <html> (fco-anim or
   fco-static) is set by a small script in the page's <head>, so the first paint
   already has the right layout. */
(() => {
  'use strict';

  const tour = document.getElementById('fco-tour');
  if (!tour) return;
  const root = document.documentElement;
  const stage = tour.querySelector('.fco-stage');
  const mainView = tour.querySelector('.fco-view');
  const steps = Array.from(tour.querySelectorAll('.fco-step'));
  const nav = document.getElementById('nav');
  const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (p, [a, b]) => clamp((p - a) / (b - a), 0, 1);
  const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);      /* slow, fast, slow */
  const easeOut = (t) => 1 - (1 - t) * (1 - t);

  /* ── The scene, in scene units ───────────────────────────
     The rocket's frame has the nose tip at (0, 0) and the base at (0, 1000), and
     at the start it stands on the ground, so its frame and the scene line up. */
  const GROUND = 1000;
  const BOARD = { x: 0, y: 258, w: 30.4, h: 30.4 * 2523 / 2400 };   /* matches .fco-board in the CSS */
  const FIN_X = 80;            /* half the rocket's width, fin tip to fin tip */
  const BODY_X = 22;           /* half the body tube's width, where the signal leaves the bay */
  const RISE = 300;            /* how far the rocket climbs in step 3 */

  /* ── The timeline, as shares of the scroll through the wrapper ── */
  const T = {
    zoom:   [0.06, 0.32],     /* step 1 to 2: zoom out from the board to the rocket */
    rocket: [0.09, 0.20],     /* the rocket fades in around the board */
    rise:   [0.40, 0.60],     /* step 2 to 3: the rocket rises and the view takes in Manta */
    manta:  [0.42, 0.54],     /* Manta, its antenna and the cable fade in */
    signal: [0.58, 0.72],     /* the radio signal travels down to Manta */
    pan:    [0.77, 0.94],     /* step 3 to 4: pan along the ground to the laptop */
    link:   [0.84, 0.96],     /* a pulse runs along the cable to the laptop */
    cue:    [0.004, 0.04],    /* the scroll hint fades out */
  };
  const SWITCH = [0.20, 0.44, 0.78];     /* where each sentence hands over to the next */
  const SWITCH_HALF = 0.022;             /* each sentence fades over this much scroll on each side */
  /* Reduced motion: where each still picture is held. Step 2's still has its own
     framing (see L.camBay), since a still of the whole rocket would show the board
     only a few pixels wide. */
  const STILL_AT = [0, 0.36, 0.75, 1];
  const STILL_CAM = [null, 'camBay', null, null];

  /* ── One copy of the scene ───────────────────────────── */
  function makeScene(view) {
    const q = (s) => view.querySelector(s);
    return {
      view,
      world: q('.fco-world'),
      rocket: q('.fco-rocket'),
      art: q('.fco-rocket-art'),
      manta: q('.fco-manta'),
      laptop: q('.fco-laptop'),
      cue: q('.fco-cue'),
      ground: q('.ln-ground'),
      trail: q('.ln-trail'),
      link: q('.ln-link'),
      pulse: q('.ln-pulse'),
      antenna: q('.ln-antenna'),
      antennaTip: q('.ln-antenna-tip'),
      arcs: Array.from(view.querySelectorAll('.ln-arc')),
      signal: q('.ln-signal'),
      head: q('.ln-signal-head'),
      L: null,
    };
  }

  const setLine = (el, x1, y1, x2, y2) => {
    el.setAttribute('x1', x1.toFixed(2)); el.setAttribute('y1', y1.toFixed(2));
    el.setAttribute('x2', x2.toFixed(2)); el.setAttribute('y2', y2.toFixed(2));
  };
  const setDot = (el, x, y) => { el.setAttribute('cx', x.toFixed(2)); el.setAttribute('cy', y.toFixed(2)); };
  const setOpacity = (el, op) => {
    el.style.opacity = op >= 1 ? '' : op.toFixed(3);
    el.style.visibility = op <= 0 ? 'hidden' : '';
  };

  /* ── Fit the scene to a frame ────────────────────────────
     region: the part of the view the scene is framed in (px, from the view's top
     left corner). Works out the camera for each step, places Manta and the laptop,
     and draws the lines that don't move. */
  function layoutScene(sc, region, stacked, viewW) {
    const L = { cx: region.x + region.w / 2, cy: region.y + region.h / 2 };
    sc.L = null;
    sc.world.style.setProperty('--px', '1px');

    /* Step 1: the board fills most of the frame */
    L.sA = Math.min(region.w * 0.8 / BOARD.w, region.h * 0.74 / BOARD.h);

    /* Steps 2 and 3 share one scale and one height: from the nose of the risen rocket
       down to just under the ground. In step 2 the rocket stands on the ground in the
       middle, with sky above it, so in step 3 it can climb up the screen while the
       view only slides sideways to take in Manta. */
    const top = -RISE - 30, bottom = GROUND + 40;
    L.sB = Math.min(region.w / (2 * FIN_X + 40), region.h / (bottom - top));
    L.sC = L.sB;
    L.gy = region.y + region.h - 40 * L.sB;            /* the ground's height on screen in steps 2 to 4 */
    L.camB = { s: L.sB, x: 0, y: (L.cy - (L.gy - L.sB * GROUND)) / L.sB };

    /* For step 2's still picture only: the top of the rocket, from the nose tip down
       past the avionics bay, so the board in its window is big enough to make out */
    const bayTop = -14, bayBottom = 354;
    L.camBay = { s: region.h / (bayBottom - bayTop), x: 0, y: (bayTop + bayBottom) / 2 };

    /* Step 3: the rocket on the left and Manta on the right, on the same ground line */
    const label = clamp(region.w * 0.019, 12, 16);     /* label text size on screen, px */

    sc.manta.style.fontSize = `${label / L.sC}px`;
    const mW = sc.manta.offsetWidth, mH = sc.manta.offsetHeight;   /* scene units (transforms don't count) */
    const rocketX = region.x + Math.max(region.w * (stacked ? 0.17 : 0.24), FIN_X * L.sC + 8);
    let mantaLeft = region.x + region.w * (stacked ? 0.47 : 0.56);
    mantaLeft = Math.min(mantaLeft, region.x + region.w - mW * L.sC);
    mantaLeft = Math.max(mantaLeft, rocketX + FIN_X * L.sC + 12);
    const txC = rocketX, tyC = L.gy - L.sC * GROUND;
    L.camC = { s: L.sC, x: (L.cx - txC) / L.sC, y: (L.cy - tyC) / L.sC };
    L.manta = { x: (mantaLeft - txC) / L.sC, w: mW, h: mH };

    /* Step 4: a little closer, with the ground at the same height on screen, and the
       laptop in the middle of the frame. Manta is far enough left to be out of view. */
    L.sD = L.sC * (stacked ? 1.12 : 1.25);
    const room = L.gy - region.y;                      /* frame top to the ground, px */
    let lapPx = Math.min(region.w * 0.84, 640);
    sc.laptop.style.fontSize = `${label / L.sD}px`;
    for (let i = 0; i < 3; i++) {
      sc.laptop.style.width = `${lapPx / L.sD}px`;
      const hPx = sc.laptop.offsetHeight * L.sD;
      if (hPx <= room - 6) break;
      lapPx *= (room - 6) / hPx;
    }
    const lapW = sc.laptop.offsetWidth, lapH = sc.laptop.offsetHeight;
    const lapLeft = region.x + (region.w - lapW * L.sD) / 2;
    const gapPx = lapLeft + 24 + 0.05 * region.w;      /* Manta's right edge ends this far left of the laptop */
    /* ...and far enough right that none of it shows in step 3 */
    const lapX = Math.max(L.manta.x + mW + gapPx / L.sD, (viewW + 30 - txC) / L.sC);
    L.lap = { x: lapX, w: lapW, h: lapH };
    const txD = lapLeft - L.sD * L.lap.x;
    L.camD = { s: L.sD, x: (L.cx - txD) / L.sD };

    /* Place Manta and the laptop on the ground */
    sc.manta.style.left = `${L.manta.x}px`;
    sc.manta.style.bottom = `${-GROUND}px`;
    sc.laptop.style.left = `${L.lap.x}px`;
    sc.laptop.style.bottom = `${-GROUND}px`;

    /* Lines that don't move: the ground, Manta's antenna and the cable */
    setLine(sc.ground, -4000, GROUND, L.lap.x + lapW + 4000, GROUND);
    const antX = L.manta.x + mW * 0.8, antBase = GROUND - mH;
    const antTop = antBase - (label * 2.4) / L.sC;
    setLine(sc.antenna, antX, antBase, antX, antTop);
    setDot(sc.antennaTip, antX, antTop);
    L.ant = { x: antX, y: antTop };
    /* Two pairs of short arcs on either side of the antenna's tip, for when the signal
       arrives. They stay clear of the signal line, which comes in from above. */
    const arc = (r, from, to) => {
      const a1 = (from * Math.PI) / 180, a2 = (to * Math.PI) / 180;
      return `M${(antX + r * Math.cos(a1)).toFixed(2)} ${(antTop + r * Math.sin(a1)).toFixed(2)} ` +
             `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(antX + r * Math.cos(a2)).toFixed(2)} ${(antTop + r * Math.sin(a2)).toFixed(2)}`;
    };
    /* The signal comes in at this angle (degrees, measured the way SVG does, with y
       down), so the left arcs stop short of it and the right ones mirror them */
    const inAngle = (Math.atan2((BOARD.y - RISE) - antTop, BODY_X - antX) * 180) / Math.PI + 360;
    const up = clamp(inAngle - 180 - 16, 6, 25), down = 25;
    sc.arcs.forEach((el, i) => {
      const r = (label * (0.75 + i * 0.6)) / L.sC;
      el.setAttribute('d', `${arc(r, 180 - down, 180 + up)} ${arc(r, -up, down)}`);
    });
    const baseH = sc.laptop.querySelector('.fco-laptop-base');
    const linkY = GROUND - (baseH ? baseH.offsetHeight / 2 : 6);
    L.link = { x1: L.manta.x + mW, x2: L.lap.x + lapW * 0.012, y: linkY };
    setLine(sc.link, L.link.x1, linkY, L.link.x2, linkY);

    sc.L = L;
  }

  /* ── Draw the scene at scroll progress p (0 to 1) ────────────
     cam, if given, names a fixed camera (L.camBay) to use in place of the tour's */
  function renderScene(sc, p, cam) {
    const L = sc.L;
    if (!L) return;
    const z = ease(seg(p, T.zoom));
    const r = ease(seg(p, T.rise));
    const d = ease(seg(p, T.pan));

    /* The camera */
    let s, tx, ty;
    if (cam && L[cam]) {
      s = L[cam].s;
      tx = L.cx - s * L[cam].x;
      ty = L.cy - s * L[cam].y;
    } else if (p < T.rise[0]) {
      /* Steps 1 to 2, anchored on the board: the scale changes at an even rate and
         the board glides from the middle of the frame to its spot in the rocket */
      s = L.sA * Math.pow(L.sB / L.sA, z);
      const endX = L.cx + L.sB * (BOARD.x - L.camB.x);
      const endY = L.cy + L.sB * (BOARD.y - L.camB.y);
      tx = lerp(L.cx, endX, z) - s * BOARD.x;
      ty = lerp(L.cy, endY, z) - s * BOARD.y;
    } else if (p < T.pan[0]) {
      /* Steps 2 to 3 */
      s = L.sB * Math.pow(L.sC / L.sB, r);
      tx = L.cx - s * lerp(L.camB.x, L.camC.x, r);
      ty = L.cy - s * lerp(L.camB.y, L.camC.y, r);
    } else {
      /* Steps 3 to 4: sideways along the ground, which stays at the same height */
      s = L.sC * Math.pow(L.sD / L.sC, d);
      tx = L.cx - s * lerp(L.camC.x, L.camD.x, d);
      ty = L.gy - s * GROUND;
    }
    sc.world.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(5)})`;
    sc.world.style.setProperty('--px', `${(1 / s).toFixed(5)}px`);
    /* The dots keep the same size on screen at any zoom (set as attributes, since
       not every browser takes a circle's radius from CSS) */
    sc.pulse.setAttribute('r', (4 / s).toFixed(3));
    sc.head.setAttribute('r', (4 / s).toFixed(3));
    sc.antennaTip.setAttribute('r', (3 / s).toFixed(3));

    /* The rocket fades in around the board, then rises */
    const rise = RISE * r;
    sc.rocket.style.transform = rise > 0 ? `translateY(${(-rise).toFixed(2)}px)` : '';
    setOpacity(sc.art, seg(p, T.rocket));
    setLine(sc.trail, 0, GROUND - 1, 0, GROUND - rise);
    setOpacity(sc.trail, r);

    /* Manta, its antenna and the cable */
    const mOp = seg(p, T.manta);
    [sc.manta, sc.antenna, sc.antennaTip, sc.link].forEach((el) => setOpacity(el, mOp));

    /* The radio signal, from the bay's side down to the antenna. The dashes run
       toward Manta as it goes. */
    const g = easeOut(seg(p, T.signal));
    const sx = BODY_X, sy = BOARD.y - rise;
    const hx = lerp(sx, L.ant.x, g), hy = lerp(sy, L.ant.y, g);
    setLine(sc.signal, sx, sy, hx, hy);
    sc.signal.style.strokeDashoffset = `${(-g * 42 / s).toFixed(3)}px`;
    setOpacity(sc.signal, g > 0 ? mOp : 0);
    setDot(sc.head, hx, hy);
    setOpacity(sc.head, g > 0 ? 1 - seg(g, [0.9, 1]) : 0);
    const arrived = seg(p, [T.signal[1] - 0.02, T.signal[1] + 0.02]);
    sc.arcs.forEach((arc) => setOpacity(arc, arrived * mOp));

    /* A pulse along the cable to the laptop */
    const k = seg(p, T.link);
    setDot(sc.pulse, lerp(L.link.x1, L.link.x2, k), L.link.y);
    setOpacity(sc.pulse, k > 0 ? Math.min(seg(k, [0, 0.08]), 1 - seg(k, [0.92, 1])) : 0);

    if (sc.cue) setOpacity(sc.cue, 1 - seg(p, T.cue));
  }

  /* ── The sentences beside the scene ─────────────────────── */
  function renderSteps(p) {
    steps.forEach((li, i) => {
      const fin = i === 0 ? 1 : seg(p, [SWITCH[i - 1], SWITCH[i - 1] + SWITCH_HALF]);
      const fout = i === steps.length - 1 ? 1 : 1 - seg(p, [SWITCH[i] - SWITCH_HALF, SWITCH[i]]);
      const op = Math.min(fin, fout);
      li.style.opacity = op.toFixed(3);
      /* A short drift: up into place on the way in, and on up on the way out */
      const drift = fin < 1 ? (1 - fin) * 10 : -(1 - fout) * 10;
      li.style.transform = drift ? `translateY(${drift.toFixed(1)}px)` : '';
    });
  }

  /* ── The tour (no reduced motion) ───────────────────────── */
  const main = makeScene(mainView);

  function layoutMain() {
    const vw = mainView.clientWidth, vh = mainView.clientHeight;
    if (!vw || !vh) return;
    const css = getComputedStyle(stage);
    const stacked = css.getPropertyValue('--fco-layout').trim() === 'stacked';
    const navH = nav ? nav.offsetHeight : 64;
    let region;
    if (stacked) {
      /* Below the soft edge under the nav (24 px in the CSS) */
      const top = navH + 18;
      region = { x: 16, y: top, w: vw - 32, h: vh - top - 30 };
    } else {
      const fade = parseFloat(css.getPropertyValue('--fco-fade')) || 48;
      const top = navH + 24, right = Math.max(24, vw * 0.04), bottom = Math.max(28, vh * 0.06);
      region = { x: fade + 8, y: top, w: vw - fade - 8 - right, h: vh - top - bottom };
    }
    layoutScene(main, region, stacked, vw);
    root.classList.add('fco-ready');
  }

  function progress() {
    const range = tour.offsetHeight - stage.offsetHeight;
    if (range <= 0) return 0;
    return clamp(-tour.getBoundingClientRect().top / range, 0, 1);
  }

  let queued = false;
  function frame() {
    queued = false;
    if (mode !== 'anim') return;
    const p = progress();
    renderScene(main, p);
    renderSteps(p);
  }
  function queue() {
    if (!queued) { queued = true; requestAnimationFrame(frame); }
  }

  /* ── Still pictures (reduced motion) ─────────────────────── */
  let stills = [];
  function buildStills() {
    stills = steps.map((li, i) => {
      const v = mainView.cloneNode(true);
      v.classList.add('fco-still');
      const cue = v.querySelector('.fco-cue');
      if (cue) cue.remove();
      v.querySelectorAll('img').forEach((img) => { img.removeAttribute('fetchpriority'); });
      li.insertBefore(v, li.firstChild);
      return { sc: makeScene(v), p: STILL_AT[i], cam: STILL_CAM[i] };
    });
  }
  function layoutStills() {
    stills.forEach(({ sc, p, cam }) => {
      const w = sc.view.clientWidth, h = sc.view.clientHeight;
      if (!w || !h) return;
      layoutScene(sc, { x: w * 0.05, y: h * 0.07, w: w * 0.9, h: h * 0.86 }, w / h < 1.45, w);
      renderScene(sc, p, cam);
    });
  }

  /* ── Switching between the two ───────────────────────────── */
  let mode = null;
  function setMode() {
    const next = reducedMQ.matches ? 'static' : 'anim';
    if (next === mode) return;
    mode = next;
    root.classList.toggle('fco-anim', next === 'anim');
    root.classList.toggle('fco-static', next === 'static');
    if (next === 'static') {
      steps.forEach((li) => { li.style.opacity = ''; li.style.transform = ''; });
      if (!stills.length) buildStills();
      layoutStills();
    } else {
      stills.forEach(({ sc }) => sc.view.remove());
      stills = [];
      layoutMain();
      frame();
    }
  }
  function relayout() {
    if (mode === 'anim') { layoutMain(); queue(); }
    else if (mode === 'static') layoutStills();
  }

  setMode();
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', relayout);
  if (reducedMQ.addEventListener) reducedMQ.addEventListener('change', setMode);
  /* The labels' widths depend on the fonts, so measure again once they arrive */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
})();
