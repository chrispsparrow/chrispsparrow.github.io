// debug-panel.js
// "Detection check (simulated ground truth)": a collapsed section that only
// appears for flights with simulator ground truth (a "phase" value). It
// shows the true phase at the current time next to the detected phase, a
// list comparing each true phase start with the matching detected event and
// the difference in seconds, and how many bad rows were skipped.
// This and tools/check_detection.mjs are the only places truth is used. The
// detector never sees it.
// Used by: main.js. Reads the store and ctx.flight.truth.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { compareWithTruth, truthPhaseAt } from '../truth-check.js';
import { EVENT_LABELS } from '../detector.js';
import { formatNumber } from '../geo.js';

export function createDebugPanel(root, ctx) {
  const { store, flight, config } = ctx;
  if (!flight.truth.length) {
    // No ground truth, so nothing to check. The panel stays hidden.
    setChildren(root);
    return { destroy() {} };
  }

  const nowLine = h('p', { class: 'fc-debug-now' });
  const list = h('ul', { class: 'fc-debug-list' });
  const badLine = h('p', { class: 'fc-debug-bad' });
  const details = h('details', { class: 'fc-panel fc-debug' },
    h('summary', {},
      // The arrow turns to point down while the section is open.
      iconNode(uiIcon('chevron', 18)),
      h('span', {}, 'Detection check (simulated ground truth)')),
    h('div', { class: 'fc-debug-body' },
      h('p', { class: 'fc-debug-intro' }, 'The simulator knows the true phase of every reading. The console never uses it for detection. It is only shown here, to check how close detection gets. Times are on the board\'s clock, in seconds.'),
      nowLine,
      list,
      badLine));
  setChildren(root, details);

  let listKey = null;

  function render() {
    if (!details.open) return; // nothing to update while collapsed
    const rocket = store.getFocused();
    if (!rocket) return;
    const truth = flight.truth.filter((r) => r.rocketId === rocket.id);
    const now = store.getNow();
    const truePhase = Number.isFinite(now) ? truthPhaseAt(truth, now) : null;
    setText(nowLine, truth.length
      ? `True phase now: ${truePhase ?? 'none yet'}. Detected phase now: ${rocket.derived?.phaseLabel ?? 'no data yet'}.`
      : `There is no ground truth for ${rocket.profile.name}.`);

    const rows = compareWithTruth(rocket.events, truth);
    // Rebuild the list only when a row changed, so text stays selectable.
    const key = JSON.stringify(rows);
    if (key !== listKey) {
      listKey = key;
      setChildren(list, rows.map(rowItem));
    }

    setText(badLine, `Bad rows skipped while reading the file: ${flight.badRows}.`);
  }

  // One comparison row. The event name leads, so the list is easy to scan.
  function rowItem(row) {
    const label = h('span', { class: 'fc-debug-event' }, `${EVENT_LABELS[row.type]}:`);
    if (row.truthT === null) return h('li', {}, label, ` the simulator has no "${row.truthPhase}" phase to compare with.`);
    const trueText = `true "${row.truthPhase}" starts at ${sec(row.truthT)}`;
    if (row.count === 0) return h('li', {}, label, ` ${trueText}, not detected yet.`);
    const diff = row.diffS;
    const diffText = Math.abs(diff) < 0.05 ? 'no difference' : `${formatNumber(Math.abs(diff), 1)} s ${diff > 0 ? 'late' : 'early'}`;
    return h('li', {},
      label,
      ` ${trueText}, detected at ${sec(row.detectedT)} (confirmed at ${sec(row.confirmedT)}), `,
      h('strong', {}, diffText),
      row.count > 1 ? `. Fired ${row.count} times.` : '.');
  }

  details.addEventListener('toggle', render);
  const scheduler = createScheduler(render, { maxFps: config.DEBUG_MAX_FPS });
  const unsubscribe = store.subscribe(() => scheduler.schedule());
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
    },
  };
}

function sec(t) {
  return Number.isFinite(t) ? `${formatNumber(t, 1)} s` : '--';
}
