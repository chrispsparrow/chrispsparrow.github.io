'use strict';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH   = window.matchMedia('(hover: none)').matches;

/* ── INTRO ───────────────────────────────────────────────── */
(function () {
  const el = document.getElementById('intro');
  if (!el) return;
  if (REDUCED) { el.classList.add('gone'); return; }

  const dismiss = () => {
    el.classList.add('fade-out');
    el.addEventListener('transitionend', () => el.classList.add('gone'), { once: true });
    document.removeEventListener('keydown', dismiss);
  };

  setTimeout(dismiss, 1150);
  document.addEventListener('keydown', dismiss);
  el.querySelector('.intro-skip')?.addEventListener('click', dismiss);
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
