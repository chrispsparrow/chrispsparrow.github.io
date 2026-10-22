/* Sideways sliders on the avionics page (board photos, schematic sheets, layout views,
   and the three photo slots on the assembly slide).

   Each slider is a fixed-size frame ([data-viewer]) holding a stack of views, plus a
   pair of arrow buttons ([data-viewer-for="<frame id>"]). On slides 2 to 4 the arrows
   sit beside the slide's text. On slide 5 each photo slot has its own small pair under
   its photo. You can move between views with:
     - the arrows (the back arrow shows once you have moved past the first view,
       and the next arrow goes away on the last view)
     - the left and right arrow keys, while the mouse is over that slider (its picture
       or its arrows) or one of its arrows has the keyboard focus
     - a sideways trackpad scroll, or Shift with the mouse wheel, over that slider
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
  /* What a screen reader hears after a move: the view's name, or the photo's alt text */
  const label = (k) => {
    const img = views[k].querySelector('img');
    return views[k].getAttribute('aria-label') || (img && img.alt) || '';
  };
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
    loadNear();
    render(true);
    return true;
  }

  /* Only the first picture has a src in the page (the browser lazy loads it as usual).
     The others wait in data-src. Once the slide gets close, the picture showing and
     the ones on either side of it load, so the next one is ready before it slides in.
     The rest wait until you get next to them. */
  let near = false;
  function loadNear() {
    if (!near) return;
    for (let k = Math.max(0, index - 1); k <= Math.min(views.length - 1, index + 1); k++) {
      views[k].querySelectorAll('img[data-src]').forEach(img => {
        img.loading = 'eager';
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
    }
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { near = true; loadNear(); io.disconnect(); }
    }, { rootMargin: '150% 0px 150% 0px' });
    io.observe(section);
  } else {
    near = true;
    loadNear();
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

  /* Sideways trackpad scrolls and Shift with the mouse wheel, only while the mouse is
     over this slider. Only clearly sideways events are cancelled, so scrolling up and
     down over the picture still moves the page. */
  let acc = 0, locked = false, lockTimer = 0;
  function onWheel(e) {
    if (e.ctrlKey) return;                       /* ctrl + wheel is page zoom */
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
      go(acc > 0 ? 1 : -1);
      locked = true;
      acc = 0;
    }
  }
  root.addEventListener('wheel', onWheel, { passive: false });
  if (nav && !root.contains(nav)) nav.addEventListener('wheel', onWheel, { passive: false });

  render(false);
  root.classList.add('is-ready');
  if (nav) nav.classList.add('is-ready');
  return {
    go,
    owns: (el) => root.contains(el) || (!!nav && nav.contains(el)),
    hovered: () => root.matches(':hover') || (!!nav && nav.matches(':hover')),
  };
}

document.querySelectorAll('[data-viewer]').forEach(el => sliders.push(setup(el)));

/* ── Arrow keys ─────────────────────────────────────────────
   They move the slider under the mouse, or the one whose arrow has the focus (as long
   as that arrow is on screen). With neither, the keys do nothing here. When both are
   there and they differ, the one you used last wins: after moving the mouse or
   clicking, the slider under the mouse, and after Tab, the focused one. So you can
   click one slot's arrow, point at another slot, and the keys follow the mouse. */
let mouseLast = false;
document.addEventListener('pointermove', (e) => {
  /* A real move only. Chrome sends moves without movement when the page scrolls under a still mouse. */
  if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) mouseLast = true;
}, { passive: true });
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') mouseLast = true; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') mouseLast = false; }, true);

function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
}
function keySlider() {
  const f = document.activeElement;
  const focused = f && f !== document.body && onScreen(f) ? sliders.find(s => s.owns(f)) : null;
  const hovered = sliders.find(s => s.hovered());
  return (mouseLast ? hovered || focused : focused || hovered) || null;
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  const s = keySlider();
  if (s && s.go(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
});
