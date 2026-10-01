// mission-header.js
// The top of the console: the focused rocket's name and color, a big flight
// clock (T+m:ss, or "On pad"), its current phase, where the data came from
// and whether the flight is simulated or real, plus the "All flights" and
// "Copy link to this flight" buttons.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatFlightClock } from '../geo.js';

export function createMissionHeader(root, ctx) {
  const { store, flight, config } = ctx;
  const entry = flight.entry;

  const dot = h('span', { class: 'fc-dot', 'aria-hidden': 'true' });
  const name = h('span', {});
  const phase = h('p', { class: 'fc-mission-phase' });
  const flags = h('div', { class: 'fc-mission-flags' });
  const clock = h('div', { class: 'fc-clock' });
  const clockLabel = h('div', { class: 'fc-clock-label' });
  const copyStatus = h('span', { class: 'fc-copy-status', role: 'status' });
  const copyFallback = h('div', { hidden: true });

  const files = flight.files.map((f) => f.file).join(', ');
  const readings = flight.files.reduce((sum, f) => sum + f.sampleCount, 0);
  const badText = flight.badRows === 1 ? '1 bad line skipped' : `${flight.badRows} bad lines skipped`;

  const copyButton = h('button', { type: 'button', class: 'fc-btn', onclick: copyLink }, 'Copy link to this flight');
  const allButton = h('button', { type: 'button', class: 'fc-btn', onclick: () => ctx.navigate({ launcher: true }) }, 'All flights');

  setChildren(root, h('header', { class: 'fc-mission' },
    h('div', { class: 'fc-mission-main' },
      h('h1', { class: 'fc-mission-rocket' }, dot, name),
      phase,
      flags,
      h('div', { class: 'fc-mission-lines' },
        // "(simulated)" or "(real)" unless the title already says it.
        h('p', { class: 'fc-source' }, entry.title.toLowerCase().includes(entry.kind)
          ? `Source: ${entry.title}`
          : `Source: ${entry.title} (${entry.kind})`),
        h('p', { class: 'fc-source' }, `Data file${flight.files.length === 1 ? '' : 's'}: ${files}, ${readings} readings, ${badText}`),
        // Anything the parser or library had to adjust, said plainly.
        (flight.notes ?? []).map((note) => h('p', { class: 'fc-source' }, note)))),
    h('div', { class: 'fc-mission-side' },
      h('div', {}, clock, clockLabel),
      h('div', { class: 'fc-mission-actions' }, allButton, copyButton, copyStatus),
      copyFallback)));

  let copyTimer = null;
  async function copyLink() {
    clearTimeout(copyTimer);
    copyFallback.hidden = true;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ctx.link);
        copied = true;
      }
    } catch { copied = false; }
    if (!copied) copied = copyWithSelection(ctx.link);
    if (copied) {
      setText(copyStatus, 'Link copied');
      copyTimer = setTimeout(() => setText(copyStatus, ''), config.LINK_COPIED_MS);
    } else {
      // The browser blocked copying, so show the link to copy by hand.
      setText(copyStatus, '');
      setChildren(copyFallback,
        h('label', { class: 'fc-source', for: 'fc-copy-field' }, 'Copying was blocked. Here is the link:'),
        h('input', { id: 'fc-copy-field', class: 'fc-copy-fallback', type: 'text', readOnly: true, value: ctx.link, onfocus: (e) => e.target.select() }));
      copyFallback.hidden = false;
    }
  }

  function render() {
    const rocket = store.getFocused();
    const d = rocket?.derived;
    dot.style.setProperty('--dot', rocket?.profile.color ?? '#fff');
    setText(name, rocket?.profile.name ?? 'No rocket yet');
    setText(phase, d ? d.phaseLabel : 'Waiting for data');

    const now = store.getNow();
    if (!d || d.phase === 'waiting') {
      setText(clock, '--');
      setText(clockLabel, 'Flight time starts at liftoff');
    } else if (d.liftoffT === null) {
      setText(clock, 'On pad');
      setText(clockLabel, 'Flight time starts at liftoff');
    } else {
      setText(clock, formatFlightClock(Math.max(0, (now ?? d.lastT) - d.liftoffT)));
      setText(clockLabel, d.liftoffEstimated ? 'Flight time, liftoff estimated' : 'Flight time');
    }

    const wanted = [[entry.kind === 'real' ? 'Real flight' : 'Simulated flight', entry.kind === 'real' ? 'fc-flag--real' : 'fc-flag--sim']];
    if (d?.startedInFlight) wanted.push(['Data starts in flight', 'fc-flag--warn']);
    else if (d?.liftoffEstimated) wanted.push(['Liftoff time estimated', '']);
    if (d?.groundEstimated) wanted.push(['Ground level estimated', 'fc-flag--warn']);
    const key = wanted.map((w) => w[0]).join('|');
    if (flags.dataset.key !== key) {
      flags.dataset.key = key;
      setChildren(flags, wanted.map(([text, cls]) => h('span', { class: `fc-flag ${cls}` }, text)));
    }
  }

  const scheduler = createScheduler(render, { maxFps: config.HEADER_MAX_FPS });
  const unsubscribe = store.subscribe(() => scheduler.schedule());
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      clearTimeout(copyTimer);
    },
  };
}

// Older way to copy text, for browsers without the clipboard API.
function copyWithSelection(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
