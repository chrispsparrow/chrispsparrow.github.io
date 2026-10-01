// phase-strip.js
// Six segments across the top of the console: Pad, Ascent, Apogee, Drogue,
// Main, Landed. They follow only the live detector's current phase for the
// focused rocket (never the simulator's truth):
//   passed        a solid muted bar, with the T+ time the phase began
//   current       a gold bar and gold text (aria-current="step")
//   not yet       a dim bar
//   not detected  an empty bar, for a phase before the current one that the
//                 detector never found (drogue and main when a rocket lands
//                 without them being inferred, or the pad when the data
//                 starts in flight), so it never looks passed
// Drogue and main are inferred from the descent rate, so their bars are
// dashed in every state. On phones the strip scrolls sideways and keeps the
// current phase in view.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler, prefersReducedMotion } from './dom.js';
import { formatFlightClock } from '../geo.js';

// The segments in order. event is the detector event that starts each one
// (the pad has none: the detector confirms it by watching the rocket sit
// still).
const SEGMENTS = Object.freeze([
  { name: 'Pad', event: null, inferred: false },
  { name: 'Ascent', event: 'liftoff', inferred: false },
  { name: 'Apogee', event: 'apogee', inferred: false },
  { name: 'Drogue', event: 'drogue', inferred: true },
  { name: 'Main', event: 'main', inferred: true },
  { name: 'Landed', event: 'landed', inferred: false },
]);

// The detector's phase to the segment that is current. "descent" means
// apogee was detected and no drogue yet. "waiting" has no current segment.
const CURRENT_INDEX = Object.freeze({ pad: 0, ascent: 1, descent: 2, drogue: 3, main: 4, landed: 5 });

// Words for screen readers, after the segment's name. (A phase that was
// never found reads "not detected" or "not inferred", like its label.)
const STATE_TEXT = Object.freeze({
  passed: 'passed',
  current: 'current phase',
  future: 'not yet',
});

export function createPhaseStrip(root, ctx) {
  const { store, config } = ctx;

  const items = SEGMENTS.map((seg) => {
    const when = h('span', { class: 'fc-phase-when', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only' });
    const li = h('li', { class: `fc-phase${seg.inferred ? ' fc-phase--inferred' : ''}` },
      h('span', { class: 'fc-phase-bar', 'aria-hidden': 'true' }),
      h('span', { class: 'fc-phase-text' },
        h('span', { class: 'fc-phase-name' }, seg.name),
        when),
      sr);
    return { seg, li, when, sr };
  });
  const list = h('ol', { class: 'fc-phase-list', 'aria-label': 'Flight phases' }, items.map((item) => item.li));
  setChildren(root, list);

  let lastKey = '';
  let lastCurrent = null;

  function render() {
    const rocket = store.getFocused();
    const d = rocket?.derived ?? null;
    const current = d ? CURRENT_INDEX[d.phase] ?? -1 : -1;

    const states = items.map((item, i) => {
      const { seg } = item;
      const event = seg.event ? d?.events?.[seg.event] ?? null : null;
      let state;
      if (i === current) state = 'current';
      else if (i > current) state = 'future';
      else {
        // Before the current phase: passed only if the detector really
        // found it.
        const found = seg.event === null ? Boolean(d?.padConfirmed) : Boolean(event);
        state = found ? 'passed' : 'missed';
      }
      // When the phase began, as flight time. Only for phases that started
      // with an event the detector has already confirmed.
      let when = '';
      if (state === 'missed') when = seg.inferred ? 'Not inferred' : 'Not detected';
      else if (event && Number.isFinite(event.t) && Number.isFinite(d.liftoffT)) {
        when = formatFlightClock(Math.max(0, event.t - d.liftoffT));
      }
      return { state, when };
    });

    const key = `${rocket?.id ?? ''}|${states.map((s) => `${s.state}:${s.when}`).join(',')}`;
    if (key === lastKey) return;
    lastKey = key;

    items.forEach((item, i) => {
      const { state, when } = states[i];
      item.li.dataset.state = state;
      if (state === 'current') item.li.setAttribute('aria-current', 'step');
      else item.li.removeAttribute('aria-current');
      setText(item.when, when);
      // Like "Drogue, inferred, passed, began T+0:30", "Apogee, current
      // phase, began T+0:24" or "Main, not inferred".
      let parts;
      if (state === 'missed') parts = [when.toLowerCase()];
      else {
        parts = [item.seg.inferred ? 'inferred' : null, STATE_TEXT[state]];
        if (when) parts.push(`began ${when}`);
      }
      setText(item.sr, `, ${parts.filter(Boolean).join(', ')}`);
    });

    if (current !== lastCurrent) {
      lastCurrent = current;
      if (current >= 0) keepInView(items[current].li, true);
    }
  }

  // On narrow screens the strip scrolls sideways: bring the current phase
  // into view, without moving the page up or down.
  function keepInView(li, smooth) {
    if (list.scrollWidth <= list.clientWidth + 1) return;
    const target = li.offsetLeft - (list.clientWidth - li.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'instant' });
  }

  // When the strip scrolls: make it reachable from the keyboard, and fade
  // the edge that has more phases past it, so it's clear there are more.
  function updateEdges() {
    const max = list.scrollWidth - list.clientWidth;
    const scrolls = max > 1;
    if (scrolls) list.setAttribute('tabindex', '0');
    else list.removeAttribute('tabindex');
    list.classList.toggle('fc-phase-list--more-left', scrolls && list.scrollLeft > 1);
    list.classList.toggle('fc-phase-list--more-right', scrolls && list.scrollLeft < max - 1);
  }
  list.addEventListener('scroll', updateEdges, { passive: true });
  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (lastCurrent !== null && lastCurrent >= 0) keepInView(items[lastCurrent].li, false);
    updateEdges();
  }) : null;
  resizer?.observe(list);

  const scheduler = createScheduler(render, { maxFps: config.HEADER_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'reset' || change.type === 'clear') scheduler.flush();
    else scheduler.schedule();
  });
  render();
  updateEdges();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      resizer?.disconnect();
      list.removeEventListener('scroll', updateEdges);
    },
  };
}
