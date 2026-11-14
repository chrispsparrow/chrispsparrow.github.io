// data-panel.js
// Panel 2 for a store: the graphs and readings for whatever main.js is
// showing from a store, a saved flight today and a live flight source
// later. It looks the same as the live board's panel 2
// (js/live/bench-panel.js), which reads the board's status blocks instead
// of a store, and it uses the same bc-* classes for its graphs and rows.
//
// Top to bottom:
//   strips     the mission timeline (event-log.js) and, for a saved
//              flight, "About this flight" (flight-info.js). Each is one
//              line until it is opened.
//   graphs     ALT AGL, VS, GS, GPS SATS, HDOP and PKT (packets received
//              and missed), on flight time, drawn up to the playhead
//              (data-series.js works out the points). Pointing at a graph,
//              or tabbing to one and using the arrow keys, picks a moment,
//              and every graph shows it. A graph with nothing to draw says
//              NO DATA.
//   readings   the full list at the playhead (data-readings.js)
// On a wide screen the readings sit in a column on the left and the graphs
// fill the rest. On a phone it is one column that scrolls.
//
//   createDataPanel(root, ctx) -> { destroy() }
//     root   the empty element in panel 2 to fill (#fc-data-replay)
//     ctx    what every view gets from main.js:
//            store      the store to read (or a store switch: a 'source'
//                       change means start over from the new store)
//            player     the replay's player, or null for live data. Read
//                       fresh on each draw, from here or ctx.session.
//            config     js/config.js
//            prescan    Map of rocketId -> { profile, events, state } for
//                       the whole flight (empty for live data). Read fresh
//                       too, from ctx.session first.
//            flight     { entry, files, notes, ... } for a saved flight, or
//                       nothing for live data (then there is no
//                       "About this flight")
//            link       the replay's address, for COPY LINK
//
// It follows the store's changes ('samples', 'reset' after a seek, 'time',
// 'focus', 'clear' and 'source') and redraws at most DRAW_MAX_FPS times a
// second. While panel 1 is on screen it only notes that something changed,
// and draws once panel 2 comes back (the console's data-panel attribute
// says which one is showing), so the 3D view has the computer to itself.
//
// Used by: main.js.

import { h, setText, setChildren, createScheduler, rocketDot } from './dom.js';
import { createEventLog } from './event-log.js?v=2';
import { createFlightInfo } from './flight-info.js?v=3';
import { createReadings } from './data-readings.js';
import { createSeriesBuilder } from './data-series.js';
import { TimeChart, readTheme } from '../bench/charts.js?v=4';
import { formatNumber, formatFlightClock, formatClock } from '../geo.js';

// Settings
const DRAW_MAX_FPS = 6;          // graphs and readings redraw at most this often while a flight plays
const LIVE_MIN_SPAN_S = 60;      // with no player (live data), the graphs show at least this much time

// One entry per graph. key is the series from data-series.js.
//   unit, digits     how a value reads ("1,234 m")
//   minSpan          the smallest value range the graph shows
//   integer          whole-number value labels
//   floorZero        start the value axis at 0 when nothing is below it
//   warn             that line is amber (a warning)
const GRAPHS = [
  { id: 'agl', title: 'ALT AGL', series: [{ key: 'agl', name: 'ALT AGL', unit: 'm', digits: 0 }], minSpan: 10 },
  { id: 'vs', title: 'VS', series: [{ key: 'vs', name: 'VS', unit: 'm/s', digits: 1 }], minSpan: 4, floorZero: false },
  { id: 'gs', title: 'GS', series: [{ key: 'gs', name: 'GS', unit: 'm/s', digits: 1 }], minSpan: 4 },
  { id: 'sats', title: 'GPS SATS', series: [{ key: 'sats', name: 'GPS SATS', unit: '', digits: 0 }], minSpan: 4, integer: true },
  { id: 'hdop', title: 'HDOP', series: [{ key: 'hdop', name: 'HDOP', unit: '', digits: 2 }], minSpan: 1 },
  {
    id: 'pkt', title: 'PKT', minSpan: 4, integer: true,
    series: [
      { key: 'recv', name: 'Received', unit: '', digits: 0 },
      { key: 'missed', name: 'Missed', unit: '', digits: 0, warn: true },
    ],
  },
];

let nextId = 0;

export function createDataPanel(root, ctx) {
  const { config } = ctx;
  const store = ctx.store;
  const id = `fc-dp-${++nextId}`;
  const parts = [];   // the strips' views, for destroy()

  // ------------------------------------------------------------------
  // The frame
  // ------------------------------------------------------------------
  const logMount = h('div', { class: 'fc-dp-strip' });
  const infoMount = ctx.flight?.entry ? h('div', { class: 'fc-dp-strip' }) : null;

  const graphsWhen = h('span', { class: 'bc-box-sub' }, 'Flight time');
  const graphGrid = h('div', { class: 'bc-graph-grid fc-dp-grid' });
  const graphs = h('section', { class: 'fc-dp-graphs', 'aria-labelledby': `${id}-graphs` },
    h('div', { class: 'fc-dp-head' },
      h('h2', { id: `${id}-graphs`, class: 'bc-box-title' }, 'Graphs'),
      graphsWhen),
    graphGrid);

  const readingsWho = h('span', { class: 'fc-dp-who', hidden: true });
  const readingsAt = h('span', { class: 'bc-box-sub' });
  const readingsBody = h('div', { class: 'bc-readings-groups' });
  const side = h('section', { class: 'fc-dp-side', 'aria-labelledby': `${id}-readings` },
    h('div', { class: 'fc-dp-head' },
      h('h2', { id: `${id}-readings`, class: 'bc-box-title' }, 'Readings'),
      readingsWho, readingsAt),
    readingsBody);

  // Screen reader lines for a moment picked on a graph with the keys.
  const announce = h('p', { class: 'sr-only', 'aria-live': 'polite' });

  setChildren(root,
    h('div', { class: 'fc-dp-strips' }, logMount, infoMount),
    h('div', { class: 'fc-dp' }, graphs, side),
    announce);

  for (const [mount, make] of [[logMount, createEventLog], [infoMount, createFlightInfo]]) {
    if (!mount) continue;
    try {
      parts.push(make(mount, ctx));
    } catch (err) {
      console.error('Flight Console: a part of the graphs panel failed to start', err);
    }
  }

  // ------------------------------------------------------------------
  // The graphs
  // ------------------------------------------------------------------
  const theme = readTheme(root);
  let hoverT = null;   // the moment picked on a graph (ms of flight time), or null for the newest
  let span = { t0: 0, t1: LIVE_MIN_SPAN_S * 1000, fromLiftoff: false };

  const charts = GRAPHS.map((def) => {
    const values = {};
    const keys = def.series.length > 1
      ? def.series.map((s) => {
        values[s.key] = h('span', { class: 'bc-graph-value bc-num' });
        return h('span', { class: 'bc-key' },
          h('span', { class: `bc-key-line${s.warn ? ' bc-key-line--err' : ' bc-key-line--sent'}`, 'aria-hidden': 'true' }),
          s.name, ' ', values[s.key]);
      })
      : def.series.map((s) => (values[s.key] = h('span', { class: 'bc-graph-value bc-num' })));
    const when = h('span', { class: 'bc-graph-when', hidden: true });
    const canvas = h('canvas', { class: 'bc-graph-canvas', tabindex: '0', role: 'img', 'aria-label': `${def.title} graph, no data yet.` });
    graphGrid.append(h('section', { class: 'bc-graph', 'data-fc-chart': def.id, 'aria-labelledby': `${id}-g-${def.id}` },
      h('div', { class: 'bc-graph-head' },
        h('h3', { id: `${id}-g-${def.id}`, class: 'bc-graph-title' }, def.title),
        h('p', { class: 'bc-graph-read' }, when, keys)),
      canvas));
    const entry = { def, canvas, values, when };
    entry.chart = new TimeChart(canvas, {
      series: def.series.map((s) => ({ key: s.key, color: s.warn ? theme.err : theme.accent })),
      theme,
      integer: !!def.integer,
      floorZero: def.floorZero !== false,
      minSpan: def.minSpan,
      gapMs: config.LINK_STALE_S * 1000,
      formatTime: axisTime,
      onHover: setHover,
      onKey: (e, chart) => onChartKey(e, chart, def),
    });
    canvas.addEventListener('blur', onBlur);
    return entry;
  });

  // Along the bottom: "0:30", or "-0:20" before liftoff.
  function axisTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 0 ? `-${formatClock(-s)}` : formatClock(s);
  }

  // "T+0:41" for a moment on the graphs, or "0:41" from the first reading
  // when there is no liftoff to count from.
  function momentText(ms) {
    return span.fromLiftoff ? formatFlightClock(ms / 1000) : formatClock(ms / 1000);
  }

  function valueText(s, p) {
    if (!p || p.v === null) return '';
    const n = formatNumber(p.v, s.digits);
    return s.unit ? `${n} ${s.unit}` : n;
  }

  function lastPoint(pts) {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].v !== null) return pts[i];
    return null;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  const builder = createSeriesBuilder();
  const readings = createReadings(readingsBody);

  const session = () => ctx.session ?? {};
  const player = () => ctx.player ?? session().player ?? null;
  function prescanOf(rocketId) {
    const scan = session().prescan instanceof Map && session().prescan.size ? session().prescan : ctx.prescan;
    return scan instanceof Map ? scan.get(rocketId) ?? null : null;
  }

  // Panel 2 is on screen (or the page has no panels to switch).
  const consoleEl = root.closest('.fc-console');
  const onScreen = () => !consoleEl || consoleEl.dataset.panel !== 'globe';
  let behind = false;   // something changed while panel 2 was off screen

  function render() {
    if (!onScreen()) { behind = true; return; }
    behind = false;
    const rocket = store.getFocused();
    const d = rocket?.derived ?? null;
    const scan = rocket ? prescanOf(rocket.id) : null;
    const state = player()?.getState?.() ?? null;
    const first = rocket?.samples[0]?.t ?? null;

    // Zero on the graphs: liftoff (the whole-flight scan knows it before
    // playback gets there), or else the start of the data.
    let zero = Number.isFinite(scan?.state?.liftoffT) ? scan.state.liftoffT : d?.liftoffT;
    const fromLiftoff = Number.isFinite(zero);
    if (!fromLiftoff) zero = Number.isFinite(state?.t0) ? state.t0 : first;
    // Ground level: the scan's, frozen at liftoff, the same one the
    // altitude timeline uses, or else the detector's so far.
    const ground = Number.isFinite(scan?.state?.groundRef) ? scan.state.groundRef : d?.groundRef;
    const series = builder.update(rocket, { zero, ground });

    // The time span: the whole saved flight, filling in as it plays, or
    // for live data the data so far (at least LIVE_MIN_SPAN_S).
    if (Number.isFinite(zero) && Number.isFinite(state?.t0) && Number.isFinite(state?.tEnd) && state.tEnd > state.t0) {
      span = { t0: (state.t0 - zero) * 1000, t1: (state.tEnd - zero) * 1000, fromLiftoff };
    } else if (Number.isFinite(zero) && Number.isFinite(first)) {
      const end = Math.max(store.getNow() ?? first, first + LIVE_MIN_SPAN_S);
      span = { t0: (first - zero) * 1000, t1: (end - zero) * 1000, fromLiftoff };
    } else {
      span = { t0: 0, t1: LIVE_MIN_SPAN_S * 1000, fromLiftoff: false };
    }
    setText(graphsWhen, fromLiftoff ? 'Flight time' : 'Time from the first reading');

    const hovering = hoverT !== null && hoverT >= span.t0 && hoverT <= span.t1;
    for (const c of charts) {
      const data = {};
      for (const s of c.def.series) data[s.key] = series[s.key] ?? [];
      c.chart.setData(data, span.t0, span.t1);
      c.chart.draw(hovering ? hoverT : null);
      const summary = [];
      for (const s of c.def.series) {
        const p = hovering ? c.chart.pointAt(s.key, hoverT) : lastPoint(data[s.key]);
        const text = valueText(s, p);
        setText(c.values[s.key], text || (c.def.series.length > 1 ? '--' : ''));
        summary.push(c.def.series.length > 1 ? `${s.name} ${text || 'none'}` : text || 'none');
      }
      const none = !hovering && c.def.series.every((s) => !lastPoint(data[s.key]));
      setText(c.when, hovering ? `At ${momentText(hoverT)}` : 'Latest');
      c.when.hidden = none;
      c.canvas.setAttribute('aria-label', none
        ? `${c.def.title} graph, no data yet.`
        : `${c.def.title} graph. ${hovering ? `At ${momentText(hoverT)},` : 'Latest,'} ${summary.join(', ')}.`);
    }

    // The readings, at the playhead.
    readings.render(store, rocket, config);
    const now = store.getNow();
    setText(readingsAt, rocket && Number.isFinite(now)
      ? (fromLiftoff ? `At ${formatFlightClock(now - zero)}` : 'Latest')
      : '');
    // With two or more rockets, say whose readings these are.
    const many = store.getRockets().length > 1 && rocket;
    readingsWho.hidden = !many;
    if (many) setChildren(readingsWho, rocketDot(rocket.profile?.color), rocket.profile?.name ?? `Rocket ${rocket.id}`);
  }

  // ------------------------------------------------------------------
  // Picking a moment on the graphs
  // ------------------------------------------------------------------
  function setHover(t) {
    if (t === hoverT) return;
    hoverT = t;
    scheduler.flush();
  }

  function onBlur() { setHover(null); }

  // Left and right step through the readings, Home and End jump to the
  // ends. Right past the newest reading, or Escape, goes back to the newest.
  function onChartKey(e, chart, def) {
    const times = chart.times();
    if (!times.length) return;
    const cur = hoverT;
    let next;
    if (e.key === 'ArrowLeft') next = cur === null ? times[times.length - 1] : [...times].reverse().find((t) => t < cur) ?? times[0];
    else if (e.key === 'ArrowRight') next = cur === null ? null : times.find((t) => t > cur) ?? null;
    else if (e.key === 'Home') next = times[0];
    else if (e.key === 'End') next = times[times.length - 1];
    else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    hoverT = next;
    scheduler.flush();
    if (next === null) {
      announce.textContent = 'Showing the newest values.';
    } else {
      const said = def.series.map((s) => `${s.name} ${valueText(s, chart.pointAt(s.key, next)) || 'none'}`);
      announce.textContent = `${said.join(', ')}, at ${momentText(next)}.`;
    }
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  const scheduler = createScheduler(render, { maxFps: DRAW_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'source' || change.type === 'clear' || change.type === 'focus') {
      // Another store or another rocket: start the graphs over.
      builder.reset();
      hoverT = null;
    }
    scheduler.schedule();
  });
  // Redraw when the graphs change size and when the fonts arrive.
  const resize = new ResizeObserver(() => scheduler.schedule());
  for (const c of charts) resize.observe(c.canvas);
  // Catch up when panel 2 comes on screen.
  const panelWatch = new MutationObserver(() => { if (behind && onScreen()) scheduler.flush(); });
  if (consoleEl) panelWatch.observe(consoleEl, { attributes: true, attributeFilter: ['data-panel'] });
  let alive = true;
  document.fonts?.ready.then(() => { if (alive) scheduler.schedule(); });
  render();

  return {
    destroy() {
      alive = false;
      unsubscribe();
      scheduler.cancel();
      resize.disconnect();
      panelWatch.disconnect();
      for (const c of charts) c.canvas.removeEventListener('blur', onBlur);
      for (const part of parts) {
        try { part?.destroy?.(); } catch (err) { console.error('Flight Console: error closing a view', err); }
      }
      root.replaceChildren();
    },
  };
}
