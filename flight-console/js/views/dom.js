// dom.js
// Tiny helpers the views share for building page elements and for limiting
// how often a view redraws while a flight plays.
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
