'use strict';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH   = window.matchMedia('(hover: none)').matches;

/* ── INTRO ───────────────────────────────────────────────── */
(function () {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  document.body.classList.add('intro-active');

  const el       = document.getElementById('intro');
  const siteWrap = document.getElementById('site-wrap');

  /* Signals hero ripple to begin — fires exactly once from either exit path */
  let doneFired = false;
  const fireDone = () => {
    if (!doneFired) { doneFired = true; document.dispatchEvent(new Event('intro-done')); }
  };

  /* Instant reveal: no transition (reduced-motion path only) */
  const skipNow = () => {
    fireDone();
    if (el) el.classList.add('gone');
    const sr = document.getElementById('splash-rings');
    if (sr) sr.style.display = 'none';
    if (siteWrap) siteWrap.classList.add('revealed');
    document.body.classList.remove('intro-active');
  };

  /* Animated reveal: overlay fades out while site expands from center via clip-path */
  const reveal = () => {
    fireDone();
    if (el) {
      el.style.opacity = '0';  /* triggers the 0.25s #intro transition */
      const gone = () => el.classList.add('gone');
      el.addEventListener('transitionend', gone, { once: true });
      setTimeout(gone, 400);   /* fallback if transitionend never fires */
    }
    if (!siteWrap) { document.body.classList.remove('intro-active'); return; }
    siteWrap.classList.add('revealing');
    siteWrap.addEventListener('transitionend', () => {
      siteWrap.classList.remove('revealing');
      siteWrap.classList.add('revealed');
      document.body.classList.remove('intro-active');
    }, { once: true });
  };

  if (!el)     { skipNow(); return; }
  if (REDUCED) { skipNow(); return; }

  /* Only play the intro on a fresh entry or a reload of the main page — never
     when returning from one of our own project pages (e.g. clicking the name or
     "← Selected Work"). We detect that via the referrer being a /projects/ page
     or the Flight Console. */
  let cameFromProject = false;
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      cameFromProject = ref.origin === location.origin &&
        (ref.pathname.includes('/projects/') || ref.pathname.includes('/flight-console/'));
    }
  } catch (_) { /* malformed referrer — treat as fresh entry */ }
  if (cameFromProject) { skipNow(); return; }

  const rings = document.getElementById('splash-rings');
  const bloom = el.querySelector('.intro-bloom');
  const video = el.querySelector('.intro-video');

  /* Idempotent: fades video, fires bloom + rings, then animated reveal */
  let triggered = false;
  let safetyTimer = null;

  const triggerBloom = () => {
    if (triggered) return;
    triggered = true;
    clearTimeout(safetyTimer);
    if (video) video.style.opacity = '0';
    if (bloom) bloom.classList.add('splashed');  /* brief bloom as overlay fades */
    if (rings) {
      rings.classList.add('splashed');
      /* Rings scale up huge (visual only) then rest at opacity 0. Being
         position:fixed they escape body/html overflow clipping and would leave
         a phantom horizontal scroll, so remove them once the ripple finishes. */
      setTimeout(() => { rings.style.display = 'none'; }, 3500);
    }
    reveal();
  };

  /* Safety: fire bloom if video never ends (stall / error / missing) */
  safetyTimer = setTimeout(triggerBloom, 4000);

  if (video) {
    video.addEventListener('ended', triggerBloom, { once: true });
    video.addEventListener('error', triggerBloom, { once: true });  /* all sources failed */
    const pp = video.play();
    if (pp !== undefined) pp.catch(triggerBloom);  /* autoplay blocked */
  } else {
    triggerBloom();
  }

  /* Any user input: cancel video and fire bloom + reveal */
  document.addEventListener('keydown',    triggerBloom, { once: true });
  document.addEventListener('wheel',      triggerBloom, { once: true, passive: true });
  document.addEventListener('touchstart', triggerBloom, { once: true, passive: true });
  document.addEventListener('click',      triggerBloom, { once: true });
  el.querySelector('.intro-skip')?.addEventListener('click', triggerBloom, { once: true });
})();

/* ── NAV SCROLL ──────────────────────────────────────────── */
(function () {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 55);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const btn = nav.querySelector('.nav-hamburger');
  const links = nav.querySelector('.nav-links');
  if (btn && links) {
    btn.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
    });
    links.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => { links.classList.remove('open'); btn.setAttribute('aria-expanded', false); });
    });
  }
})();

/* ── ANCHOR SCROLL OFFSET ────────────────────────────────── */
(function () {
  const nav = document.getElementById('nav');
  /* Document offset via the offsetTop chain. A sticky element's offsetTop moves
     with it while it's pinned, so for one of those, start from the element
     before it (sticky too, for #work) and add that element's height, or from
     the top of its parent if it comes first. That gives its spot in the normal
     page flow no matter how far down the page you are. */
  const isSticky = (el) => getComputedStyle(el).position === 'sticky';
  const docTop = (el) => {
    if (isSticky(el)) {
      let prev = el.previousElementSibling;
      while (prev && !prev.offsetParent) prev = prev.previousElementSibling;
      const parent = el.parentElement;
      return prev ? docTop(prev) + prev.offsetHeight
                  : docTop(parent) + parseFloat(getComputedStyle(parent).paddingTop);
    }
    /* Inside a sticky element (a Coming soon card in #work), that element's
       offsetTop moves with the scroll too, so use its flow spot from there. */
    let y = 0;
    for (let p = el; p; p = p.offsetParent) {
      if (p !== el && isSticky(p)) return y + docTop(p);
      y += p.offsetTop;
    }
    return y;
  };
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      /* #work is the sticky Selected Work band: land exactly at its flow top so
         it pins under the nav and fully covers the hero (no leftover sliver).
         Other sections sit below the fixed nav, so offset by the nav height. */
      const gap = (id === 'work') ? 0 : (nav ? nav.getBoundingClientRect().height : 64) + 32;
      /* Coming soon cards get a scroll-margin-top (set below) so the scroll
         stops where #work pins, before the avionics panel covers them. */
      const margin = (id === 'work') ? 0 : (parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
      const top = docTop(target) - gap - margin;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      history.pushState(null, '', '#' + id);
    });
  });
})();

/* ── SELECTED WORK PIN AND COMING SOON SLIDE ─────────────── */
/* #work holds the heading and the Coming soon cards. --work-pin (window height
   minus band height, never above 0) makes it pin once its bottom reaches the
   bottom of the window, and then the avionics panel slides up over it.
   On wide screens with motion, .soon-slide makes the band fill the window and
   keeps the cards at a two-across size, so the third card starts off to the
   right. .work-slide-space adds scroll room after the band pins, and while
   that scrolls past, the row slides left until the last card is in view.
   Each card also gets a scroll-margin-top so a link to it (like
   ../#ground-station) stops where the band pins, instead of scrolling far
   enough that the avionics panel covers the card. */
(function () {
  const work = document.getElementById('work');
  if (!work) return;
  const track = work.querySelector('.coming-soon-grid');
  const space = document.querySelector('.work-slide-space');
  const cards = work.querySelectorAll('.soon-card[id]');
  const PACE = 1.2;    // px of page scroll per px the row moves
  const HOLD = 0.12;   // share of the window height to scroll before the row moves, and again after
  let travel = 0, hold = 0;

  /* Where the band pins: its bottom (the top of the scroll room) meets the bottom of the window */
  const pinStart = () => space.getBoundingClientRect().top + window.scrollY - window.innerHeight;

  const slide = () => {
    if (!travel) return;
    const p = Math.min(Math.max((window.scrollY - pinStart() - hold) / (travel * PACE), 0), 1);
    track.style.transform = `translate3d(${(-p * travel).toFixed(1)}px, 0, 0)`;
  };

  const layout = () => {
    const pinned = getComputedStyle(work).position === 'sticky';
    const sliding = pinned && !REDUCED && !!track && !!space;
    work.classList.toggle('soon-slide', sliding);
    travel = 0;
    if (track) track.style.transform = '';
    if (sliding) {
      const last = track.lastElementChild;
      travel = Math.max(0, Math.ceil(last.getBoundingClientRect().right - track.getBoundingClientRect().right));
    }
    hold = window.innerHeight * HOLD;
    if (space) space.style.height = travel ? Math.round(travel * PACE + 2 * hold) + 'px' : '';

    const pin = Math.min(0, window.innerHeight - work.offsetHeight);
    work.style.setProperty('--work-pin', pin + 'px');
    const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    cards.forEach(c => {
      let top = 0;   // the card's top inside the band
      for (let p = c; p && p !== work; p = p.offsetParent) top += p.offsetTop;
      c.style.scrollMarginTop = pinned ? Math.max(0, top + pin - pad) + 'px' : '';
    });
    slide();
  };

  let raf = 0;
  window.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; slide(); });
  }, { passive: true });
  window.addEventListener('resize', layout);
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(work);
  layout();

  /* Tabbing to the link in the last card while it's still off to the right,
     or (Shift+Tab) while the avionics panel already covers the band: scroll
     to where the row has finished sliding, so the link is on screen. */
  if (track) track.addEventListener('focusin', (e) => {
    if (!travel) return;
    const r = e.target.getBoundingClientRect();
    const covered = window.scrollY > pinStart() + space.offsetHeight;
    if (!covered && r.left >= 0 && r.right <= window.innerWidth) return;
    const p = r.left < 0 ? 0 : 1;
    window.scrollTo({ top: pinStart() + hold + p * travel * PACE });
  });
})();

/* ── HERO PARALLAX ───────────────────────────────────────── */
/* The hero content drifts opposite the cursor. It eases toward its target
   each frame, so the bigger movement glides instead of snapping. */
(function () {
  if (REDUCED) return;
  const content = document.querySelector('#hero .hero-content');
  if (!content) return;

  const RANGE = 40;    // px of travel across the whole screen (±20px from center)
  const EASE  = 0.08;  // share of the remaining distance covered each frame
  let tx = 0, ty = 0, x = 0, y = 0, running = false;

  const step = () => {
    x += (tx - x) * EASE;
    y += (ty - y) * EASE;
    content.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    if (Math.abs(tx - x) > 0.05 || Math.abs(ty - y) > 0.05) requestAnimationFrame(step);
    else running = false;
  };

  document.addEventListener('mousemove', (e) => {
    tx = (e.clientX / window.innerWidth  - 0.5) * -RANGE;
    ty = (e.clientY / window.innerHeight - 0.5) * -RANGE;
    if (!running) { running = true; requestAnimationFrame(step); }
  });
})();

/* ── HERO ENTRANCE (staggered fade after loader) ─────────── */
(function () {
  if (REDUCED) return;
  const frame = document.querySelector('.hero-frame');
  if (!frame) return;
  document.addEventListener('intro-done', () => {
    frame.classList.add('hero-enter');
  }, { once: true });
})();

/* ── HERO CURTAIN FADE ───────────────────────────────────── */
/* As #work rises over the sticky hero, gently fade + scale the hero frame
   so it feels covered rather than abruptly hidden. Skipped for reduced
   motion (falls back to a plain sticky curtain with no fade). */
(function () {
  if (REDUCED) return;
  const hero  = document.getElementById('hero');
  const frame = document.querySelector('.hero-frame');
  if (!hero || !frame) return;

  let raf = false;
  const update = () => {
    raf = false;
    const h = window.innerHeight || 1;
    const p = Math.min(Math.max(window.scrollY / (h * 0.85), 0), 1);
    frame.style.opacity   = String(1 - p);
    frame.style.transform = `scale(${1 - p * 0.06})`;
  };
  const onScroll = () => {
    if (raf) return;
    raf = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  update();
})();

/* ── SCROLL REVEAL ───────────────────────────────────────── */
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  if (REDUCED) { els.forEach(e => e.classList.add('visible')); return; }
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('visible'); obs.unobserve(en.target); }
    });
  }, { threshold: 0.12 });
  els.forEach(e => obs.observe(e));
})();

/* ── PROJECT CARD TOUCH-SWAP ─────────────────────────────── */
(function () {
  if (!TOUCH) return;
  document.querySelectorAll('.project-card[data-swap]').forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const was = card.classList.contains('tapped');
      document.querySelectorAll('.project-card').forEach(c => c.classList.remove('tapped'));
      if (was) {
        window.location.href = card.href;
      } else {
        card.classList.add('tapped');
      }
    });
  });
})();

/* ── COPY TO CLIPBOARD ───────────────────────────────────── */
(function () {
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
      } catch (_) {
        /* clipboard blocked — no-op */
      }
    });
  });
})();

/* ── COMPARISON SLIDER ───────────────────────────────────── */
(function () {
  document.querySelectorAll('.compare-wrap').forEach(wrap => {
    const clip   = wrap.querySelector('.compare-after-clip');
    const handle = wrap.querySelector('.compare-handle');
    if (!clip || !handle) return;

    let dragging = false;

    const setPos = (clientX) => {
      const r = wrap.getBoundingClientRect();
      const pct = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
      clip.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
      handle.style.left   = `${pct * 100}%`;
    };

    wrap.addEventListener('mousedown',  (e) => { dragging = true; setPos(e.clientX); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (dragging) setPos(e.clientX); });
    document.addEventListener('mouseup',   ()  => { dragging = false; });

    wrap.addEventListener('touchstart', (e) => { dragging = true; setPos(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchmove', (e) => { if (dragging) setPos(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend',  ()  => { dragging = false; });
  });
})();

/* ── BOARD HOTSPOTS ──────────────────────────────────────── */
(function () {
  const pts = document.querySelectorAll('.hotspot-pt');
  if (!pts.length) return;

  pts.forEach(pt => {
    pt.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = pt.classList.contains('active');
      pts.forEach(p => p.classList.remove('active'));
      if (!was) pt.classList.add('active');
    });
  });

  document.addEventListener('click', () => pts.forEach(p => p.classList.remove('active')));
})();

/* ── BUILD LOG KEYBOARD NAV ──────────────────────────────── */
(function () {
  document.querySelectorAll('.build-log').forEach(g => {
    g.setAttribute('tabindex', '0');
    g.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { g.scrollBy({ left:  320, behavior: 'smooth' }); e.preventDefault(); }
      if (e.key === 'ArrowLeft')  { g.scrollBy({ left: -320, behavior: 'smooth' }); e.preventDefault(); }
    });
  });
})();

/* ── AVIONICS 3D VIEWER ──────────────────────────────────── */
(function () {
  const mv = document.getElementById('av-viewer');
  if (!mv) return;

  const panel    = mv.closest('.card-viewer');
  const hint     = mv.querySelector('.av-hint');
  const progress = mv.querySelector('.av-progress');
  const fill     = mv.querySelector('.av-progress-fill');
  const resetBtn = mv.querySelector('.av-reset');

  const DEFAULT_ORBIT = '-32deg 58deg 105%';
  const DEFAULT_FOV   = '30deg';

  /* Reduced motion: no auto-rotate, no camera easing. */
  if (REDUCED) {
    mv.removeAttribute('auto-rotate');
    mv.setAttribute('interaction-prompt', 'none');
  }

  /* Download progress → thin gold bar. */
  mv.addEventListener('progress', (e) => {
    const p = e.detail.totalProgress;
    if (fill) fill.style.width = (p * 100) + '%';
    if (progress && p === 1) progress.classList.add('done');
  });

  /* Reveal RESET once the model is ready. */
  mv.addEventListener('load', () => { panel && panel.classList.add('loaded'); });

  /* Fade the "DRAG TO ROTATE" hint after the first real interaction. */
  const hideHint = () => hint && hint.classList.add('hidden');
  mv.addEventListener('pointerdown', hideHint, { once: true });
  mv.addEventListener('camera-change', (e) => {
    if (e.detail && e.detail.source === 'user-interaction') hideHint();
  });

  /* Desktop scroll-wheel must scroll the PAGE, not zoom the model.
     Stop the event before model-viewer's internal handler sees it, but
     don't preventDefault, so normal page scrolling continues.
     Touch pinch-zoom uses touch events, so it is unaffected. */
  mv.addEventListener('wheel', (e) => { e.stopImmediatePropagation(); }, { capture: true });

  /* RESET → smoothly return to the default three-quarter view. */
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mv.setAttribute('camera-orbit', DEFAULT_ORBIT);
      mv.setAttribute('field-of-view', DEFAULT_FOV);
      if (REDUCED && typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
    });
  }
})();

/* ── FLIGHT CONSOLE PICTURE LINK ─────────────────────────── */
/* The link over the picture is for a mouse click or a tap, and it is hidden
   from screen readers, so it must never hold focus. A click still opens the
   console. */
(function () {
  const open = document.querySelector('.console-open');
  if (open) open.addEventListener('mousedown', (e) => e.preventDefault());
})();

/* ── HERO RINGS ──────────────────────────────────────────── */
/* One pulse after the page loads. The rings spread out once and then fade
   away (CSS), leaving the hero plain black. The pulse waits for the hero to
   be on screen with the tab showing, and pauses if either changes mid-pulse. */
(function () {
  if (REDUCED) return;

  const hero      = document.getElementById('hero');
  const container = document.getElementById('hero-ripple');
  if (!hero || !container) return;

  const slot  = container.querySelector('.pulse-slot');
  const frame = hero.querySelector('.hero-frame');
  if (!slot) return;

  let started = false;
  let heroVis = false;

  /* The hero is sticky, so the observer still sees it while the next section
     covers it. The scroll fade above takes the frame to opacity 0 by then,
     so count that as off screen too. */
  const covered = () => !!frame && parseFloat(frame.style.opacity) < 0.03;

  function update() {
    const play = started && heroVis && !covered() && !document.hidden;
    if (play) slot.classList.add('firing');   /* only ever added once */
    container.classList.toggle('paused', !play);
  }

  new IntersectionObserver((entries) => {
    heroVis = entries[entries.length - 1].isIntersecting;
    update();
  }, { threshold: 0 }).observe(hero);

  document.addEventListener('visibilitychange', update);

  /* Once the pulse has faded out it is gone for good. Removing it also keeps
     it from replaying if reduced motion is switched on and off again. */
  slot.addEventListener('animationend', (e) => {
    if (e.target === slot && e.animationName === 'heroRingsOut') container.remove();
  });
  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; update(); });
  }, { passive: true });

  /* Start when the intro hands off. Coming back from a project page skips
     the intro, and then 'intro-done' fires before this code runs, so also
     check whether the site is already revealed. */
  const begin = () => { started = true; update(); };
  const wrap = document.getElementById('site-wrap');
  if (!wrap || wrap.classList.contains('revealing') || wrap.classList.contains('revealed')) begin();
  else document.addEventListener('intro-done', begin, { once: true });
})();
