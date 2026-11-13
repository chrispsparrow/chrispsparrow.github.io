// bench-panel.js: the Bench Console's panels, moved here from its main.js
// so the Flight Console can show them for a board on USB. It reads the
// lines it's handed and keeps every panel up to date: the connection bar,
// the errors box, the latest readings, the graphs, the raw output and Save
// as CSV.
//
// Data flow: text lines -> BlockParser (one status block per second) -> one
// record per block (kept for the CSV) -> latest values and the 10-minute
// graph series -> drawn at most once per animation frame.
//
// The graphs run on the board's own clock, the TIME RUNNING in each block's
// banner, so data that arrives in a burst still lands at the right time.
//
// It doesn't open the port. The page wires a serial link to it:
//   const panel = createBenchPanel({ onBlock(block) {}, onRestart() {}, onConnect, onDisconnect });
//   link onLine:  panel.handleLine(line, t)
//   link onOpen:  panel.connected()
//   link onClose: panel.closed()
//   link onLink:  panel.setLink(state, text)
//   link onNote:  panel.note(text, kind)
//
// It looks up the same bc-* element ids the Bench Console page used. The
// Position trace (bc-track-canvas, bc-track-info, bc-track-osm) and the
// connection controls (bc-connect, bc-disconnect, bc-link-dot,
// bc-link-text, bc-link-note, bc-unsupported) are optional: if they're
// missing, that part is skipped.

import { BANNER, FIELD, FIELDS, SECTIONS, BlockParser, readLock, readPosition } from '../bench/parse.js?v=3';
import { buildCsv, csvFileName } from '../bench/csv.js?v=3';
import { TimeChart, TrackPlot, readTheme, formatClock, formatRunning } from '../bench/charts.js?v=3';
import { LINK_TEXT, serialSupported } from './serial-link.js';

const WINDOW_MS = 10 * 60 * 1000;   // the graphs and the trace keep the last 10 minutes
const GAP_MS = 6000;                // graph lines break across longer gaps (the board prints every second)
const HEARTBEAT_LATE_MS = 3000;     // a block comes every second, so 3 s without one is late
const STALE_MS = 3000;              // readings older than this are marked as old
const RAW_LINES = 1000;             // lines kept in "Raw serial output", about 45 blocks
const ERRORS_SHOWN = 50;

// One entry per graph: its canvas, its series and how to show a value.
const CHARTS = [
  { id: 'alt', name: 'Altitude', series: [{ key: 'alt', name: 'Altitude' }], minSpan: 10, floorZero: false, digits: 1 },
  { id: 'sats', name: 'Connected satellites', series: [{ key: 'sats', name: 'Satellites' }], minSpan: 4, integer: true, digits: 0 },
  { id: 'quality', name: 'Lock quality', series: [{ key: 'quality', name: 'Lock quality' }], minSpan: 100, integer: true, digits: 0 },
  { id: 'gpsRate', name: 'GPS data rate', series: [{ key: 'gpsRate', name: 'GPS data rate' }], minSpan: 100, integer: true, digits: 0 },
  { id: 'radio', name: 'Radio packets', series: [{ key: 'radioSent', name: 'Sent' }, { key: 'radioErrors', name: 'Errors' }], minSpan: 4, integer: true, digits: 0 },
];

// options:
//   onBlock(block)    each finished block, in order (see BlockParser.push in bench/parse.js)
//   onRestart()       the board restarted (TIME RUNNING or the heartbeat number went back)
//   onConnect()       Connect was pressed, if the page has a bc-connect button
//   onDisconnect()    Disconnect was pressed, if the page has a bc-disconnect button
//   supported         whether the browser can open serial ports (default: it checks)
//   root              where the graphs ([data-chart]) are looked for, and where
//                     the --bc-* colors are read from (default: document.body)
export function createBenchPanel({ onBlock, onRestart, onConnect, onDisconnect, supported = serialSupported(), root = document.body } = {}) {
  const $ = (id) => document.getElementById(id);
  const el = {
    connect: $('bc-connect'),
    disconnect: $('bc-disconnect'),
    save: $('bc-save'),
    unsupported: $('bc-unsupported'),
    linkDot: $('bc-link-dot'),
    linkText: $('bc-link-text'),
    linkNote: $('bc-link-note'),
    beatDot: $('bc-beat-dot'),
    beatText: $('bc-beat-text'),
    beatNum: $('bc-beat-num'),
    lostDot: $('bc-lost-dot'),
    lost: $('bc-lost'),
    count: $('bc-count'),
    errors: $('bc-errors'),
    errorsList: $('bc-errors-list'),
    errorsCount: $('bc-errors-count'),
    errorsClear: $('bc-errors-clear'),
    readings: $('bc-readings-groups'),
    readingsAge: $('bc-readings-age'),
    trackCanvas: $('bc-track-canvas'),
    trackInfo: $('bc-track-info'),
    trackLink: $('bc-track-osm'),
    raw: $('bc-raw'),
    rawLog: $('bc-raw-log'),
    announce: $('bc-announce'),
  };
  // The Position trace is optional. The Flight Console's 3D view shows
  // the position, so a page can leave it out.
  const hasTrack = Boolean(el.trackCanvas && el.trackInfo && el.trackLink);

  const state = {
    link: 'idle',
    refocus: false,       // Connect or Disconnect had focus when it turned off (see setLink)
    savedBlocks: 0,       // blocks in the last CSV file saved
    parser: new BlockParser(),
    blocks: [],           // every block this visit, for the CSV
    units: {},            // first unit the board sent for each value
    latest: {},           // key -> newest value
    latestT: null,        // when the newest block finished arriving
    beat: null,           // { t, heartbeat } from the newest banner
    lostBlocks: 0,        // heartbeat numbers skipped, this visit
    clock: null,          // { boardT, t }: the newest TIME RUNNING (ms) and when its banner arrived
    runStart: null,       // board time of the first block since the page loaded or the board restarted
    errors: [],           // { t, message, times }
    errorTotal: 0,
    errorsDirty: false,
    raw: [],
    series: { alt: [], sats: [], quality: [], gpsRate: [], radioSent: [], radioErrors: [], pos: [] },
    hoverT: null,         // board time picked on a graph, or null for the latest
  };

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  // `text` is what the serial link says for this state (its LINK_TEXT).
  function setLink(link, text = LINK_TEXT[link] ?? link) {
    state.link = link;
    if (el.linkText) el.linkText.textContent = text;
    if (el.linkDot) el.linkDot.dataset.state = link;
    const busy = link === 'picking' || link === 'opening' || link === 'closing';
    // Pressing Connect or Disconnect turns that button off. Keyboard focus
    // would fall back to the page, so it goes to the other button instead
    // once that one is on again.
    const active = document.activeElement;
    if (active && (active === el.connect || active === el.disconnect)) state.refocus = true;
    if (el.connect) el.connect.disabled = !supported || busy || link === 'open';
    if (el.disconnect) el.disconnect.disabled = link !== 'open';
    if (state.refocus) {
      const focused = document.activeElement;
      const lost = !focused || focused === document.body || focused.disabled;
      const next = [el.disconnect, el.connect].find((b) => b && !b.disabled);
      if (lost && next) next.focus({ preventScroll: true });
      // Done once the link settles, or if focus went somewhere else.
      if (!busy || !lost) state.refocus = false;
    }
    scheduleRender();
  }

  function note(text, kind = 'info') {
    if (!el.linkNote) return;
    el.linkNote.textContent = text;
    el.linkNote.dataset.kind = kind;
    el.linkNote.hidden = !text;
  }

  // A new connection just opened.
  function connected() {
    state.parser.newConnection();
    breakSeries();
    scheduleRender();
  }

  // The port closed.
  function closed() {
    // A block cut off by the disconnect still counts, with what it had.
    const cut = state.parser.finish();
    if (cut) addBlock(cut, Date.now());
    breakSeries();
    scheduleRender();
  }

  // ------------------------------------------------------------------
  // Lines and blocks
  // ------------------------------------------------------------------

  function handleLine(line, t) {
    state.raw.push(line);
    if (state.raw.length > RAW_LINES) state.raw.splice(0, state.raw.length - RAW_LINES);

    const r = state.parser.push(line, t);
    if (r.done) addBlock(r.done, t);
    if (r.type === 'banner') addBanner(r, t);
    else if (r.type === 'error') addError(r.message || line, t);
    scheduleRender();
  }

  // Hands a block or a restart to the page. An error there mustn't stop
  // the panel.
  function tell(callback, ...args) {
    try { callback?.(...args); } catch (err) { console.error('Flight Console: bench panel listener error', err); }
  }

  function addBanner(r, t) {
    state.beat = { t, heartbeat: r.block.heartbeat };
    state.lostBlocks += r.missed;
    if (r.restarted) {
      clearSeries();
      note(hasTrack
        ? 'The board restarted, so the graphs and the position trace started over. The CSV file still has every block.'
        : 'The board restarted, so the graphs started over. The CSV file still has every block.');
      tell(onRestart);
    }
  }

  function addBlock(block, t) {
    state.blocks.push(block);
    for (const [key, value] of Object.entries(block.fields)) {
      state.latest[key] = value;
      if (value.unit && !state.units[key]) state.units[key] = value.unit;
    }
    state.latestT = t;
    tell(onBlock, block);
    // Without the board's time there's nowhere to put it on the graphs.
    if (block.timeRunning === null) return;

    const bt = block.timeRunning * 1000;
    state.clock = { boardT: bt, t: block.t };
    if (state.runStart === null) state.runStart = bt;

    const f = block.fields;
    const push = (key, v, extra) => state.series[key].push({ t: bt, v, ...extra });
    if (Number.isFinite(f.alt?.num) && readLock(f.lock) !== false) push('alt', f.alt.num);
    if (Number.isFinite(f.sats?.num)) push('sats', f.sats.num);
    if (Number.isFinite(f.quality?.num)) push('quality', f.quality.num, { hdop: f.quality.hdopRaw });
    if (Number.isFinite(f.gpsRate?.num)) push('gpsRate', f.gpsRate.num, { word: f.gpsRate.word });
    if (Number.isFinite(f.radioSent?.num)) push('radioSent', f.radioSent.num);
    if (Number.isFinite(f.radioErrors?.num)) push('radioErrors', f.radioErrors.num);
    const pos = readPosition(f);
    if (pos) state.series.pos.push({ t: bt, ...pos });
  }

  // A break in every graph line, at each connect and disconnect.
  function breakSeries() {
    for (const [key, pts] of Object.entries(state.series)) {
      const last = pts[pts.length - 1];
      if (!last) continue;
      if (key === 'pos') {
        if (last.lat !== null) pts.push({ t: last.t, lat: null, lon: null });
      } else if (last.v !== null) {
        pts.push({ t: last.t, v: null });
      }
    }
  }

  // After a board restart its TIME RUNNING starts over, so the old points
  // would land in the wrong place. The graphs start over too.
  function clearSeries() {
    for (const pts of Object.values(state.series)) pts.length = 0;
    state.clock = null;
    state.runStart = null;
    state.hoverT = null;
  }

  function addError(message, t) {
    state.errorTotal++;
    // The same error again, with no other error in between, adds to its count.
    const last = state.errors[0];
    if (last && last.message === message) {
      last.times++;
      last.t = t;
    } else {
      state.errors.unshift({ t, firstT: t, message, times: 1 });
      if (state.errors.length > ERRORS_SHOWN) state.errors.length = ERRORS_SHOWN;
    }
    state.errorsDirty = true;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  let theme;
  let charts = [];
  let track = null;
  const readingRows = {};   // key -> { dd, value } for the rows that show every field
  const pickGroups = [];    // { fields, dl, shown } for sections that show only what's ON
  let renderQueued = false;
  let destroyed = false;

  function scheduleRender() {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!destroyed) render();
    });
  }

  // "Just now", "4 s ago", "3 min ago".
  function ago(t, now) {
    const s = Math.floor((now - t) / 1000);
    if (s < 1) return 'Just now';
    if (s < 60) return `${s} s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.floor(m / 60)} h ago`;
  }

  // The time span the graphs show, in board time: up to 10 minutes, ending at
  // the board's time now while connected, or at the last block after a
  // disconnect. Never under a minute, and never before the board started.
  function timeSpan(now) {
    if (!state.clock) return { t0: 0, t1: 60000 };
    const t1 = state.clock.boardT + (state.link === 'open' ? Math.max(0, now - state.clock.t) : 0);
    const t0 = Math.max(0, Math.min(t1 - 60000, Math.max(state.runStart, t1 - WINDOW_MS)));
    return { t0, t1: Math.max(t1, t0 + 60000) };
  }

  // Drops graph points older than the window, keeping a little extra so a
  // line can run in from the left edge.
  function prune(t1) {
    const cutoff = t1 - WINDOW_MS - GAP_MS;
    for (const pts of Object.values(state.series)) {
      let i = 0;
      while (i < pts.length && pts[i].t < cutoff) i++;
      if (i) pts.splice(0, i);
    }
  }

  function render() {
    const now = Date.now();
    const { t0, t1 } = timeSpan(now);
    if (state.link === 'open') prune(t1);

    el.count.textContent = state.blocks.length.toLocaleString();
    el.save.disabled = state.blocks.length === 0;

    renderHeartbeat(now);
    renderReadings(now);
    renderErrors();
    renderCharts(t0, t1);
    if (track) renderTrack(t0, t1);
    if (el.raw.open) renderRaw();
  }

  function renderHeartbeat(now) {
    if (!state.beat) {
      el.beatText.textContent = 'None yet';
      el.beatDot.dataset.state = 'none';
      el.beatNum.hidden = true;
      el.lostDot.dataset.state = 'none';
      return;
    }
    el.beatText.textContent = ago(state.beat.t, now);
    el.beatDot.dataset.state = now - state.beat.t > HEARTBEAT_LATE_MS ? 'late' : 'ok';
    el.beatNum.hidden = state.beat.heartbeat === null;
    el.beatNum.textContent = `${BANNER.heartbeat} #${state.beat.heartbeat}`;
    el.lost.textContent = state.lostBlocks.toLocaleString();
    el.lostDot.dataset.state = state.lostBlocks ? 'late' : 'ok';
  }

  // A status word in its color: LOCKED, SEARCHING, GOOD, LOW, SILENT, ON.
  function pill(value) {
    const span = document.createElement('span');
    span.className = 'bc-pill';
    span.dataset.tone = value.tone;
    span.textContent = value.word;
    return span;
  }

  function numberText(value, unit) {
    if (value.num === null) return value.text;
    if (!unit) return value.raw;
    return unit === '°' ? value.raw + unit : `${value.raw} ${unit}`;
  }

  // Fills one reading's <dd> from its value, the way the field's kind says.
  function showValue(dd, field, value) {
    dd.classList.toggle('is-empty', !value);
    if (!value) {
      dd.textContent = 'No data yet';
      return;
    }
    const unit = value.unit || field.unit || '';
    const parts = [];
    if (field.kind === 'status' || field.kind === 'onoff') {
      parts.push(value.tone ? pill(value) : value.text);
    } else if (field.kind === 'rate') {
      if (value.word) parts.push(pill(value));
      if (value.num !== null) parts.push(` ${numberText(value, unit)}`);
      else if (!value.word) parts.push(value.text);
    } else if (field.kind === 'quality') {
      parts.push(numberText(value, unit));
      if (value.hdopRaw) {
        const sub = document.createElement('span');
        sub.className = 'bc-dd-sub';
        sub.textContent = `${field.hdop} ${value.hdopRaw}`;
        parts.push(sub);
      }
    } else {
      parts.push(numberText(value, unit));
    }
    dd.replaceChildren(...parts);
  }

  function readingRow(field) {
    const row = document.createElement('div');
    row.className = 'bc-reading';
    const dt = document.createElement('dt');
    dt.textContent = field.label;
    const dd = document.createElement('dd');
    dd.className = 'bc-num';
    row.append(dt, dd);
    return { row, dd };
  }

  // One group per section, in the board's order, built once at the start.
  // A section of ON and OFF fields (GPS MOTION MODEL) shows only the ones
  // that are ON.
  function buildReadings() {
    const groups = SECTIONS.map((section) => {
      const fields = FIELDS.filter((f) => f.section === section);
      const group = document.createElement('div');
      group.className = 'bc-group';
      const title = document.createElement('h3');
      title.className = 'bc-group-title';
      title.textContent = section;
      const dl = document.createElement('dl');
      dl.className = 'bc-readings-list';
      group.append(title, dl);
      if (fields.every((f) => f.kind === 'onoff')) {
        pickGroups.push({ fields, dl, shown: undefined });
      } else {
        for (const f of fields) {
          const { row, dd } = readingRow(f);
          showValue(dd, f, undefined);
          dl.append(row);
          readingRows[f.key] = { dd, value: undefined };
        }
      }
      return group;
    });
    el.readings.replaceChildren(...groups);
  }

  function renderReadings(now) {
    for (const field of FIELDS) {
      const row = readingRows[field.key];
      if (!row) continue;
      const value = state.latest[field.key];
      if (row.value === value) continue;
      row.value = value;
      showValue(row.dd, field, value);
    }

    for (const g of pickGroups) {
      const seen = g.fields.some((f) => state.latest[f.key]);
      const on = g.fields.filter((f) => state.latest[f.key]?.tone === 'on');
      const key = seen ? on.map((f) => f.key).join() || 'none' : null;
      if (key === g.shown) continue;
      g.shown = key;
      if (!seen) {
        g.dl.replaceChildren(emptyRow('No data yet'));
        continue;
      }
      // If none is ON, every field shows, so it's clear they're all OFF.
      const shown = on.length ? on : g.fields.filter((f) => state.latest[f.key]);
      g.dl.replaceChildren(...shown.map((f) => {
        const { row, dd } = readingRow(f);
        showValue(dd, f, state.latest[f.key]);
        return row;
      }));
    }

    if (state.latestT === null) {
      el.readingsAge.textContent = 'No readings yet';
      el.readingsAge.dataset.stale = '';
    } else {
      el.readingsAge.textContent = `Updated ${ago(state.latestT, now).toLowerCase()}`;
      el.readingsAge.dataset.stale = now - state.latestT > STALE_MS ? 'yes' : '';
    }
  }

  // A row with no label, for "No data yet" in a section that shows only what's ON.
  function emptyRow(text) {
    const row = document.createElement('div');
    row.className = 'bc-reading bc-reading--note';
    const dd = document.createElement('dd');
    dd.className = 'is-empty';
    dd.textContent = text;
    row.append(dd);
    return row;
  }

  function renderErrors() {
    if (!state.errorsDirty) return;
    state.errorsDirty = false;
    el.errors.hidden = state.errors.length === 0;
    el.errorsCount.textContent = state.errorTotal ? `(${state.errorTotal.toLocaleString()})` : '';
    const items = state.errors.map((e) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = new Date(e.t).toISOString();
      time.textContent = formatClock(e.t);
      const msg = document.createElement('span');
      msg.className = 'bc-error-msg';
      msg.textContent = e.message;
      li.append(time, msg);
      if (e.times > 1) {
        const n = document.createElement('span');
        n.className = 'bc-error-times';
        n.textContent = `${e.times.toLocaleString()} times since ${formatClock(e.firstT)}`;
        li.append(n);
      }
      return li;
    });
    el.errorsList.replaceChildren(...items);
  }

  // A graph point as text, in the board's own style: "17.3 m",
  // "100 % (HDOP 0.99)", "GOOD 723 char/s".
  function chartValue(key, p, digits) {
    if (!p) return 'No data';
    const n = p.v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const unit = state.units[key] || FIELD[key].unit || '';
    if (key === 'quality') return `${n} ${unit}${p.hdop ? ` (${FIELD.quality.hdop} ${p.hdop})` : ''}`;
    if (key === 'gpsRate') return `${p.word ? `${p.word} ` : ''}${n} ${unit}`;
    return unit ? `${n} ${unit}` : n;
  }

  function lastPoint(pts) {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].v !== null) return pts[i];
    return null;
  }

  function renderCharts(t0, t1) {
    for (const c of charts) {
      const data = {};
      for (const s of c.def.series) data[s.key] = state.series[s.key];
      c.chart.setData(data, t0, t1);
      c.chart.draw(state.hoverT);

      const hovering = state.hoverT !== null && state.hoverT >= t0 && state.hoverT <= t1;
      const summary = [];
      for (const s of c.def.series) {
        const p = hovering ? c.chart.pointAt(s.key, state.hoverT) : lastPoint(state.series[s.key]);
        const text = chartValue(s.key, p, c.def.digits);
        c.values[s.key].textContent = text;
        summary.push(c.def.series.length > 1 ? `${s.name} ${text}` : text);
      }
      c.when.textContent = hovering ? `At ${formatRunning(state.hoverT)}` : 'Latest';
      c.when.hidden = !hovering && c.def.series.every((s) => !lastPoint(state.series[s.key]));
      c.canvas.setAttribute('aria-label', `${c.def.name} graph, last 10 minutes. ${hovering ? `At ${formatRunning(state.hoverT)} running,` : 'Latest'} ${summary.join(', ')}.`);
    }
  }

  function renderTrack(t0, t1) {
    const pts = state.series.pos.filter((p) => p.lat !== null && p.t >= t0 && p.t <= t1);
    track.setData(pts);
    track.draw(state.hoverT);
    const ext = track.extent();
    const lat = state.latest.lat;
    const lon = state.latest.lon;
    if (!ext) {
      const lock = readLock(state.latest.lock);
      el.trackInfo.textContent = lock === false ? 'Waiting for a GPS lock. The trace starts at the first one.' : 'The trace starts at the first GPS lock.';
      el.trackLink.hidden = true;
      el.trackCanvas.setAttribute('aria-label', 'Position trace, no position yet.');
      return;
    }
    const last = pts[pts.length - 1];
    const size = `${ext.eastWest.toFixed(1)} m east to west by ${ext.northSouth.toFixed(1)} m north to south`;
    const latest = lat?.raw && lon?.raw ? `${lat.raw}, ${lon.raw}` : `${last.lat}, ${last.lon}`;
    el.trackInfo.textContent = `Latest fix ${latest}. The trace covers ${size} over ${pts.length.toLocaleString()} fixes.`;
    el.trackLink.href = `https://www.openstreetmap.org/?mlat=${last.lat}&mlon=${last.lon}#map=18/${last.lat}/${last.lon}`;
    el.trackLink.hidden = false;
    el.trackCanvas.setAttribute('aria-label', `Position trace, last 10 minutes. ${pts.length} fixes covering ${size}.`);
  }

  function renderRaw() {
    const log = el.rawLog;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.textContent = state.raw.length ? state.raw.join('\n') : 'Nothing received yet.';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------------------------
  // Picking a time on the graphs
  // ------------------------------------------------------------------

  function setHover(t) {
    if (t === state.hoverT) return;
    state.hoverT = t;
    scheduleRender();
  }

  // Left and right step through the readings, Home and End jump to the
  // ends. Right past the newest reading, or Escape, goes back to the latest values.
  function onChartKey(e, chart, def) {
    const times = chart.times();
    if (!times.length) return;
    const cur = state.hoverT;
    let next;
    if (e.key === 'ArrowLeft') next = cur === null ? times[times.length - 1] : [...times].reverse().find((t) => t < cur) ?? times[0];
    else if (e.key === 'ArrowRight') next = cur === null ? null : times.find((t) => t > cur) ?? null;
    else if (e.key === 'Home') next = times[0];
    else if (e.key === 'End') next = times[times.length - 1];
    else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    state.hoverT = next;
    render();
    if (next === null) {
      el.announce.textContent = 'Showing the latest values.';
    } else {
      const parts = def.series.map((s) => `${s.name} ${chartValue(s.key, chart.pointAt(s.key, next), def.digits)}`);
      el.announce.textContent = `${parts.join(', ')}, at ${formatRunning(next)} running.`;
    }
  }

  // ------------------------------------------------------------------
  // Save as CSV
  // ------------------------------------------------------------------

  function saveCsv() {
    if (!state.blocks.length) return;
    const blob = new Blob([buildCsv(state.blocks, state.units)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    state.savedBlocks = state.blocks.length;
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------

  const clearErrors = () => {
    state.errors = [];
    state.errorTotal = 0;
    state.errorsDirty = true;
    scheduleRender();
  };
  const onRawToggle = () => el.raw.open && renderRaw();
  let resize = null;
  let timer = null;

  function start() {
    theme = readTheme(root);
    const colors = {
      alt: theme.gold, sats: theme.gold, quality: theme.gold, gpsRate: theme.gold,
      radioSent: theme.sent, radioErrors: theme.err,
    };

    buildReadings();
    charts = CHARTS.map((def) => {
      const panel = root.querySelector(`[data-chart="${def.id}"]`);
      const canvas = panel.querySelector('canvas');
      const values = {};
      for (const s of def.series) values[s.key] = panel.querySelector(`[data-value="${s.key}"]`);
      const entry = { def, canvas, values, when: panel.querySelector('[data-when]') };
      entry.chart = new TimeChart(canvas, {
        series: def.series.map((s) => ({ key: s.key, color: colors[s.key] })),
        theme,
        integer: !!def.integer,
        floorZero: def.floorZero !== false,
        minSpan: def.minSpan,
        gapMs: GAP_MS,
        onHover: setHover,
        onKey: (e, chart) => onChartKey(e, chart, def),
      });
      canvas.addEventListener('blur', () => setHover(null));
      return entry;
    });
    if (hasTrack) track = new TrackPlot(el.trackCanvas, { theme });

    if (!supported && el.unsupported) el.unsupported.hidden = false;
    setLink('idle');

    if (el.connect && onConnect) el.connect.addEventListener('click', onConnect);
    if (el.disconnect && onDisconnect) el.disconnect.addEventListener('click', onDisconnect);
    el.save.addEventListener('click', saveCsv);
    el.errorsClear.addEventListener('click', clearErrors);
    el.raw.addEventListener('toggle', onRawToggle);

    // Redraw when the panels change size, when the fonts arrive, and every
    // second for the "ago" times and the sliding graph window.
    resize = new ResizeObserver(() => scheduleRender());
    for (const c of charts) resize.observe(c.canvas);
    if (track) resize.observe(el.trackCanvas);
    document.fonts?.ready.then(() => scheduleRender());
    timer = setInterval(render, 1000);
    render();
  }

  // Stops the timer and the listeners, for a page that takes the panel
  // away. The elements and what they show stay as they are.
  function destroy() {
    destroyed = true;
    clearInterval(timer);
    resize?.disconnect();
    if (el.connect && onConnect) el.connect.removeEventListener('click', onConnect);
    if (el.disconnect && onDisconnect) el.disconnect.removeEventListener('click', onDisconnect);
    el.save.removeEventListener('click', saveCsv);
    el.errorsClear.removeEventListener('click', clearErrors);
    el.raw.removeEventListener('toggle', onRawToggle);
  }

  start();

  return {
    handleLine,
    connected,
    closed,
    setLink,
    note,
    render: scheduleRender,
    hasBlocks: () => state.blocks.length > 0,
    // Blocks that came in after the last Save as CSV (or with no save yet).
    hasUnsaved: () => state.blocks.length > state.savedBlocks,
    destroy,
  };
}
