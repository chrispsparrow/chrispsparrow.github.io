// dom.js
// Tiny helpers the views share for building page elements (HTML and SVG),
// for limiting how often a view redraws while a flight plays, and for
// drawing events the same way everywhere.
// Used by: every file in js/views/ and main.js.

// Creates an element. attrs sets properties and attributes:
//   h('button', { class: 'fc-btn', type: 'button', onclick: fn }, 'Play')
// Children can be strings, elements, arrays, null or false.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      // CSS variables like --dot need setProperty; plain assignment ignores them.
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Replaces everything inside an element.
export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

// Sets text only when it changed, so screen readers and the browser don't
// redo work for identical updates.
export function setText(el, text) {
  const value = String(text ?? '');
  if (el.textContent !== value) el.textContent = value;
}

// Creates an SVG element (svg, path, circle, ...). Attributes are set as
// they are, children work like h().
//   svg('circle', { cx: 4, cy: 4, r: 3, class: 'fc-x' })
const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

// True when the viewer asked for less motion. Read fresh each time, so a
// change in the system setting applies without a reload.
export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// How an event was found, as the timeline markers and the mission timeline
// draw it: 'reported' (a filled dot), 'detected' (a gold ring) or 'inferred'
// (a dashed ring, also used for anything estimated). A liftoff whose time is
// estimated counts as estimated. state is that rocket's detector state.
export function eventMarkerKind(event, state) {
  if (event.basis === 'reported') return 'reported';
  if (event.basis === 'inferred') return 'inferred';
  if (event.type === 'liftoff' && state?.liftoffEstimated) return 'estimated';
  return 'detected';
}

// Plain words for each kind, for tooltips and screen readers.
export const MARKER_KIND_TEXT = Object.freeze({
  reported: 'reported by the board',
  detected: 'detected from altitude',
  inferred: 'inferred from the descent rate',
  estimated: 'time estimated',
});

// The CSS class for a kind's dot (estimated uses the dashed ring too).
export function markerClass(kind) {
  return `fc-basis fc-basis--${kind === 'estimated' ? 'inferred' : kind}`;
}

// A colored dot for a rocket. Decorative: the name next to it is the label.
export function rocketDot(color) {
  return h('span', { class: 'fc-dot', style: { '--dot': color }, 'aria-hidden': 'true' });
}

// Runs fn at most once per animation frame (and at most maxFps times a
// second), no matter how often schedule() is called. flush() runs it now.
export function createScheduler(fn, { maxFps = 30 } = {}) {
  let frame = null;
  let lastRun = 0;
  const minGapMs = 1000 / maxFps;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);

  function tick(ms) {
    frame = null;
    if (ms - lastRun < minGapMs) {
      frame = raf(tick);
      return;
    }
    lastRun = ms;
    fn();
  }
  return {
    schedule() { if (frame === null) frame = raf(tick); },
    flush() {
      if (frame !== null) caf(frame);
      frame = null;
      lastRun = performance.now();
      fn();
    },
    cancel() { if (frame !== null) caf(frame); frame = null; },
  };
}

// "September 30, 2026" from "2026-09-30", read as a calendar date (no time zone shift).
export function formatDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate ?? '';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}
