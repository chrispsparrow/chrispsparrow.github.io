/* Sideways sliders on the avionics page (schematic sheets, layout views).

   Each slider is a fixed-size frame ([data-viewer]) holding a stack of views, plus a
   pair of arrow buttons ([data-viewer-for="<frame id>"]) that sit beside the slide's
   text. You can move between views with:
     - the arrows (the back arrow shows once you have moved past the first view,
       and the next arrow goes away on the last view)
     - the left and right arrow keys, while that slide is in the middle of the window
     - a sideways trackpad scroll, or Shift with the mouse wheel, over that slide
     - a sideways swipe on the picture on a phone
   Only clearly sideways gestures are used. Up and down scrolling is never stopped or
   slowed, so the page always keeps scrolling down. The frame never changes size, so
   the slide stays where it is while the views slide. */

const sliders = [];

function setup(root) {
  const views = Array.from(root.querySelectorAll('.viewer-view'));
  const caps = Array.from(root.querySelectorAll('.viewer-caption'));
  const status = root.querySelector('[data-viewer-status]');
  const nav = document.querySelector(`[data-viewer-for="${root.id}"]`);
  const prev = nav && nav.querySelector('[data-dir="-1"]');
  const next = nav && nav.querySelector('[data-dir="1"]');
  const section = root.closest('.slide') || root;
  const label = (k) => views[k].getAttribute('aria-label') || '';
  let index = 0;

  function setButton(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-off', !on);
    btn.tabIndex = on ? 0 : -1;
    btn.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function render(announce) {
    const mark = (el, k) => {
      el.classList.toggle('is-before', k < index);
      el.classList.toggle('is-after', k > index);
      el.classList.toggle('is-current', k === index);
    };
    views.forEach((v, k) => {
      mark(v, k);
      const current = k === index;
      v.setAttribute('aria-hidden', current ? 'false' : 'true');
      v.inert = !current;
    });
    caps.forEach(mark);
    const focusedPrev = document.activeElement === prev;
    const focusedNext = document.activeElement === next;
    setButton(prev, index > 0);
    setButton(next, index < views.length - 1);
    /* Keep the keyboard focus on a visible arrow when one of them goes away */
    if (focusedNext && index === views.length - 1 && prev) prev.focus({ preventScroll: true });
    if (focusedPrev && index === 0 && next) next.focus({ preventScroll: true });
    if (announce && status) status.textContent = label(index);
  }

  function go(dir) {
    const n = Math.min(views.length - 1, Math.max(0, index + dir));
    if (n === index) return false;
    index = n;
    loadAll();
    render(true);
    return true;
  }

  /* Pictures past the first are off to the side, where lazy loading would not see
     them. Load them all once the slide gets close, so a slide never shows up blank. */
  let loaded = false;
  function loadAll() {
    if (loaded) return;
    loaded = true;
    root.querySelectorAll('img[loading="lazy"]').forEach(img => { img.loading = 'eager'; });
  }
  if ('IntersectionObserver' in window) {
    const near = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { loadAll(); near.disconnect(); }
    }, { rootMargin: '150% 0px 150% 0px' });
    near.observe(section);
  } else {
    loadAll();
  }

  if (prev) prev.addEventListener('click', () => go(-1));
  if (next) next.addEventListener('click', () => go(1));

  /* Sideways swipe on the picture (touch and pen). touch-action: pan-y on the frame
     leaves vertical swipes to the browser, which scrolls the page as usual. */
  const win = root.querySelector('.viewer-window');
  let sx = 0, sy = 0, pid = null, decided = false;
  win.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; decided = false;
  });
  win.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid || decided) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { decided = true; return; }   /* a scroll, not a swipe */
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) { decided = true; go(dx < 0 ? 1 : -1); }
  });
  const end = (e) => { if (e.pointerId === pid) pid = null; };
  win.addEventListener('pointerup', end);
  win.addEventListener('pointercancel', end);

  render(false);
  root.classList.add('is-ready');
  if (nav) nav.classList.add('is-ready');
  return { root, section, go };
}

document.querySelectorAll('[data-viewer]').forEach(el => sliders.push(setup(el)));

/* ── Which slider is in charge right now ───────────────────
   The one whose slide crosses the middle of the window. Keys and sideways scrolls
   only do something while a slider slide is there. */
let active = null;
if (sliders.length && 'IntersectionObserver' in window) {
  const inMiddle = new Set();
  const mid = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = sliders.find(x => x.section === e.target);
      if (!s) continue;
      if (e.isIntersecting) inMiddle.add(s); else inMiddle.delete(s);
    }
    setActive(inMiddle.size ? Array.from(inMiddle)[inMiddle.size - 1] : null);
  }, { rootMargin: '-49% 0px -49% 0px' });
  sliders.forEach(s => mid.observe(s.section));
}

/* Arrow keys */
document.addEventListener('keydown', (e) => {
  if (!active || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (active.go(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
});

/* Sideways trackpad scrolls and Shift with the mouse wheel. The listener is only
   attached while a slider slide is in the middle of the window, and it only ever
   cancels events that are clearly sideways, so up and down scrolling is untouched. */
let acc = 0, locked = false, lockTimer = 0;
function onWheel(e) {
  if (!active || e.ctrlKey) return;            /* ctrl + wheel is page zoom */
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerWidth : 1;
  let dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.shiftKey && Math.abs(dx) < Math.abs(dy)) { dx = dy; dy = 0; }   /* Shift + wheel, in browsers that keep it vertical */
  if (Math.abs(dx) < 2 || Math.abs(dx) <= Math.abs(dy) * 1.2) { acc = 0; return; }   /* up and down: leave it alone */
  e.preventDefault();                          /* also stops the browser's swipe-back gesture */
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { locked = false; acc = 0; }, 220);   /* one gesture moves one view */
  if (locked) return;
  acc += dx;
  if (Math.abs(acc) >= 40) {
    active.go(acc > 0 ? 1 : -1);
    locked = true;
    acc = 0;
  }
}
function setActive(s) {
  if (s === active) return;
  const had = !!active;
  active = s;
  acc = 0;
  if (active && !had) window.addEventListener('wheel', onWheel, { passive: false });
  if (!active && had) window.removeEventListener('wheel', onWheel, { passive: false });
}
