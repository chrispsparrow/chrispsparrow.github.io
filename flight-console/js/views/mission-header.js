// mission-header.js
// The top left corner of a replay's 3D view: the focused rocket's name,
// small labels that say whether the flight is simulated or real plus the
// honesty flags ("Data starts in flight", "Ground level estimated"), and
// the big off-white flight clock (T+m:ss, or "On pad") that stops at the
// landing, with a caption that says when the liftoff time was only
// estimated.
// The way back to live is the close button on the replay's name in the
// console's bar, and the link to share is in "About this flight"
// (flight-info.js), in the second panel.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatFlightClock, MISSING } from '../geo.js';

export function createMissionHeader(root, ctx) {
  const { store, flight, config } = ctx;
  const entry = flight.entry;
  const isReal = entry.kind === 'real';

  const name = h('span', { class: 'fc-mission-name' });
  const flags = h('div', { class: 'fc-mission-flags' });
  const clock = h('p', { class: 'fc-mission-clock' });
  const caption = h('p', { class: 'fc-mission-caption' });

  setChildren(root, h('header', { class: 'fc-mission' },
    h('div', { class: 'fc-mission-time' }, clock, caption),
    h('div', { class: 'fc-mission-id' },
      h('h2', { class: 'fc-mission-title' }, name),
      flags)));

  function render() {
    const rocket = store.getFocused();
    const d = rocket?.derived;
    setText(name, rocket?.profile.name ?? 'No rocket yet');

    // The clock: "--" until there is data, "On pad" before liftoff, then
    // the time since liftoff on the store's clock. Once the landing is
    // detected it stops at the landing time, so it agrees with the phase
    // strip and the launcher's flight time.
    let state;
    const landed = d?.events?.landed;
    if (!d || d.phase === 'waiting') {
      state = 'idle';
      setText(clock, MISSING);
      setText(caption, 'Starts at liftoff');
    } else if (d.liftoffT === null) {
      state = 'pad';
      setText(clock, 'On pad');
      setText(caption, 'Starts at liftoff');
    } else if (landed) {
      state = 'landed';
      setText(clock, formatFlightClock(Math.max(0, landed.t - d.liftoffT)));
      setText(caption, d.liftoffEstimated ? 'Total flight time, liftoff estimated' : 'Total flight time');
    } else {
      state = 'running';
      const now = store.getNow() ?? d.lastT;
      setText(clock, formatFlightClock(Math.max(0, now - d.liftoffT)));
      setText(caption, d.liftoffEstimated ? 'Flight time, liftoff estimated' : 'Flight time');
    }
    if (clock.dataset.state !== state) clock.dataset.state = state;

    // Labels: simulated or real, then anything the console had to estimate.
    const wanted = [[isReal ? 'Real flight' : 'Simulated flight', isReal ? 'fc-pill--real' : 'fc-pill--sim']];
    if (d?.startedInFlight) wanted.push(['Data starts in flight', 'fc-pill--warn']);
    if (d?.groundEstimated) wanted.push(['Ground level estimated', 'fc-pill--warn']);
    const key = wanted.map((w) => w[0]).join('|');
    if (flags.dataset.key !== key) {
      flags.dataset.key = key;
      setChildren(flags, wanted.map(([text, cls]) => h('span', { class: `fc-pill ${cls}` }, text)));
    }
  }

  const scheduler = createScheduler(render, { maxFps: config.HEADER_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    // A new focus or a fresh start shows at once. Playback can wait a frame.
    if (change.type === 'focus' || change.type === 'reset' || change.type === 'clear') scheduler.flush();
    else scheduler.schedule();
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
    },
  };
}
