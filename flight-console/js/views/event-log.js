// event-log.js
// The event log: every event in time order, each with the rocket's name in
// its color, the flight time, and the message, which always says whether
// the event was reported by the board, detected from altitude, or inferred
// from the descent rate. A toggle switches between all rockets and only the
// focused one. The list scrolls to the newest entry unless you have
// scrolled up to read.
// Used by: main.js. Reads the store, never other views.

import { h, setChildren, createScheduler } from './dom.js';
import { formatFlightClock } from '../geo.js';

export function createEventLog(root, ctx) {
  const { store, config } = ctx;
  let mode = 'all'; // 'all' or 'focused'

  const allButton = h('button', { type: 'button', class: 'fc-btn', onclick: () => setMode('all') }, 'All rockets');
  const oneButton = h('button', { type: 'button', class: 'fc-btn', onclick: () => setMode('focused') }, 'This rocket');
  // The <ol> stays a plain list (scrollable, so it can take keyboard focus).
  // The live region that announces new entries wraps it.
  const list = h('ol', { class: 'fc-log-list', tabindex: '0', 'aria-labelledby': 'fc-log-title' });
  const region = h('div', { class: 'fc-log-region', role: 'log', 'aria-live': 'polite', 'aria-labelledby': 'fc-log-title' }, list);

  setChildren(root, h('section', { class: 'fc-panel fc-log-panel', 'aria-labelledby': 'fc-log-title' },
    h('div', { class: 'fc-panel-head' },
      h('h2', { class: 'fc-panel-title', id: 'fc-log-title' }, 'Event log'),
      h('div', { class: 'fc-seg', role: 'group', 'aria-label': 'Which events to show' }, allButton, oneButton)),
    region));

  let lastKey = null;
  let rendered = []; // the events currently in the list, in order

  function setMode(next) {
    mode = next;
    render(true);
  }

  function render(forceBottom = false) {
    allButton.setAttribute('aria-pressed', String(mode === 'all'));
    oneButton.setAttribute('aria-pressed', String(mode === 'focused'));

    const focusedId = store.getFocusedId();
    const events = store.getEvents()
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => mode === 'all' || e.rocketId === focusedId)
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map(({ e }) => e);

    // Times depend on each rocket's liftoff, so a new liftoff redraws the list.
    const liftoffs = store.getRockets().map((r) => r.derived?.liftoffT ?? '').join(',');
    const key = `${mode}|${focusedId}|${liftoffs}`;
    const sameList = key === lastKey;
    if (sameList && events.length === rendered.length && !forceBottom) return;

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < config.LOG_AUTOSCROLL_PX;
    const onlyAdded = sameList && rendered.length > 0 && events.length > rendered.length &&
      rendered.every((e, i) => events[i] === e);
    lastKey = key;

    if (!events.length) {
      rendered = [];
      setChildren(list, h('li', { class: 'fc-log-empty' }, 'No events yet. They show up here as the flight plays.'));
      return;
    }
    if (onlyAdded) {
      // Append just the new entries, so screen readers announce only those.
      list.append(...events.slice(rendered.length).map(item));
    } else {
      region.setAttribute('aria-busy', 'true');
      setChildren(list, events.map(item));
      region.removeAttribute('aria-busy');
    }
    rendered = events;
    if (nearBottom || forceBottom) list.scrollTop = list.scrollHeight;
  }

  function item(e) {
    const rocket = store.getRocket(e.rocketId);
    const color = rocket?.profile.color ?? '#fff';
    const liftoffT = rocket?.derived?.liftoffT;
    const when = Number.isFinite(liftoffT) ? formatFlightClock(e.t - liftoffT) : 'On pad';
    return h('li', { class: 'fc-log-item', style: { '--dot': color } },
      h('div', { class: 'fc-log-top' },
        h('span', { class: 'fc-log-rocket' }, rocket?.profile.name ?? `Rocket ${e.rocketId}`),
        h('span', { class: 'fc-log-time' }, when)),
      h('p', { class: 'fc-log-msg' }, e.message));
  }

  const scheduler = createScheduler(() => render(false), { maxFps: config.LOG_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'time') return;
    if (change.type === 'reset' || change.type === 'clear' || change.type === 'focus') {
      lastKey = null;
      rendered = [];
      scheduler.flush();
      return;
    }
    scheduler.schedule();
  });
  render(true);

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
    },
  };
}
