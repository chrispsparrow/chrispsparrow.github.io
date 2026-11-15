// event-log.js
// The mission timeline, as a compact strip at the top of panel 2.
//
// Closed, it is one line: the newest event with its flight time and its
// mark. Open, the strip's list shows every event in time order and
// scrolls inside itself. The strip's button opens and closes it.
//
// Each event's mark shows how it was found, drawn the same way as the
// markers on the altitude timeline: a filled dot (reported by the board),
// a ring (detected from altitude) or a dashed ring (inferred from the
// descent rate, or a time that was estimated). The message says the same
// in words. A lost GPS fix is a warning, so its mark is amber. The newest
// entry is lit, and while the playhead is on it (within EVENT_NOW_S of
// when it was confirmed) it also shows a small NOW tag.
//
// Every rocket's events are listed. With more than one rocket, each entry
// also names its rocket in its color.
//
// Screen readers hear only events that arrive during normal playback, read
// from a hidden log of their own (open or closed), one line per new event.
// A seek, a new focused rocket or a new flight rebuilds the list quietly,
// so old events are never read out again.
//
//   createEventLog(root, ctx) -> { destroy() }
//     root   the element to fill
//     ctx    store and config, from main.js, and optionally:
//            waitingText   what the open list says before the first
//                          event (a replay's words by default)
//
// Used by: js/views/data-panel.js (a replay's panel 2) and
// js/live/bench-panel.js (the live panel 2). Reads the store, never other
// views.

import { h, setText, setChildren, createScheduler, eventMarkerKind, markerClass, rocketDot, prefersReducedMotion } from './dom.js?v=2';
import { formatFlightClock } from '../geo.js?v=3';

// How many announcements the hidden log keeps. Older ones were already read.
const ANNOUNCE_KEEP = 4;
// The open list before the first event, unless ctx.waitingText says otherwise.
const WAITING_TEXT = 'No events yet. They show up here as the flight plays.';

let nextId = 0;

export function createEventLog(root, ctx) {
  const { store, config } = ctx;
  const waitingText = ctx.waitingText ?? WAITING_TEXT;
  const id = `fc-log-${++nextId}`;

  // The closed line: the newest event. It is the button's own text, so a
  // screen reader hears it when it reaches the button.
  const latestTime = h('span', { class: 'fc-strip-time' });
  const latestMark = h('span', { class: 'fc-strip-mark', 'aria-hidden': 'true' });
  const latestMsg = h('span', { class: 'fc-strip-msg' });
  const count = h('span', { class: 'fc-strip-count' });
  const toggle = h('button', {
    type: 'button', class: 'fc-strip-toggle', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
    onclick: () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'),
  },
  h('span', { class: 'fc-strip-caret', 'aria-hidden': 'true' }),
  h('span', { class: 'fc-strip-name' }, 'Mission timeline'),
  h('span', { class: 'fc-strip-latest' }, latestTime, latestMark, latestMsg),
  count);

  // The list. Plain, not a live region: the hidden log below speaks.
  const list = h('ol', { class: 'fc-log-list', id: `${id}-list`, tabindex: '0', 'aria-label': 'Mission timeline events', hidden: true });
  const announcer = h('div', { class: 'sr-only', role: 'log', 'aria-live': 'polite', 'aria-label': 'New mission events' });

  const strip = h('section', { class: 'fc-strip fc-log', 'aria-label': 'Mission timeline' }, toggle, list, announcer);
  setChildren(root, strip);

  let rendered = [];       // the events in the list, in order
  let lastKey = null;      // what the list was drawn for
  let animateNew = false;  // new events arrived during normal playback
  let quietNext = true;    // the next change must not be announced

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    strip.classList.toggle('is-open', open);
    if (open) list.scrollTop = list.scrollHeight;
    markEdges();
  }

  function sortedEvents() {
    return store.getEvents()
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map(({ e }) => e);
  }

  function render() {
    const animate = animateNew && !prefersReducedMotion();
    animateNew = false;
    const quiet = quietNext;
    quietNext = false;

    const events = sortedEvents();
    const showRocket = store.getRockets().length > 1;
    // Times depend on each rocket's liftoff, so a new liftoff redraws the list.
    const liftoffs = store.getRockets().map((r) => r.derived?.liftoffT ?? '').join(',');
    const key = `${showRocket}|${liftoffs}`;
    const sameList = key === lastKey;
    if (sameList && events.length === rendered.length) { markAtPlayhead(); return; }

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < config.LOG_AUTOSCROLL_PX;
    // Events that weren't in the list before. During normal playback they
    // are read out, even when one lands earlier in the list than the last
    // (a liftoff placed back at the moment the GPS fix dropped, say).
    const before = new Set(rendered);
    const fresh = events.filter((e) => !before.has(e));
    if (!quiet && fresh.length) announce(fresh);
    // Only added at the end, with the same times: append just those.
    const added = sameList && events.length > rendered.length && rendered.every((e, i) => events[i] === e)
      ? events.slice(rendered.length) : null;
    lastKey = key;

    if (added) {
      list.append(...added.map((e) => item(e, showRocket, animate)));
    } else if (!events.length) {
      setChildren(list, h('li', { class: 'fc-log-empty' }, waitingText));
    } else {
      setChildren(list, events.map((e) => item(e, showRocket, false)));
    }
    rendered = events;
    renderLatest();
    markNewest();
    markAtPlayhead();
    if (nearBottom || !added) list.scrollTop = list.scrollHeight;
    markEdges();
  }

  // The closed line and the count.
  function renderLatest() {
    const newest = rendered[rendered.length - 1];
    if (!newest) {
      setText(latestTime, '');
      latestMark.replaceChildren();
      setText(latestMsg, 'No events yet');
      setText(count, '');
      return;
    }
    const { when, kind, warn } = describeEvent(newest);
    setText(latestTime, when);
    latestMark.replaceChildren(h('span', { class: markerClass(kind), style: warn ? { '--basis-color': 'var(--fc-warn)' } : null }));
    setText(latestMsg, newest.message);
    setText(count, `${rendered.length} ${rendered.length === 1 ? 'event' : 'events'}`);
  }

  // A few words per new event for the hidden log. Each one is a new
  // element, so it is read once and never again.
  function announce(events) {
    for (const e of events) {
      const { when } = describeEvent(e);
      announcer.append(h('p', {}, `${when === 'PAD' ? 'On the pad' : when}, ${e.message}`));
    }
    while (announcer.childElementCount > ANNOUNCE_KEEP) announcer.firstElementChild.remove();
  }

  // Fades the top or bottom edge of the open list while more entries are
  // out of view there, so a cut-off entry reads as "scroll for more".
  function markEdges() {
    list.classList.toggle('fc-log-list--above', list.scrollTop > 2);
    list.classList.toggle('fc-log-list--below', list.scrollHeight - list.scrollTop - list.clientHeight > 2);
  }
  list.addEventListener('scroll', markEdges, { passive: true });

  // Only the last entry (the one closest to the playhead) is lit. A class
  // change is never announced.
  function markNewest() {
    for (const el of list.querySelectorAll('.is-now')) el.classList.remove('is-now', 'is-at-playhead');
    if (rendered.length) list.lastElementChild?.classList.add('is-now');
  }

  // The NOW tag on the newest entry, while the playhead is on it. Checked
  // on every clock tick, since time moves on between events.
  function markAtPlayhead() {
    const newest = rendered[rendered.length - 1];
    const el = list.lastElementChild;
    const age = newest ? store.ageOf(newest.confirmedT ?? newest.t) : null;
    const on = age !== null && age <= config.EVENT_NOW_S;
    if (el?.classList.contains('is-now') && el.classList.contains('is-at-playhead') !== on) el.classList.toggle('is-at-playhead', on);
    strip.classList.toggle('is-fresh', on);
  }

  // The time, the mark's kind and whether it is a warning, for one event.
  function describeEvent(e) {
    const rocket = store.getRocket(e.rocketId);
    const liftoffT = rocket?.derived?.liftoffT;
    return {
      rocket,
      when: Number.isFinite(liftoffT) ? formatFlightClock(e.t - liftoffT) : 'PAD',
      kind: eventMarkerKind(e, rocket?.derived),
      warn: e.type === 'gps_fix_lost',
    };
  }

  function item(e, showRocket, animate) {
    const { rocket, when, kind, warn } = describeEvent(e);
    const color = rocket?.profile.color ?? 'var(--fc-text)';
    const li = h('li', { class: animate ? 'fc-log-item fc-log-item--new' : 'fc-log-item' },
      h('span', { class: 'fc-log-time' }, when),
      h('span', { class: 'fc-log-mark', 'aria-hidden': 'true' },
        h('span', { class: markerClass(kind), style: warn ? { '--basis-color': 'var(--fc-warn)' } : null })),
      h('div', { class: 'fc-log-body' },
        showRocket ? h('p', { class: 'fc-log-rocket', style: { '--dot': color } },
          rocketDot(color), rocket?.profile.name ?? `Rocket ${e.rocketId}`) : null,
        h('p', { class: 'fc-log-msg' }, e.message)),
      // Visual only: the list order already says which entry is newest.
      h('span', { class: 'fc-log-now', 'aria-hidden': 'true' }, 'NOW'));
    // The slide-in plays once. Dropping the class keeps it from replaying.
    if (animate) li.addEventListener('animationend', () => li.classList.remove('fc-log-item--new'), { once: true });
    return li;
  }

  const scheduler = createScheduler(render, { maxFps: config.LOG_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'time') { markAtPlayhead(); return; }
    if (change.type === 'reset' || change.type === 'clear' || change.type === 'focus' || change.type === 'source') {
      // A seek resets the store and replays up to the new time in the same
      // moment, so the list is rebuilt once on the next frame, quietly,
      // and never shown empty in between.
      lastKey = null;
      rendered = [];
      animateNew = false;
      quietNext = true;
      scheduler.schedule();
      return;
    }
    // Replays after a seek are quiet: their events just appear, with no
    // slide-in, and they aren't read out.
    if (change.quiet) quietNext = true;
    if (change.newEvents?.length && !change.quiet) animateNew = true;
    scheduler.schedule();
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      list.removeEventListener('scroll', markEdges);
    },
  };
}
