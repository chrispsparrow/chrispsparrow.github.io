// event-log.js
// The mission timeline: every event in time order along a vertical line,
// one dot per event. The dot shows how the event was found, drawn the same
// way as the markers on the altitude timeline: a filled dot (reported by
// the board), a gold ring (detected from altitude) or a dashed ring
// (inferred from the descent rate, or a time that was estimated). The
// message next to it says the same thing in words.
//
// The newest entry is gold. The store only holds events up to the
// playhead, so that entry is the latest thing that happened. While the
// playhead is on it (within EVENT_NOW_S of when it was confirmed) it also
// shows a small "Now" tag. A toggle switches between all rockets and only the focused one. With
// several rockets, "All rockets" also names each entry's rocket in its
// color. The list scrolls to the newest entry unless you have scrolled up
// to read.
//
// Screen readers hear only events that arrive during normal playback. A
// seek, a filter change or a new focused rocket rebuilds the list with the
// live region switched off, so old events aren't read out again.
// Used by: main.js. Reads the store, never other views.

import { h, setChildren, createScheduler, eventMarkerKind, markerClass, rocketDot, prefersReducedMotion } from './dom.js';
import { formatFlightClock } from '../geo.js';

export function createEventLog(root, ctx) {
  const { store, config } = ctx;
  let mode = 'all'; // 'all' or 'focused'

  const allButton = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', onclick: () => setMode('all') }, 'All rockets');
  const oneButton = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', onclick: () => setMode('focused') }, 'This rocket');
  // The <ol> stays a plain list (scrollable, so it can take keyboard focus).
  // The live region that announces new entries wraps it.
  const list = h('ol', { class: 'fc-log-list', tabindex: '0', 'aria-labelledby': 'fc-log-title' });
  const region = h('div', { class: 'fc-log-region', role: 'log', 'aria-live': 'polite', 'aria-labelledby': 'fc-log-title' }, list);

  setChildren(root, h('section', { class: 'fc-panel fc-log-panel', 'aria-labelledby': 'fc-log-title' },
    h('div', { class: 'fc-panel-head' },
      h('h2', { class: 'fc-panel-title', id: 'fc-log-title' }, 'Mission timeline'),
      h('div', { class: 'fc-seg', role: 'group', 'aria-label': 'Which events to show' }, allButton, oneButton)),
    region));

  let lastKey = null;
  let rendered = [];     // the events currently in the list, in order
  let animateNew = false; // true when new events arrived during normal playback
  let quietNext = true;   // the next render must not be announced
  let liveFrame = null;

  function setMode(next) {
    mode = next;
    quietNext = true;
    render(true);
  }

  // Runs a DOM change with the live region switched off, then switches it
  // back on once the change has gone through.
  function silently(change) {
    if (liveFrame !== null) cancelAnimationFrame(liveFrame);
    region.setAttribute('aria-live', 'off');
    change();
    liveFrame = requestAnimationFrame(() => {
      liveFrame = null;
      region.setAttribute('aria-live', 'polite');
    });
  }

  function render(forceBottom = false) {
    allButton.setAttribute('aria-pressed', String(mode === 'all'));
    oneButton.setAttribute('aria-pressed', String(mode === 'focused'));
    // New entries slide in only during normal playback, and never for
    // viewers who asked for less motion.
    const animate = animateNew && !prefersReducedMotion();
    animateNew = false;
    const quiet = quietNext;
    quietNext = false;

    const focusedId = store.getFocusedId();
    const events = store.getEvents()
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => mode === 'all' || e.rocketId === focusedId)
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map(({ e }) => e);
    // Rocket names only help when there is more than one rocket to tell apart.
    const showRocket = mode === 'all' && store.getRockets().length > 1;

    // Times depend on each rocket's liftoff, so a new liftoff redraws the list.
    const liftoffs = store.getRockets().map((r) => r.derived?.liftoffT ?? '').join(',');
    const key = `${mode}|${focusedId}|${showRocket}|${liftoffs}`;
    const sameList = key === lastKey;
    if (sameList && events.length === rendered.length && !forceBottom) return;

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < config.LOG_AUTOSCROLL_PX;
    const onlyAdded = sameList && rendered.length > 0 && events.length > rendered.length &&
      rendered.every((e, i) => events[i] === e);
    lastKey = key;

    if (!events.length) {
      rendered = [];
      silently(() => setChildren(list, h('li', { class: 'fc-log-empty' }, 'No events yet. They show up here as the flight plays.')));
      markEdges();
      return;
    }
    if (onlyAdded && !quiet) {
      // Append just the new entries, so screen readers announce only those.
      list.append(...events.slice(rendered.length).map((e) => item(e, showRocket, animate)));
    } else {
      silently(() => setChildren(list, events.map((e) => item(e, showRocket, false))));
    }
    rendered = events;
    markNewest();
    markAtPlayhead();
    if (nearBottom || forceBottom) list.scrollTop = list.scrollHeight;
    markEdges();
  }

  // Fades the top or bottom edge of the list while more entries are out of
  // view there, so a cut-off entry reads as "scroll for more".
  function markEdges() {
    const above = list.scrollTop > 2;
    const below = list.scrollHeight - list.scrollTop - list.clientHeight > 2;
    list.classList.toggle('fc-log-list--above', above);
    list.classList.toggle('fc-log-list--below', below);
  }
  list.addEventListener('scroll', markEdges, { passive: true });

  // Only the last entry (the one closest to the playhead) gets the gold
  // look. Changing a class is never announced by the live region.
  function markNewest() {
    for (const el of list.querySelectorAll('.is-now')) el.classList.remove('is-now', 'is-at-playhead');
    list.lastElementChild?.classList.add('is-now');
  }

  // The "Now" tag on the newest entry, while the playhead is on it. Checked
  // on every clock tick, since time moves on between events.
  function markAtPlayhead() {
    const newest = rendered[rendered.length - 1];
    const el = list.lastElementChild;
    if (!newest || !el?.classList.contains('is-now')) return;
    const age = store.ageOf(newest.confirmedT ?? newest.t);
    const on = age !== null && age <= config.EVENT_NOW_S;
    if (el.classList.contains('is-at-playhead') !== on) el.classList.toggle('is-at-playhead', on);
  }

  function item(e, showRocket, animate) {
    const rocket = store.getRocket(e.rocketId);
    const color = rocket?.profile.color ?? '#fff';
    const liftoffT = rocket?.derived?.liftoffT;
    const when = Number.isFinite(liftoffT) ? formatFlightClock(e.t - liftoffT) : 'On pad';
    const kind = eventMarkerKind(e, rocket?.derived);
    // Losing the GPS fix is a warning, so its dot is coral.
    const dotStyle = e.type === 'gps_fix_lost' ? { '--basis-color': 'var(--fc-coral)' } : null;

    const li = h('li', { class: animate ? 'fc-log-item fc-log-item--new' : 'fc-log-item' },
      h('span', { class: 'fc-log-time' }, when),
      h('span', { class: 'fc-log-mark', 'aria-hidden': 'true' },
        h('span', { class: markerClass(kind), style: dotStyle })),
      h('div', { class: 'fc-log-body' },
        showRocket ? h('p', { class: 'fc-log-rocket', style: { '--dot': color } },
          rocketDot(color), rocket?.profile.name ?? `Rocket ${e.rocketId}`) : null,
        h('p', { class: 'fc-log-msg' }, e.message)),
      // Visual only: the list order already says which entry is newest.
      h('span', { class: 'fc-log-now', 'aria-hidden': 'true' }, 'Now'));
    // The slide-in plays once. Dropping the class keeps it from replaying.
    if (animate) li.addEventListener('animationend', () => li.classList.remove('fc-log-item--new'), { once: true });
    return li;
  }

  const scheduler = createScheduler(() => render(false), { maxFps: config.LOG_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'time') { markAtPlayhead(); return; }
    if (change.type === 'reset' || change.type === 'clear' || change.type === 'focus') {
      // A seek resets the store and replays up to the new time in the same
      // moment, so the list is rebuilt once on the next frame (quietly),
      // never shown empty in between.
      lastKey = null;
      rendered = [];
      animateNew = false;
      quietNext = true;
      scheduler.schedule();
      return;
    }
    // Replays after a seek are quiet: their events just appear, no slide-in,
    // and they aren't read out.
    if (change.quiet) quietNext = true;
    if (change.newEvents?.length && !change.quiet) animateNew = true;
    markAtPlayhead();
    scheduler.schedule();
  });
  render(true);

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      if (liveFrame !== null) cancelAnimationFrame(liveFrame);
      list.removeEventListener('scroll', markEdges);
    },
  };
}
