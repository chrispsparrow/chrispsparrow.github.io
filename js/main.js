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
    if (rings) rings.classList.add('splashed');
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

/* ── HERO PARALLAX ───────────────────────────────────────── */
(function () {
  if (REDUCED) return;
  const hero    = document.getElementById('hero');
  const sonar   = hero?.querySelector('.hero-sonar');
  const content = hero?.querySelector('.hero-content');
  if (!sonar && !content) return;

  let raf = false;
  document.addEventListener('mousemove', (e) => {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => {
      const dx = (e.clientX / window.innerWidth  - 0.5);
      const dy = (e.clientY / window.innerHeight - 0.5);
      if (sonar)   sonar.style.transform   = `translate(${dx * 22}px, ${dy * 22}px)`;
      if (content) content.style.transform = `translate(${dx * -7}px, ${dy * -7}px)`;
      raf = false;
    });
  });
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

/* ── HERO AMBIENT RIPPLE ─────────────────────────────────── */
(function () {
  if (REDUCED) return;

  const hero      = document.getElementById('hero');
  const container = document.getElementById('hero-ripple');
  if (!hero || !container) return;

  const slots = Array.from(container.querySelectorAll('.pulse-slot'));
  if (!slots.length) return;

  let slotIdx = 0;
  let pumpId  = null;
  let running = false;
  let started = false;
  let heroVis = false;

  function firePulse() {
    const slot = slots[slotIdx % slots.length];
    slotIdx++;
    slot.classList.remove('firing');
    void slot.offsetWidth; /* restart CSS animation */
    slot.classList.add('firing');
  }

  function pump() {
    if (!running) return;
    firePulse();
    pumpId = setTimeout(pump, 2800);
  }

  function startPulsing() {
    if (running) return;
    running = true;
    pump();
  }

  function stopPulsing() {
    running = false;
    clearTimeout(pumpId);
    pumpId = null;
  }

  /* Pause when hero scrolls out of view */
  const obs = new IntersectionObserver((entries) => {
    heroVis = entries[0].isIntersecting;
    if (!heroVis) stopPulsing();
    else if (started && !document.hidden) startPulsing();
  }, { threshold: 0 });
  obs.observe(hero);

  /* Pause when tab is hidden */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPulsing();
    else if (started && heroVis) startPulsing();
  });

  /* Start as soon as the intro hands off; fade to ambient level after 5 s */
  document.addEventListener('intro-done', () => {
    started = true;
    if (heroVis && !document.hidden) startPulsing();
    setTimeout(() => container.classList.add('ambient'), 5000);
  }, { once: true });
})();

/* ── FLASHLIGHT REVEAL ───────────────────────────────── */
(function () {
  if (REDUCED) return;

  const MAX_R   = 110;   /* spotlight radius px */
  const FEATHER = 0.60;  /* transparent-core fraction (feather starts here) */
  const LP_POS  = 0.15;  /* position lerp factor per frame */
  const LP_R    = 0.10;  /* radius lerp factor per frame */

  function initFlashlight(wrap) {
    const base = wrap.querySelector('.fl-base');
    if (!base) return;

    let mx = 0, my = 0;   /* target cursor position (container-relative) */
    let cx = 0, cy = 0;   /* current lerped position */
    let cr = 0, tr = 0;   /* current / target radius */
    let rafId = null, entered = false;

    function applyMask() {
      if (cr < 0.5) {
        base.style.webkitMaskImage = '';
        base.style.maskImage = '';
      } else {
        const g = `radial-gradient(circle ${cr.toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px, transparent ${Math.round(FEATHER * 100)}%, black 100%)`;
        base.style.webkitMaskImage = g;
        base.style.maskImage = g;
      }
    }

    function tick() {
      rafId = null;
      cx += (mx - cx) * LP_POS;
      cy += (my - cy) * LP_POS;
      cr += (tr - cr) * LP_R;
      applyMask();
      if (Math.abs(mx - cx) > 0.3 || Math.abs(my - cy) > 0.3 || Math.abs(tr - cr) > 0.3)
        rafId = requestAnimationFrame(tick);
    }

    function sched() { if (!rafId) rafId = requestAnimationFrame(tick); }

    wrap.addEventListener('pointermove', function (e) {
      const r = wrap.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      if (!entered) { cx = mx; cy = my; entered = true; }
      tr = MAX_R;
      sched();
    });

    wrap.addEventListener('pointerleave', function () {
      tr = 0;
      entered = false;
      sched();
    });
  }

  document.querySelectorAll('.fl-wrap').forEach(initFlashlight);
})();
