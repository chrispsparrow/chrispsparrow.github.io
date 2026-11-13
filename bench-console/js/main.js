// main.js: the Bench Console. Opens the board's USB serial port with the
// Web Serial API, reads it line by line, and keeps every panel up to date.
//
// Data flow: serial bytes -> text lines -> parseLine() -> one record per
// line (kept for the CSV) -> latest values, the 10-minute graph series and
// the position trace -> drawn at most once per animation frame.

import { FIELDS, FIELD, parseLine, readFix, readPosition } from './parse.js';
import { buildCsv, csvFileName } from './csv.js';
import { TimeChart, TrackPlot, readTheme, formatClock } from './charts.js';

const BAUD = 115200;
const WINDOW_MS = 10 * 60 * 1000;   // the graphs and the trace keep the last 10 minutes
const GAP_MS = 6000;                // graph lines break across longer gaps (the board prints every second)
const HEARTBEAT_LATE_MS = 5000;     // the firmware sends a heartbeat every 2 s
const STALE_MS = 5000;              // readings older than this are marked as old
const RAW_LINES = 300;              // lines kept in "Raw serial output"
const MAX_LINE = 4096;              // a "line" longer than this is cut, so noise can't grow forever
const ERRORS_SHOWN = 50;

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
  count: $('bc-count'),
  errors: $('bc-errors'),
  errorsList: $('bc-errors-list'),
  errorsCount: $('bc-errors-count'),
  errorsClear: $('bc-errors-clear'),
  readings: $('bc-readings-list'),
  readingsAge: $('bc-readings-age'),
  trackCanvas: $('bc-track-canvas'),
  trackInfo: $('bc-track-info'),
  trackLink: $('bc-track-osm'),
  raw: $('bc-raw'),
  rawLog: $('bc-raw-log'),
  announce: $('bc-announce'),
};

const state = {
  port: null,
  reader: null,
  loop: null,
  keepReading: false,
  lost: false,
  link: 'idle',
  records: [],          // every line this visit, for the CSV
  units: {},            // first unit the board sent for each value
  latest: {},           // key -> newest value
  latestT: null,        // when the newest reading line arrived
  heartbeatT: null,
  errors: [],           // { t, message, times }
  errorTotal: 0,
  raw: [],
  series: { alt: [], sats: [], hdop: [], radioSent: [], radioErrors: [], pos: [] },
  hoverT: null,
};

// ------------------------------------------------------------------
// Connection
// ------------------------------------------------------------------

const LINK_TEXT = {
  idle: 'Not connected',
  picking: 'Pick the board in the list',
  opening: 'Connecting',
  open: `Connected at ${BAUD.toLocaleString('en-US')} baud`,
  closing: 'Disconnecting',
  closed: 'Disconnected',
  lost: 'Board unplugged',
};

function setLink(link) {
  state.link = link;
  el.linkText.textContent = LINK_TEXT[link];
  el.linkDot.dataset.state = link;
  const busy = link === 'picking' || link === 'opening' || link === 'closing';
  el.connect.disabled = !('serial' in navigator) || busy || link === 'open';
  el.disconnect.disabled = link !== 'open';
}

function note(text, kind = 'info') {
  el.linkNote.textContent = text;
  el.linkNote.dataset.kind = kind;
  el.linkNote.hidden = !text;
}

async function connect() {
  note('');
  setLink('picking');
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    setLink(state.records.length ? 'closed' : 'idle');
    if (err.name === 'NotFoundError') note('No port was picked, so nothing changed.');
    else if (err.name === 'SecurityError') note('The browser blocked access to serial ports on this page.', 'warn');
    else note(`The port list didn't open (${err.message}).`, 'warn');
    return;
  }

  setLink('opening');
  try {
    await port.open({ baudRate: BAUD });
  } catch (err) {
    setLink(state.records.length ? 'closed' : 'idle');
    note('The port didn\'t open. Another program is probably using it, so close any serial monitor and press Connect again.', 'warn');
    console.warn('Bench Console: port.open failed', err);
    return;
  }
  // The SAMD21's USB serial reports "connected" only while DTR is on. Most
  // systems turn it on when the port opens. This makes sure.
  try { await port.setSignals({ dataTerminalReady: true }); } catch { /* not every port supports it */ }

  state.port = port;
  state.keepReading = true;
  state.lost = false;
  breakSeries(Date.now());
  setLink('open');
  state.loop = readLoop(port);
}

async function disconnect() {
  if (!state.port) return;
  state.keepReading = false;
  setLink('closing');
  try { await state.reader?.cancel(); } catch { /* already closed */ }
  await state.loop;
}

// Reads until Disconnect or until the board goes away. Some read errors
// (a dropped byte, a framing error) don't close the port. The browser
// hands over a fresh stream and reading goes on.
async function readLoop(port) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (port.readable && state.keepReading) {
    const reader = port.readable.getReader();
    state.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = takeLines(buffer);
      }
    } catch (err) {
      if (err.name === 'NetworkError') state.lost = true;
      else note(`Some data was lost while reading (${err.name}), but the page is still reading.`, 'warn');
    } finally {
      reader.releaseLock();
      state.reader = null;
    }
  }
  try { await port.close(); } catch { /* the board may already be gone */ }
  if (state.port === port) state.port = null;
  breakSeries(Date.now());
  if (state.keepReading || state.lost) {
    setLink('lost');
    note('The board was unplugged or stopped answering. Plug it back in and press Connect.', 'warn');
  } else {
    setLink('closed');
  }
  state.keepReading = false;
  scheduleRender();
}

// Unplugging the board fires this even when a read is waiting.
function onSerialDisconnect(e) {
  if (e.target !== state.port) return;
  state.lost = true;
  state.reader?.cancel().catch(() => {});
}

// Splits off every finished line and returns the unfinished rest.
function takeLines(buffer) {
  const now = Date.now();
  let start = 0;
  let nl;
  while ((nl = buffer.indexOf('\n', start)) !== -1) {
    handleLine(buffer.slice(start, nl).replace(/\r$/, ''), now);
    start = nl + 1;
  }
  let rest = buffer.slice(start);
  if (rest.length > MAX_LINE) {
    handleLine(rest, now);
    rest = '';
  }
  return rest;
}

// ------------------------------------------------------------------
// Lines
// ------------------------------------------------------------------

function handleLine(line, t) {
  const parsed = parseLine(line);
  if (parsed.type === 'empty') return;
  state.records.push({ t, type: parsed.type, fields: parsed.fields, line });

  state.raw.push(line);
  if (state.raw.length > RAW_LINES) state.raw.splice(0, state.raw.length - RAW_LINES);

  if (parsed.type === 'error') addError(parsed.message || line, t);
  else if (parsed.type === 'heartbeat') state.heartbeatT = t;
  else if (parsed.type === 'data') addReadings(parsed.fields, t);
  scheduleRender();
}

function addReadings(fields, t) {
  for (const [key, value] of Object.entries(fields)) {
    state.latest[key] = value;
    if (value.unit && !state.units[key]) state.units[key] = value.unit;
  }
  state.latestT = t;

  const fix = readFix(fields.fix);
  const push = (key, v) => state.series[key].push({ t, v });
  if (Number.isFinite(fields.alt?.num) && fix !== false) push('alt', fields.alt.num);
  if (Number.isFinite(fields.sats?.num)) push('sats', fields.sats.num);
  if (Number.isFinite(fields.hdop?.num)) push('hdop', fields.hdop.num);
  if (Number.isFinite(fields.radioSent?.num)) push('radioSent', fields.radioSent.num);
  if (Number.isFinite(fields.radioErrors?.num)) push('radioErrors', fields.radioErrors.num);
  const pos = readPosition(fields);
  if (pos) state.series.pos.push({ t, ...pos });
}

// A break in every graph line, at each connect and disconnect.
function breakSeries(t) {
  for (const [key, pts] of Object.entries(state.series)) {
    if (!pts.length || pts[pts.length - 1].v === null) continue;
    pts.push(key === 'pos' ? { t, lat: null, lon: null, v: null } : { t, v: null });
  }
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
let track;
const readingRows = {};
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
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

const DISPLAY_UNIT = { deg: '°', degree: '°', degrees: '°' };
function showValue(value) {
  if (!value) return '';
  if (value.num === null) return value.text.charAt(0).toUpperCase() + value.text.slice(1);
  const unit = DISPLAY_UNIT[value.unit.toLowerCase()] ?? value.unit;
  if (!unit) return value.raw;
  return unit === '°' || unit === '%' ? value.raw + unit : `${value.raw} ${unit}`;
}

// The time span the graphs show: up to 10 minutes, ending now while
// connected, or at the last line after a disconnect. Never under a minute.
function timeSpan(now) {
  const lastT = state.records.length ? state.records[state.records.length - 1].t : now;
  const t1 = state.link === 'open' ? now : lastT;
  const firstT = state.records.length ? state.records[0].t : t1;
  const t0 = Math.min(t1 - 60000, Math.max(firstT, t1 - WINDOW_MS));
  return { t0, t1 };
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

  el.count.textContent = state.records.length.toLocaleString();
  el.save.disabled = state.records.length === 0;

  renderHeartbeat(now);
  renderReadings(now);
  renderErrors();
  renderCharts(t0, t1);
  renderTrack(t0, t1);
  if (el.raw.open) renderRaw();
}

function renderHeartbeat(now) {
  if (state.heartbeatT === null) {
    el.beatText.textContent = 'None yet';
    el.beatDot.dataset.state = 'none';
    return;
  }
  el.beatText.textContent = ago(state.heartbeatT, now);
  el.beatDot.dataset.state = now - state.heartbeatT > HEARTBEAT_LATE_MS ? 'late' : 'ok';
}

function readingRow(field) {
  if (readingRows[field.key]) return readingRows[field.key];
  const row = document.createElement('div');
  row.className = 'bc-reading';
  const dt = document.createElement('dt');
  dt.textContent = field.label;
  const dd = document.createElement('dd');
  dd.className = 'bc-num';
  row.append(dt, dd);
  // Rows stay in the order of FIELDS, whatever order they first arrive in.
  const after = FIELDS.slice(FIELDS.indexOf(field) + 1).map((f) => readingRows[f.key]).find(Boolean);
  el.readings.insertBefore(row, after || null);
  readingRows[field.key] = { row, dd };
  return readingRows[field.key];
}

function renderReadings(now) {
  for (const field of FIELDS) {
    const value = state.latest[field.key];
    if (!value && !field.main) continue;
    const { row, dd } = readingRow(field);
    dd.textContent = value ? showValue(value) : 'No data yet';
    dd.classList.toggle('is-empty', !value);
    if (field.key === 'fix') {
      const fix = readFix(value);
      row.dataset.fix = fix === null ? '' : fix ? 'yes' : 'no';
    }
  }
  if (state.latestT === null) {
    el.readingsAge.textContent = 'No readings yet';
    el.readingsAge.dataset.stale = '';
  } else {
    el.readingsAge.textContent = `Updated ${ago(state.latestT, now).toLowerCase()}`;
    el.readingsAge.dataset.stale = now - state.latestT > STALE_MS ? 'yes' : '';
  }
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

// One entry per graph: its canvas, its series and how to show a value.
const CHARTS = [
  { id: 'alt', name: 'Altitude', series: [{ key: 'alt', name: 'Altitude' }], minSpan: 10, floorZero: false, digits: 1 },
  { id: 'sats', name: 'Satellites in use', series: [{ key: 'sats', name: 'Satellites' }], minSpan: 4, integer: true, digits: 0 },
  { id: 'hdop', name: 'HDOP', series: [{ key: 'hdop', name: 'HDOP' }], minSpan: 2, digits: 2 },
  { id: 'radio', name: 'Radio packets', series: [{ key: 'radioSent', name: 'Sent' }, { key: 'radioErrors', name: 'Errors' }], minSpan: 4, integer: true, digits: 0 },
];

function chartValue(key, p, digits) {
  if (!p) return 'No data';
  const unit = state.units[key] && key === 'alt' ? ` ${state.units[key]}` : '';
  return p.v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + unit;
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
    c.when.textContent = hovering ? `At ${formatClock(state.hoverT)}` : 'Latest';
    c.when.hidden = !hovering && c.def.series.every((s) => !lastPoint(state.series[s.key]));
    c.canvas.setAttribute('aria-label', `${c.def.name} graph, last 10 minutes. ${hovering ? `At ${formatClock(state.hoverT)},` : 'Latest'} ${summary.join(', ')}.`);
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
    const fix = readFix(state.latest.fix);
    el.trackInfo.textContent = fix === false ? 'Waiting for a GPS fix. The trace starts at the first one.' : 'The trace starts at the first GPS fix.';
    el.trackLink.hidden = true;
    el.trackCanvas.setAttribute('aria-label', 'Position trace, no position yet.');
    return;
  }
  const last = pts[pts.length - 1];
  const size = `${ext.eastWest.toFixed(1)} m east to west by ${ext.northSouth.toFixed(1)} m north to south`;
  const latest = lat && lon ? `${lat.raw}, ${lon.raw}` : `${last.lat}, ${last.lon}`;
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
    el.announce.textContent = `${parts.join(', ')}, at ${formatClock(next)}.`;
  }
}

// ------------------------------------------------------------------
// Save as CSV
// ------------------------------------------------------------------

function saveCsv() {
  if (!state.records.length) return;
  const blob = new Blob([buildCsv(state.records, state.units)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------

function start() {
  theme = readTheme();
  const colors = { alt: theme.gold, sats: theme.gold, hdop: theme.gold, radioSent: theme.sent, radioErrors: theme.err };

  charts = CHARTS.map((def) => {
    const panel = document.querySelector(`[data-chart="${def.id}"]`);
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
  track = new TrackPlot(el.trackCanvas, { theme });

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', onSerialDisconnect);
  } else {
    el.unsupported.hidden = false;
  }
  setLink('idle');

  el.connect.addEventListener('click', connect);
  el.disconnect.addEventListener('click', disconnect);
  el.save.addEventListener('click', saveCsv);
  el.errorsClear.addEventListener('click', () => {
    state.errors = [];
    state.errorTotal = 0;
    state.errorsDirty = true;
    scheduleRender();
  });
  el.raw.addEventListener('toggle', () => el.raw.open && renderRaw());

  // Redraw when the panels change size, when the fonts arrive, and every
  // second for the "ago" times and the sliding graph window.
  const resize = new ResizeObserver(() => scheduleRender());
  for (const c of charts) resize.observe(c.canvas);
  resize.observe(el.trackCanvas);
  document.fonts?.ready.then(() => scheduleRender());
  setInterval(render, 1000);
  render();
}

start();
