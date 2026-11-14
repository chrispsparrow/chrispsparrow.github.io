// panels.js
// The console's two panels, side by side in one sliding track, like the
// pages of a monitor: the 3D view ('globe') and the graphs and readings
// ('data'). One is on screen at a time.
//
//   - The bracket buttons at the edges switch them: [ GRAPHS ] at the
//     right edge of the 3D view and [ MAP ] at the left edge of the graphs.
//     Only the one toward the other panel shows.
//   - The left and right arrow keys switch them too, unless keyboard focus
//     is in something that uses those keys itself: the 3D view (its own
//     camera keys), a graph (picks a time), the altitude timeline, the
//     saved flights dropdown, a form field, or anything that scrolls
//     sideways. Keys with Alt, Ctrl, Meta or Shift held are left alone.
//   - The panel off screen is inert, so the keyboard and screen readers
//     skip it.
//   - The slide itself is CSS (a transform on the track). With reduced
//     motion there is no slide (flight-console.css). Nothing else may
//     move the track sideways, so a sideways scroll is undone at once.
//
// The panel on screen is data-panel on the console, which the CSS reads.
//
// Used by: main.js.

const ORDER = ['globe', 'data'];

// Where the arrow keys belong to the thing that has focus.
const KEEP_ARROWS = [
  '.fc-globe-canvas',      // the 3D view's camera
  '.fc-map-canvas',        // the 2D map, if the 3D view failed
  '.leaflet-container',
  '.bc-graph-canvas',      // a graph picks a time
  '.fc-tl-track',          // the altitude timeline
  '.fc-dd',                // the saved flights dropdown
  'pre',                   // the raw serial output
  'input', 'select', 'textarea', '[contenteditable]',
  '[role="slider"]', '[role="listbox"]', '[role="menu"]', '[role="tablist"]',
].join(', ');

// root is the console. options:
//   onChange(name)   after a switch, with the panel now on screen
export function createPanels(root, { onChange } = {}) {
  const panels = Object.fromEntries(ORDER.map((name) => [name, root.querySelector(`[data-screen="${name}"]`)]));
  const prev = root.querySelector('#fc-flip-prev');
  const next = root.querySelector('#fc-flip-next');
  let current = root.dataset.panel && ORDER.includes(root.dataset.panel) ? root.dataset.panel : ORDER[0];

  function apply() {
    root.dataset.panel = current;
    for (const name of ORDER) {
      const off = name !== current;
      panels[name]?.toggleAttribute('inert', off);
    }
    // Only the switch toward the other panel shows.
    const i = ORDER.indexOf(current);
    if (prev) prev.hidden = i === 0;
    if (next) next.hidden = i === ORDER.length - 1;
  }

  // name is 'globe' or 'data'.
  function show(name) {
    if (!ORDER.includes(name) || name === current) return;
    const active = document.activeElement;
    const wasOnSwitch = active === prev || active === next;
    const wasInOld = Boolean(panels[current]?.contains(active));
    current = name;
    apply();
    // A switch that just hid, or a control in the panel that just went
    // inert, can't keep focus. It moves to the switch that shows now.
    if (wasOnSwitch || wasInOld) [prev, next].find((b) => b && !b.hidden)?.focus({ preventScroll: true });
    onChange?.(current);
  }

  function step(dir) {
    const i = ORDER.indexOf(current) + dir;
    if (i >= 0 && i < ORDER.length) show(ORDER[i]);
  }

  function arrowsBelongTo(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest(KEEP_ARROWS)) return true;
    // Anything that scrolls sideways (the raw output, a phase strip that
    // doesn't fit) keeps its arrow keys.
    for (let el = target; el && el !== root; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const x = getComputedStyle(el).overflowX;
        if (x === 'auto' || x === 'scroll') return true;
      }
    }
    return false;
  }

  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (root.hidden) return;
    if (arrowsBelongTo(e.target)) return;
    // Outside the console (the site nav, say), the keys do what they
    // always do.
    if (e.target instanceof Element && e.target !== document.body && !root.contains(e.target)) return;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const i = ORDER.indexOf(current) + dir;
    if (i < 0 || i >= ORDER.length) return;
    e.preventDefault();
    show(ORDER[i]);
  }

  // The track only ever moves by its CSS transform. Its box hides what
  // overflows, but a script or the browser (scrollIntoView, focus, find in
  // page) can still scroll it sideways, which would leave the panels out of
  // line with the window. So any sideways scroll is put straight back.
  const screens = root.querySelector('.fc-screens');
  const onScroll = () => { if (screens.scrollLeft !== 0) screens.scrollLeft = 0; };

  const onPrev = () => step(-1);
  const onNext = () => step(1);
  prev?.addEventListener('click', onPrev);
  next?.addEventListener('click', onNext);
  screens?.addEventListener('scroll', onScroll);
  document.addEventListener('keydown', onKeyDown);
  apply();

  return {
    show,
    current: () => current,
    destroy() {
      prev?.removeEventListener('click', onPrev);
      next?.removeEventListener('click', onNext);
      screens?.removeEventListener('scroll', onScroll);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
