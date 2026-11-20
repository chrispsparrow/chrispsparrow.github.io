// launch-log-browser.mjs: the browser checks for launch mode's flight log
// and test capture (js/launch/flight-log.js and js/launch/capture.js), in a
// real headless Chrome with the internet blocked. It uses the launch mode
// test rig (launch-mode/test/cdp.mjs) and the local server on a test port.
// It is not a node --test file (Chrome takes a few minutes), so run it by
// hand from the website folder:
//
//   node flight-console/test/launch-log-browser.mjs
//   node flight-console/test/launch-log-browser.mjs --port 8105 --out C:/some/folder capture close
//
// The checks (all of them when none is named):
//   capture   the capture at 20x through the live path: every line reaches
//             the flight store, the server copy on disk, a file from the
//             browser's private file system (useFileHandle) and IndexedDB
//   close     closing the tab in the middle of a capture, then RECOVER
//   kill      killing Chrome in the middle of a capture, then RECOVER
//   restore   a real connection (a stand-in port), Chrome killed, RECOVER:
//             the flight is back on the live view and CONNECT carries it on
//   load      the server copy and a recording's raw log export load back
//             with LOAD FILE and replay
//   realtime  speed 1 for 32 s: a status line and a packet each second, and
//             the disk file keeps up
//   tarpit    the capture with the internet up but dead
//   connect   CONNECT on the launch page: the save box, a granted port, a
//             cancelled save box, a lost port and a reconnect
//   reconnect a lost port: unplug, replug, and the lines carry on in all
//             three copies with nothing clicked. An open that fails is
//             tried again, the page finds the port without the "connect"
//             event too, DISCONNECT stops the trying (also in the instant
//             the port opens), another board's port is never opened in
//             the receiver's place, and a fresh page never opens a port by
//             itself
//   silent    a connected port that says nothing: the wrong port warning
//             (not before 8 s), CONNECT after DISCONNECT shows the port
//             list, the stuck receiver warning (not before 12 s), and what
//             to do about a radio that failed
//   receiver  the receiver's newer firmware, which prints a start-up
//             report, a Dogtooth board's status block for each packet and
//             plain "Error: " lines: a receiver that waits for the rocket
//             at its real rhythm (a line about every 5 s) never gets a
//             warning and is never NOT RECOGNIZED, the page says it was
//             found and is listening, a radio that did not start says what
//             to do next, the blocks reach every copy, and the test capture
//             refuses to play over them
//   server    the local server stopped: the warning under the bar at two
//             window sizes and with the panel scrolled, the other copies
//             keep saving, and the server copy catches up when it is back
//   tabs      a second launch tab: its note, no save box and no file, and
//             it works once the first tab is closed
//   files     a file picked before the port opened waits for the flight
//             (a test capture does not take it), CHOOSE FILE after a test
//             picks the flight's file, and the save box never suggests the
//             same name twice
//   recover   RECOVER after CONNECT: back on the live view while the port
//             is open with no packets yet, and a plain reason when the
//             live view already has data
//   clock     the computer's clock set back an hour in the middle of a
//             capture: every copy keeps up
//   normal    the normal page (index.html): no log, no capture, no save box,
//             the recorder's 2 s chunks, LOAD FILE of a flight log, and
//             none of the launch page's warnings, locks or reconnecting
//
// THE STAND-IN PORT. Headless Chrome has no serial ports and can't show a
// save box, so the checks that need them put a stand-in for
// navigator.serial and showSaveFilePicker in the page before its code
// runs. The page's own serial-link.js reads the stand-in's stream exactly
// as it reads a real port. The stand-in asks for a click the way Chrome
// does (navigator.userActivation), so the CONNECT flow is tested honestly.
// It can be unplugged and plugged back in (see FAKE below).
//
// The server check stops and starts a server, so it uses one of its own on
// the next port up (--server-port to pick another). It is never port 8000.
//
// It prints one line per check with the real numbers, and ends with exit
// code 1 if any failed. The files it made in flight-logs/ are deleted at
// the end, and the pictures are left in --out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchChrome, sleep, ROOT } from '../../launch-mode/test/cdp.mjs';
import { planCapture } from '../js/launch/capture-plan.js';

const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  if (i < 0) return fallback;
  const value = ARGS[i + 1];
  ARGS.splice(i, 2);
  return value;
};
const PORT = Number(opt('--port', '8105'));
const SERVER_PORT = Number(opt('--server-port', String(PORT + 1)));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'fc-launch-log')));
const ALL = ['capture', 'close', 'kill', 'restore', 'load', 'realtime', 'tarpit', 'connect', 'reconnect', 'silent', 'receiver', 'server', 'tabs', 'files', 'recover', 'clock', 'normal'];
const WANT = ARGS.length ? ARGS : ALL;
if (PORT === 8000 || SERVER_PORT === 8000) throw new Error('Port 8000 is the real server. Use a test port.');
fs.mkdirSync(OUT, { recursive: true });

const LOGS = path.join(ROOT, 'flight-logs');
const CAPTURE = fs.readFileSync(path.join(ROOT, 'flight-console/test/radio-board-rx-capture.log'), 'utf8');
const CAPTURE_LINES = CAPTURE.split(/\r?\n/).filter((l) => l !== '');
const FIELD = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch-mode/field.json'), 'utf8')).center;
const SHIFTED = planCapture(CAPTURE, { target: FIELD }).lines;
const PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}) > /;

const results = [];
const made = new Set();          // flight-logs/ files this run made
const logsBefore = new Set(fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []);
const profiles = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// What the page puts in front of its own code for the stand-in port and
// save box. window.__fake holds the counts the checks read, and:
//   __fake.port        the port that is plugged in now (send(text) on it
//                      hands the page bytes, as the receiver would)
//   __fake.unplug()    the cable comes out: the open stream fails the way
//                      Chrome's does, the port leaves getPorts(), and
//                      "disconnect" fires
//   __fake.replug()    plugged back in. As in Chrome, that is a NEW port
//                      object with the same USB ids, and "connect" fires.
//                      replug({ event: false }) leaves the event out, so
//                      only the page's own look at getPorts() can find it.
//   __fake.openFails   the next that many open() calls fail, like a port
//                      Windows is not ready to open yet
//   __fake.signalDelayMs   how long a port that just opened takes to be
//                      ready (its setSignals), so a check can press a
//                      button in that moment
//   __fake.otherPlugged   true puts a second port the page may open in
//                      getPorts(): some other board, with other USB ids.
//                      __fake.otherTries counts the opens tried on it.
//   __fake.noIds       true makes the receiver's port report no USB ids,
//                      like a port that is not a USB board
// A page starts with no port it may open, as on a first visit, unless
// localStorage has __fakeGranted set to "1" (a port from an earlier visit).
const FAKE = `(() => {
  const enc = new TextEncoder();
  const fake = window.__fake = {
    requestCalls: 0, pickerCalls: 0, pickerMode: 'opfs', pickerDelayMs: 0, pickerOpts: null, names: [],
    granted: false, plugged: true, opens: 0, openTries: 0, openFails: 0, made: 0,
    closes: 0, signalDelayMs: 0, otherPlugged: false, otherTries: 0, noIds: false,
  };
  try { fake.granted = localStorage.getItem('__fakeGranted') === '1'; } catch (err) { /* storage is off */ }
  const heard = { connect: new Set(), disconnect: new Set() };
  const tell = (type, port) => {
    for (const fn of [...heard[type]]) {
      try { fn({ type, target: port, port }); } catch (err) { console.error(err); }
    }
  };
  function makePort() {
    fake.made += 1;
    const port = {
      n: fake.made,
      gone: false,
      readable: null,
      controller: null,
      async open() {
        fake.openTries += 1;
        if (port.gone || !fake.plugged) throw new DOMException('Failed to open serial port.', 'NetworkError');
        if (fake.openFails > 0) {
          fake.openFails -= 1;
          throw new DOMException('Failed to open serial port.', 'NetworkError');
        }
        fake.opens += 1;
        port.readable = new ReadableStream({ start(c) { port.controller = c; } });
      },
      async setSignals() { if (fake.signalDelayMs) await new Promise((r) => setTimeout(r, fake.signalDelayMs)); },
      async close() { fake.closes += 1; port.readable = null; },
      getInfo() { return fake.noIds ? {} : { usbVendorId: 0x239a, usbProductId: 0x800b }; },
      send(text) { port.controller.enqueue(enc.encode(text)); },
      unplug() { fake.unplug(); },
    };
    return port;
  }
  fake.port = makePort();
  // Some other board the browser was given leave to open on an earlier day.
  const other = {
    readable: null,
    async open() { fake.otherTries += 1; other.readable = new ReadableStream({ start() {} }); },
    async setSignals() {},
    async close() { other.readable = null; },
    getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x0043 }; },
  };
  // Not listed when a check copies the counts out of the page.
  Object.defineProperty(fake, 'unplug', { enumerable: false, value: () => {
    const port = fake.port;
    fake.plugged = false;
    port.gone = true;
    const c = port.controller;
    port.readable = null;
    port.controller = null;
    if (c) c.error(new DOMException('The device has been lost.', 'NetworkError'));
    tell('disconnect', port);
  } });
  Object.defineProperty(fake, 'replug', { enumerable: false, value: ({ event = true } = {}) => {
    fake.port = makePort();
    fake.plugged = true;
    if (event) tell('connect', fake.port);
  } });
  const serial = {
    async requestPort() {
      fake.requestCalls += 1;
      if (!navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      fake.granted = true;
      return fake.port;
    },
    async getPorts() {
      if (!fake.granted) return [];
      return [...(fake.plugged ? [fake.port] : []), ...(fake.otherPlugged ? [other] : [])];
    },
    addEventListener(type, fn) { if (heard[type]) heard[type].add(fn); },
    removeEventListener(type, fn) { if (heard[type]) heard[type].delete(fn); },
  };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  window.showSaveFilePicker = async (opts) => {
    fake.pickerCalls += 1;
    fake.pickerOpts = opts;
    fake.names.push(opts.suggestedName);
    if (fake.pickerDelayMs) await new Promise((r) => setTimeout(r, fake.pickerDelayMs));
    if (fake.pickerMode === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
    const dir = await navigator.storage.getDirectory();
    fake.pickedName = 'picked-' + Math.random().toString(36).slice(2, 8) + '-' + opts.suggestedName;
    return dir.getFileHandle(fake.pickedName, { create: true });
  };
})();`;

// A flight log's text checked against the receiver lines it should hold.
function compareLog(text, expected) {
  const problems = [];
  const lines = text.split('\n');
  if (lines.at(-1) !== '') problems.push('the file does not end with a line feed');
  lines.pop();
  if (lines[0] !== '# Dogtooth flight log') problems.push(`first line is ${JSON.stringify(lines[0])}`);
  if (!/^# started /.test(lines[1] ?? '')) problems.push('no "# started" line');
  if (!/^# written by the Flight Console launch page$/.test(lines[2] ?? '')) problems.push('no "# written by" line');
  if (!/^# each line: /.test(lines[3] ?? '')) problems.push('no "# each line" line');
  const data = [];
  let lastT = -Infinity;
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    const m = PREFIX.exec(line);
    if (!m) { problems.push(`a line with no time: ${line.slice(0, 60)}`); continue; }
    const t = Date.parse(m[1]);
    if (!(t >= lastT)) problems.push(`time goes back at ${m[1]}`);
    lastT = t;
    data.push(line.slice(m[0].length));
  }
  if (data.length !== expected.length) problems.push(`${data.length} receiver lines, expected ${expected.length}`);
  const firstDiff = data.findIndex((l, i) => l !== expected[i]);
  if (firstDiff >= 0) problems.push(`line ${firstDiff + 1} differs: ${data[firstDiff]?.slice(0, 50)}`);
  return { ok: !problems.length, problems, data };
}

const readServerLog = (name) => fs.readFileSync(path.join(LOGS, name), 'utf8');
const noteFiles = (status) => { for (const l of status?.logs ?? []) if (l.server) made.add(l.server); };

async function openPage(browser, server, url, { fake = false } = {}) {
  const page = await browser.newPage();
  if (fake) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE });
  await page.goto(server.url(url));
  await page.waitFor(() => window.fcStarted === true, { timeout: 30000, message: 'the console did not start' });
  if (url.includes('launch.html')) {
    await page.waitFor(() => window.fcLaunch?.parts?.log && window.fcLaunch?.parts?.capture, { timeout: 30000, message: 'launch mode\'s log and capture did not start' });
  }
  return page;
}

const logStatus = (page) => page.evaluate(() => window.fcLaunch.parts.log.status());
const capStatus = (page) => page.evaluate(() => window.fcLaunch.parts.capture.status());

// Waits until every copy of the shown log has every line.
async function settled(page, { browserLines = null, timeout = 20000 } = {}) {
  await page.waitFor((want) => {
    const s = window.fcLaunch.parts.log.status();
    const fileOk = s.file.state !== 'saving' || s.file.pending === 0;
    const serverOk = s.server.state === 'none' || s.server.pending === 0;
    const browserOk = want === null || s.browser.lines === want;
    return fileOk && serverOk && browserOk;
  }, { timeout, args: [browserLines], message: 'the copies did not catch up' });
  return logStatus(page);
}

// The OPFS file the tests give the log.
async function giveOpfsFile(page, name) {
  return page.evaluate(async (fileName) => {
    const dir = await navigator.storage.getDirectory();
    try { await dir.removeEntry(fileName); } catch { /* not there */ }
    const handle = await dir.getFileHandle(fileName, { create: true });
    window.__opfs = handle;
    return window.fcLaunch.parts.log.useFileHandle(handle);
  }, name);
}
const readOpfs = (page, name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  return (await (await dir.getFileHandle(fileName)).getFile()).text();
}, name);

// The page's saved LOCAL flights, newest first, with their line counts.
const savedFlights = (page) => page.evaluate(async () => {
  const db = window.fcLaunch?.ctx?.localConsole?.test?.db;
  const all = (await db.listFlights()).filter((r) => r.status === 'saved').sort((a, b) => b.createdAt - a.createdAt);
  const out = [];
  for (const r of all) {
    const data = await db.readLines(r.id);
    out.push({ id: r.id, title: r.title, test: Boolean(r.test), source: r.source, sampleCount: r.sampleCount, lines: data.lines, times: data.times?.length ?? 0, originalName: r.originalName });
  }
  return out;
});

// Clicks RECOVER and then SAVE in the name box. Returns the recover line's text.
async function recover(page, shot) {
  await page.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed' });
  const text = await page.evaluate(() => document.getElementById('fc-recover').textContent.replace(/\s+/g, ' ').trim());
  if (shot) await page.screenshot(shot);
  await page.click('#fc-recover-actions button');
  await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not open' });
  const name = await page.evaluate(() => document.getElementById('fc-name-input').value);
  await page.click('dialog.fc-dialog button[type="submit"]');
  await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
  return { text, name };
}

// A recording that stops opens the name box. SAVE it and wait until it closes.
async function saveNameBox(page) {
  await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not open' });
  await page.click('dialog.fc-dialog button[type="submit"]');
  await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
}

// Waits until the browser copy has stored at least n of the capture's
// lines, and returns how many it has stored. The page goes away a moment
// later, and it sends and stores more lines until then (two a second, and
// on a busy laptop that moment can be a few seconds). So the checks can't
// know the exact count. They ask for at least this many lines back, at
// most SLACK more, and all of them the capture's own lines in order.
async function midCapture(page, n) {
  return page.waitFor((want) => {
    const s = window.fcLaunch.parts.capture.status();
    const stored = window.fcLaunch.parts.log.status().browser.lines;
    return s.playing && stored >= want ? stored : false;
  }, { timeout: 90000, interval: 20, args: [n], message: 'the capture never got that far' });
}
const SLACK = 20;

// The page's own timings: it warns about a port that has said nothing at
// all 8 s after it opened and about a receiver that stopped after 12 s
// (NO_DATA_MS and SILENT_MS in flight-log.js), looks for a lost port every
// 2 s, and asks a stopped server again every second. On a quiet laptop each
// of those shows within a second or two of its time. The checks allow
// BUSY_MS on top, because other tests may be running on this laptop at the
// same moment. Each check prints the time it really took.
const NO_DATA_WARN_MS = 8000;
const SILENT_WARN_MS = 12000;
const BUSY_MS = 10000;

// What the receiver's newer firmware prints (DEKEL_RX_FIRMWARE, the build
// of 2026-11-17). RX_START is the start-up report the real board sent the
// launch page on 2026-11-19, and RX_GAPS_MS are the times between its lines
// that night: the report, the first waiting line 3.5 s later, then one
// about every 5 s. One of the real gaps was 5.563 s, which a 5 s limit
// took for a stuck receiver. The last gap here is longer than any that was
// seen, a line a second and a half late.
const RX_START = [
  '',
  'DEKEL_RX_FIRMWARE receiver for Dogtooth telemetry, RadioB_V1_Dekel (ATSAMD51J19A + SX1262)',
  'Built Nov 17 2026 01:16:36',
  'Radio: 909.000 MHz, BW 125.0 kHz, SF9, CR 4/7, sync 0x12, preamble 8, CRC on, explicit header, listening (receive only)',
];
const RX_GAPS_MS = [3528, 4997, 4997, 4996, 4997, 4995, 5563, 4997, 6500];
const RX_RADIO_DEAD = 'Error: The radio did not start (RadioLib error -2: chip not found: check SPI wiring, 3.3 V, NRST and BUSY).';
const RX_FOUND = 'Radio board receiver found. It is listening, and no packets from the rocket have come in yet.';
const RX_DEAD_NOTE = 'Radio board receiver is connected, but its radio didn\'t start (error -2). It can\'t hear the rocket until that is fixed. Unplug the receiver and plug it back in. If it says the same again, its radio is not working, so switch to the spare receiver or check its antenna and wiring.';
// One status block, as the receiver prints it for a good packet (the
// firmware's README, "What it prints"). The rocket sends one packet a
// second, so packet n has been running n seconds: #807 says 13 min 27.0 s.
const rxBlock = (n, lat, lon, alt) => [
  `==================== HEARTBEAT #${n} | TIME RUNNING: ${Math.floor(n / 60)} min ${(n % 60).toFixed(1)} s ====================`,
  '',
  'GPS',
  '  TARGET LOCK [GPS]: ------------------ LOCKED',
  '  CONNECTED SATELLITES: --------------- 12',
  '  LOCK QUALITY: ----------------------- 100 % (HDOP 0.84)',
  `  LATITUDE: --------------------------- ${lat.toFixed(7)}`,
  `  LONGITUDE: -------------------------- ${lon.toFixed(7)}`,
  `  ALTITUDE: --------------------------- ${alt.toFixed(1)} m`,
  '',
  'GPS MOTION MODEL',
  '  PORTABLE: --------------------------- OFF',
  '  AUTOMOTIVE: ------------------------- OFF',
  '  AIRBORNE 4G: ------------------------ ON',
  '  OTHER: ------------------------------ OFF',
  '',
  'RADIO',
  `  RADIO PACKETS SENT: ----------------- ${n}`,
  '  RADIO PACKETS SKIPPED: -------------- 0',
  '  RADIO PACKET ERROR OCCURRENCES: ----- 0',
  '  SIGNAL STRENGTH (RSSI): ------------- -79.0 dBm',
  '  SIGNAL TO NOISE (SNR): -------------- 10.75 dB',
  '',
];

// A line under the bar as a person sees it: its tag and words, whether it
// shows, and whether all of it is inside the window with nothing over it.
const barLine = (page, id) => page.evaluate((elId) => {
  const el = document.getElementById(elId);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const shown = !el.hidden && r.width > 0 && r.height > 0;
  const inside = shown && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  const hit = inside ? document.elementFromPoint(r.left + 40, r.top + r.height / 2) : null;
  return {
    shown,
    onScreen: inside && Boolean(hit) && el.contains(hit),
    kind: el.dataset.kind ?? null,
    tag: el.querySelector('.fc-status-tag')?.textContent ?? '',
    text: el.querySelector('.fc-status-text span:last-child')?.textContent ?? '',
    box: `${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${window.innerWidth} by ${window.innerHeight}`,
  };
}, id);

// Words a person reads at the field follow the site's writing rules: no
// dashes, no semicolons, no "&", no colon phrases.
const said = [];
const plain = (text) => !/[—–;&]/.test(text) && !/: /.test(text);

// Sends receiver lines through the stand-in port, a few at a time.
async function sendLines(page, lines, { each = 10, gapMs = 150 } = {}) {
  for (let i = 0; i < lines.length; i += each) {
    await page.evaluate((part) => { for (const l of part) window.__fake.port.send(`${l}\r\n`); }, lines.slice(i, i + each));
    await sleep(gapMs);
  }
}

const fakeCounts = (page) => page.evaluate(() => ({ ...window.__fake, port: undefined, pickerOpts: undefined }));
const linkOpen = (page) => page.evaluate(() => window.fcLaunch.ctx.live.link.open);

// CONNECT on a fresh launch page with the stand-in port: the save box, the
// port list, and the port open.
async function connectFresh(page) {
  await page.click('#bc-connect');
  await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open' });
}

// ------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------
const server = await startServer({ port: PORT });
const blockedTimes = {};
let fullServerLog = null;        // the capture check's server copy (for load)

// The capture check's server copy as a file to give LOAD FILE. Another test
// run on this laptop can clear the file out of flight-logs/ in the
// meantime (two runs whose pages start a log in the same second ask for the
// same name). The bytes were read when the capture ended, so when the file
// is gone they are written out again in --out, under the same name.
function serverCopyFile() {
  const real = path.join(LOGS, fullServerLog.name);
  if (fs.existsSync(real)) return real;
  const copy = path.join(OUT, fullServerLog.name);
  fs.writeFileSync(copy, fullServerLog.text);
  console.log(`note: flight-logs/${fullServerLog.name} was gone, so LOAD FILE gets the same bytes from ${copy}`);
  return copy;
}
const restoredForLoad = [];      // { id, lines } restored recordings to load back

async function runCapture(network) {
  const browser = await launchChrome({ network });
  try {
    const began = Date.now();
    const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=20&shift=field');
    const up = Date.now() - began;
    await page.waitFor(() => window.fcLaunch.parts.capture.status().playing, { timeout: 30000, message: 'the capture never started' });
    const playing = Date.now() - began;
    noteFiles(await logStatus(page));
    const given = await giveOpfsFile(page, 'opfs-capture-check.log');
    await sleep(1500);
    await page.screenshot(path.join(OUT, `capture-${network}-playing.png`));
    const ended = await page.waitFor(() => window.fcLaunch.parts.capture.status().last, { timeout: 60000, message: 'the capture never ended' });
    const done = Date.now() - began;
    const status = await settled(page, { browserLines: 253 });
    noteFiles(status);
    await sleep(800);
    await page.screenshot(path.join(OUT, `capture-${network}-ended.png`));
    const feed = await page.evaluate(() => {
      const live = window.fcLaunch.ctx.live;
      const rocket = live.stores.flight.getRocket('1');
      return { counts: live.flightFeed.counts, samples: rocket?.samples.length ?? 0, first: rocket?.samples[0]?.gps ?? null, mode: live.mode };
    });
    return { browser, page, status, ended, feed, given, timing: { up, playing, done } };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

try {
  if (WANT.includes('capture')) {
    const run = await runCapture('blocked');
    const { page, status, ended, feed, timing } = run;
    blockedTimes.capture = timing;
    try {
      check('capture: played every line', ended.reason === 'ended' && ended.sent === 253, `sent ${ended.sent} of ${ended.total}, reason ${ended.reason}, ${timing.done - timing.playing} ms from start to end at 20x`);
      check('capture: every packet reached the flight store', feed.counts.samples === 126 && feed.samples === 126 && feed.counts.bad === 0,
        `feed ${JSON.stringify(feed.counts)}, rocket 1 has ${feed.samples} samples, live mode ${feed.mode}`);
      check('capture: the first fix is on the field', Math.abs(feed.first.lat - FIELD.lat) < 1e-6 && Math.abs(feed.first.lon - FIELD.lon) < 1e-6,
        `first fix ${feed.first.lat}, ${feed.first.lon}, field ${FIELD.lat}, ${FIELD.lon}`);
      const serverText = readServerLog(status.server.name);
      fullServerLog = { name: status.server.name, text: serverText };
      const cmp = compareLog(serverText, SHIFTED);
      check('capture: the server copy has every line in order with valid times', cmp.ok && /^test-capture-\d{4}-\d{2}-\d{2}-\d{6}-page\.log$/.test(status.server.name),
        `flight-logs/${status.server.name}: ${cmp.data.length} receiver lines${cmp.problems.length ? `, problems: ${cmp.problems.join('; ')}` : ', all 253 the same as the capture (moved), times never go back'}`);
      check('capture: the header says it is a test and how it was moved', /# test capture, not live data: test\/radio-board-rx-capture\.log, played at 20 times real speed\n# every lat= and lon= in its PKT lines was moved by \+9\.7018213 and \+43\.9517297 degrees/.test(serverText),
        serverText.split('\n').slice(4, 6).join(' | '));
      const opfs = await readOpfs(page, 'opfs-capture-check.log');
      // useFileHandle answers true once the file has every line the log held
      // when it was given, although lines keep arriving while the capture plays.
      check('capture: a private file system file given through useFileHandle gets the same lines', opfs === serverText && run.given === true,
        `${opfs.length} bytes, ${opfs === serverText ? 'byte for byte the same as the server copy' : 'DIFFERENT from the server copy'}; status file ${JSON.stringify({ state: status.file.state, lines: status.file.lines, pending: status.file.pending })}; useFileHandle answered ${run.given} while the capture was playing`);
      const saved = await savedFlights(page);
      const test = saved.find((r) => r.test);
      const same = test && test.lines.length === 253 && test.lines.every((l, i) => l === SHIFTED[i]);
      check('capture: IndexedDB has every line', same && test.times === 253,
        test ? `"${test.title}" has ${test.lines.length} lines (${same ? 'all the same as the capture' : 'NOT the same'}), ${test.times} arrival times, browser status ${JSON.stringify(status.browser)}` : 'no test recording was saved');
      const external = page.externalRequests();
      const hosts = [...new Set(external.map((r) => new URL(r.url).host))];
      const mine = page.requests().filter((r) => /\/launch-mode\/(ping|log\/append)/.test(r.url));
      check('capture: the log only talked to this laptop', mine.every((r) => new URL(r.url).hostname === 'localhost'),
        `${mine.length} requests to /launch-mode/ (all localhost). Other pages' parts asked the internet for: ${hosts.join(', ') || 'nothing'}`);
      check('capture: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions, console errors: ${page.consoleErrors().map((m) => m.text.slice(0, 80)).join(' | ') || 'none'}`);
    } finally {
      await run.browser.close();
    }
  }

  if (WANT.includes('close') || WANT.includes('kill')) {
    const profile = path.join(OUT, `profile-c-${process.pid}`);
    profiles.push(profile);
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      if (WANT.includes('close')) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
        await page.waitFor(() => window.fcLaunch.parts.log.status().logs.length, { timeout: 30000 });
        noteFiles(await logStatus(page));
        const sent = await midCapture(page, 40);
        const before = await logStatus(page);
        noteFiles(before);
        await page.close();
        const page2 = await openPage(browser, server, '/flight-console/launch.html?track');
        const { text } = await recover(page2, path.join(OUT, 'close-recover-offer.png'));
        await sleep(500);
        const saved = await savedFlights(page2);
        const back = saved.find((r) => r.test);
        const n = back?.lines.length ?? 0;
        const same = back && back.lines.every((l, i) => l === SHIFTED[i]);
        const serverN = compareLog(readServerLog(before.server.name), SHIFTED.slice(0, n)).data.length;
        check('close: closing the tab mid-capture, then RECOVER, brings every line back', back && same && n >= sent && n <= sent + SLACK,
          `${sent} lines were stored when the tab was told to close, ${n} came back from IndexedDB (${same ? 'all the capture\'s own lines in order' : 'NOT the same'}), "${back?.title}". The server copy has ${serverN}. Offer said: ${text}`);
        if (back) restoredForLoad.push({ id: back.id, lines: n, what: 'closed tab' });
        await page2.screenshot(path.join(OUT, 'close-recovered.png'));
        await page2.close();
      }
      if (WANT.includes('kill')) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
        await page.waitFor(() => window.fcLaunch.parts.log.status().logs.length, { timeout: 30000 });
        noteFiles(await logStatus(page));
        const sent = await midCapture(page, 30);
        const before = await logStatus(page);
        noteFiles(before);
        await browser.kill();
        browser = await launchChrome({ network: 'blocked', userDataDir: profile });
        const page2 = await openPage(browser, server, '/flight-console/launch.html?track');
        const { text } = await recover(page2, path.join(OUT, 'kill-recover-offer.png'));
        await sleep(500);
        const saved = await savedFlights(page2);
        const back = saved.find((r) => r.test && r.lines.length < 200 && !restoredForLoad.some((x) => x.id === r.id));
        const n = back?.lines.length ?? 0;
        const same = back && back.lines.every((l, i) => l === SHIFTED[i]);
        const serverN = compareLog(readServerLog(before.server.name), SHIFTED.slice(0, n)).data.length;
        check('kill: killing Chrome mid-capture, then RECOVER, brings every line back', back && same && n >= sent && n <= sent + SLACK,
          `${sent} lines were stored when Chrome was killed, ${n} came back from IndexedDB (${same ? 'all the capture\'s own lines in order' : 'NOT the same'}). The server copy has ${serverN}. Offer said: ${text}`);
        if (back) restoredForLoad.push({ id: back.id, lines: n, what: 'killed Chrome' });
        await page2.close();
      }
      if (WANT.includes('load') && restoredForLoad.length) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track');
        for (const r of restoredForLoad) {
          const out = await page.evaluate(async (id) => {
            const lc = window.fcLaunch.ctx.localConsole;
            const mod = await import('/flight-console/js/local/local-flights.js');
            const record = await lc.test.db.getFlight(id);
            const data = await lc.readLines(id);
            const text = mod.rawLogText(record, data.lines);
            const name = mod.exportFileName(record, 'log');
            await lc.test.loadFile(new File([text], name));
            const all = await lc.test.db.listFlights();
            const loaded = all.filter((x) => x.source === 'file' && x.originalName === name).sort((a, b) => b.createdAt - a.createdAt)[0];
            const flight = await (await lc.find(loaded.id)).load();
            return { name, sampleCount: loaded.sampleCount, replaySamples: flight.samples.length, packets: data.lines.filter((l) => l.startsWith('PKT ')).length };
          }, r.id);
          check(`load: the raw log export of the recording recovered after a ${r.what} replays`, out.replaySamples === out.packets && out.sampleCount === out.packets,
            `${out.name}: ${r.lines} lines, ${out.packets} packets, loaded with ${out.sampleCount} samples, the replay has ${out.replaySamples}`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('restore')) {
    const profile = path.join(OUT, `profile-r-${process.pid}`);
    profiles.push(profile);
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open' });
      const first = CAPTURE_LINES.slice(0, 60);
      for (let i = 0; i < first.length; i += 10) {
        await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, first.slice(i, i + 10));
        await sleep(300);
      }
      await page.waitFor(() => window.fcLaunch.parts.log.status().browser.lines === 60, { timeout: 10000, message: 'the browser copy did not reach 60 lines' });
      const before = await logStatus(page);
      noteFiles(before);
      await browser.kill();
      browser = await launchChrome({ network: 'blocked', userDataDir: profile });
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await recover(page2, path.join(OUT, 'restore-offer.png'));
      await page2.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 15000, message: 'the recording did not go back on the live view' });
      await sleep(1200);
      await page2.screenshot(path.join(OUT, 'restore-back-on-screen.png'));
      const back = await page2.evaluate(() => {
        const live = window.fcLaunch.ctx.live;
        const rocket = live.stores.flight.getRocket('1');
        return {
          restored: window.fcLaunch.parts.log.status().restored,
          samples: rocket?.samples.length ?? 0,
          fix: window.fcLaunch.parts.panel?.status?.().fix ?? null,
          liveData: window.fcLaunch.parts.log.liveData(),
          logLines: window.fcLaunch.parts.log.status().lines,
        };
      });
      check('restore: a recovered flight is back on the live view, without being logged again', back.samples === 30 && back.restored?.lines === 60 && back.logLines === 0,
        `60 lines recorded before the kill, ${back.restored?.lines} played back, rocket 1 has ${back.samples} samples, the panel's fix is ${back.fix ? `${back.fix.lat}, ${back.fix.lon} (${back.fix.source})` : 'missing'}, the new log has ${back.logLines} lines`);
      // CONNECT carries the same flight on.
      await page2.click('#bc-connect');
      await page2.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open again' });
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(60, 80));
      await page2.waitFor(() => window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples.length === 40, { timeout: 10000, message: 'the new packets did not join the flight' });
      const carried = await page2.evaluate(() => {
        const live = window.fcLaunch.ctx.live;
        const s = live.stores.flight.getRocket('1').samples;
        return { n: s.length, seqs: s.map((x) => x.extra.seq), restarts: live.flightFeed.counts.restarts };
      });
      const continuous = carried.seqs.every((q, i) => i === 0 || q === carried.seqs[i - 1] + 1);
      check('restore: CONNECT carries the same flight on', carried.n === 40 && continuous && carried.restarts === 0,
        `rocket 1 has ${carried.n} samples, sequence ${carried.seqs[0]} to ${carried.seqs.at(-1)} with ${continuous ? 'no gap' : 'a GAP'}, ${carried.restarts} restarts`);
      noteFiles(await logStatus(page2));
      if (WANT.includes('load')) {
        const saved = (await savedFlights(page2)).find((r) => !r.test && r.source === 'recording');
        if (saved) restoredForLoad.push({ id: saved.id, lines: saved.lines.length, what: 'real connection and a killed Chrome' });
        const out = await page2.evaluate(async (id) => {
          const lc = window.fcLaunch.ctx.localConsole;
          const mod = await import('/flight-console/js/local/local-flights.js');
          const record = await lc.test.db.getFlight(id);
          const data = await lc.readLines(id);
          const text = mod.rawLogText(record, data.lines);
          await lc.test.loadFile(new File([text], 'restored-export.log'));
          const loaded = (await lc.test.db.listFlights()).filter((x) => x.originalName === 'restored-export.log')[0];
          return { sampleCount: loaded?.sampleCount, lines: data.lines.length };
        }, saved?.id);
        check('load: the raw log export of the recovered real recording replays', out.sampleCount === 30, `${out.lines} lines exported, loaded with ${out.sampleCount} samples (30 packets)`);
      }
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('load') && fullServerLog) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track');
      await page.setFiles('input.fc-file-input', [serverCopyFile()]);
      await page.waitFor((name) => /Loaded /.test(document.getElementById('fc-file-text')?.textContent ?? '') && location.search.includes('flight=local-'), { timeout: 20000, args: [fullServerLog.name], message: 'LOAD FILE did not load the server copy' });
      const out = await page.evaluate(async (name) => {
        const lc = window.fcLaunch.ctx.localConsole;
        const loaded = (await lc.test.db.listFlights()).find((x) => x.originalName === name);
        const flight = await (await lc.find(loaded.id)).load();
        return { sampleCount: loaded.sampleCount, replay: flight.samples.length, first: flight.samples[0]?.gps, durationS: loaded.durationS };
      }, fullServerLog.name);
      await sleep(3000);
      await page.screenshot(path.join(OUT, 'load-server-copy.png'));
      check('load: the server copy loads with LOAD FILE and replays like the capture', out.sampleCount === 126 && out.replay === 126,
        `${fullServerLog.name}: ${out.sampleCount} samples, the replay has ${out.replay}, ${out.durationS} s of data, first fix ${out.first?.lat}, ${out.first?.lon}`);
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('realtime')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
      await page.waitFor(() => window.fcLaunch.parts.capture.status().playing, { timeout: 30000, message: 'the capture never started' });
      noteFiles(await logStatus(page));
      await giveOpfsFile(page, 'opfs-realtime-check.log');
      const samples = [];
      const start = Date.now();
      while (Date.now() - start < 32500) {
        samples.push(await page.evaluate(() => {
          const c = window.fcLaunch.parts.capture.status();
          const s = window.fcLaunch.parts.log.status();
          return { at: Date.now(), sent: c.sent, file: s.file.lines, filePending: s.file.pending, ago: s.file.lastWriteAgoMs, cycle: s.file.cycleMs, server: s.server.lines, browser: s.browser.lines };
        }));
        await sleep(1000);
      }
      const first = samples[1];
      const last = samples.at(-1);
      const seconds = (last.at - first.at) / 1000;
      const rate = (last.sent - first.sent) / seconds;
      const behind = samples.slice(1).map((x) => x.sent - x.file);
      const ages = samples.slice(1).map((x) => x.ago);
      const browserBehind = samples.slice(1).map((x) => x.sent - x.browser);
      check('realtime: a status line and a packet each second', rate > 1.9 && rate < 2.1,
        `${last.sent - first.sent} lines in ${seconds.toFixed(1)} s = ${rate.toFixed(2)} lines a second`);
      // A cycle starts at most once a second, and lines come 0.1 s and 0.9 s
      // apart, so up to 3 lines and about 2 s are normal between writes.
      const cycles = samples.slice(1).map((x) => x.cycle).filter(Number.isFinite);
      check('realtime: the disk cycles keep up', Math.max(...behind) <= 3 && Math.max(...ages) < 2500,
        `the file was at most ${Math.max(...behind)} lines behind and its newest write at most ${Math.max(...ages)} ms old over ${samples.length - 1} looks (a disk cycle took ${Math.min(...cycles)} to ${Math.max(...cycles)} ms); the browser copy at most ${Math.max(...browserBehind)} lines behind`);
      noteFiles(await logStatus(page));
      await page.evaluate(() => window.fcLaunch.parts.capture.stop());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('tarpit')) {
    const run = await runCapture('tarpit');
    try {
      const { status, ended, feed, timing, browser } = run;
      const cmp = compareLog(readServerLog(status.server.name), SHIFTED);
      const hosts = browser.tarpit?.connections?.().map((c) => c.host ?? c.name ?? JSON.stringify(c)) ?? [];
      check('tarpit: the capture and the log are not slowed by dead requests', ended.sent === 253 && feed.counts.samples === 126 && cmp.ok && timing.done - timing.playing < 9000,
        `page up in ${timing.up} ms, capture playing at ${timing.playing} ms and done ${timing.done - timing.playing} ms later (6.3 s of capture at 20x)${blockedTimes.capture ? `, blocked run took ${blockedTimes.capture.done - blockedTimes.capture.playing} ms` : ''}; server copy ${cmp.ok ? 'complete' : cmp.problems.join('; ')}; dead connections tried: ${[...new Set(hosts)].slice(0, 6).join(', ') || 'none'}`);
    } finally {
      await run.browser.close();
    }
  }

  if (WANT.includes('connect')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      // 1. A fresh visit: the save box, then the port list in the same click.
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open' });
      let fake = await page.evaluate(() => ({ ...window.__fake, port: undefined }));
      await sleep(300);
      const awake = await page.evaluate(() => window.fcLaunch.parts.log.status().wakeLock);
      check('connect: one click asks where to save, then opens the port', fake.pickerCalls === 1 && fake.requestCalls === 1 && /^flight-\d{4}-\d{2}-\d{2}-\d{4}\.log$/.test(fake.pickerOpts?.suggestedName ?? ''),
        `save box shown ${fake.pickerCalls} time, suggested ${fake.pickerOpts?.suggestedName}, port list ${fake.requestCalls} time; screen wake lock held: ${awake}`);
      await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 20));
      await sleep(300);
      noteFiles(await logStatus(page));
      // 2. The cable comes out.
      await page.evaluate(() => window.__fake.port.unplug());
      await page.waitFor(() => window.fcLaunch.parts.log.status().lostAt, { timeout: 10000, message: 'the lost port was not noticed' });
      await sleep(1500);
      await page.screenshot(path.join(OUT, 'connect-lost.png'));
      const lostText = await page.evaluate(() => document.getElementById('fcl-log-msg')?.textContent ?? '');
      // On the launch page the recording saves itself with no name box
      // (js/views/local-console.js), so nothing covers the launch panel.
      await page.waitFor(() => document.getElementById('fc-file-tag')?.textContent === 'SAVED', { timeout: 10000, message: 'the recording was not saved after the lost port' });
      check('connect: a lost port saves the recording with no name box', !(await page.evaluate(() => document.querySelector('dialog.fc-dialog')?.open)),
        await page.evaluate(() => document.getElementById('fc-file-text')?.textContent ?? ''));
      // 3. Plugged back in: the page opens the port again by itself, with no
      // save box and no port list (the reconnect check looks closer).
      await page.evaluate(() => window.__fake.replug());
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open again' });
      await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(20, 40));
      let st = await settled(page);
      noteFiles(st);
      fake = await page.evaluate(() => ({ ...window.__fake, port: undefined }));
      const picked = await readOpfs(page, fake.pickedName);
      const pickedCmp = compareLog(picked, CAPTURE_LINES.slice(0, 40));
      const serverText = readServerLog(st.server.name);
      check('connect: a lost port is said plainly, and the reconnect keeps the same files', lostText.includes('was lost') && fake.pickerCalls === 1 && fake.requestCalls === 1 &&
        pickedCmp.ok && picked === serverText && /\n# connection closed [^\n]+\n# connected [^\n]+\n/.test(picked),
        `message: "${lostText}"; save box ${fake.pickerCalls} time, port list ${fake.requestCalls} time in all; the picked file has ${pickedCmp.data.length} lines with "# connection closed" and "# connected" between, ${picked === serverText ? 'the same as' : 'DIFFERENT from'} flight-logs/${st.server.name}`);
      // 4. A real port is open: the test capture refuses.
      const refused = await page.evaluate(() => window.fcLaunch.parts.capture.play());
      check('connect: the test capture refuses while a port is open', refused.ok === false && /port is open/.test(refused.reason), refused.reason);
      // 5. Leaving with the port open asks first.
      const dialogsBefore = page.dialogs().length;
      await page.reload({ waitUntil: 'load' }).catch(() => {});
      const asked = page.dialogs().slice(dialogsBefore).filter((d) => d.type === 'beforeunload').length;
      check('connect: the browser asks before leaving while a port is open', asked >= 1, `${asked} "leave this page?" box`);
      await page.close();

      // 6. A cancelled save box: the port still opens, and CHOOSE FILE later writes everything.
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page2.evaluate(() => { window.__fake.pickerMode = 'cancel'; });
      await page2.click('#bc-connect');
      await page2.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open after a cancelled save box' });
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 30));
      await sleep(1200);
      await page2.screenshot(path.join(OUT, 'connect-cancelled.png'));
      st = await logStatus(page2);
      const warn = await page2.evaluate(() => ({
        disk: document.getElementById('fcl-log-disk')?.textContent,
        row: document.querySelector('.fcl-log-row--disk')?.dataset.state,
        choose: !document.getElementById('fcl-log-choose')?.hidden,
        msg: document.getElementById('fcl-log-msg')?.textContent,
      }));
      check('connect: a cancelled save box still connects and says so plainly', st.file.state === 'cancelled' && warn.row === 'warn' && warn.choose && st.server.lines === 30 && st.browser.lines === 30,
        `disk row "${warn.disk}" (${warn.row}), CHOOSE FILE shown: ${warn.choose}, server ${st.server.lines} lines, browser ${st.browser.lines} lines, message "${warn.msg}"`);
      await page2.evaluate(() => { window.__fake.pickerMode = 'opfs'; });
      await page2.click('#fcl-log-choose');
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(30, 40));
      st = await settled(page2);
      noteFiles(st);
      const late = await readOpfs(page2, st.file.name);
      const lateCmp = compareLog(late, CAPTURE_LINES.slice(0, 40));
      check('connect: CHOOSE FILE later writes everything so far and carries on', st.file.state === 'saving' && lateCmp.ok,
        `${st.file.name}: ${lateCmp.data.length} lines${lateCmp.problems.length ? `, ${lateCmp.problems.join('; ')}` : ', every line from the start'}`);
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page2.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page2.close();

      // 7. A save box that takes longer than the click lasts: the second click opens the port list.
      const page3 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page3.evaluate(() => { window.__fake.pickerDelayMs = 5600; });
      await page3.click('#bc-connect');
      // No looking in the meantime: the rig's evaluate() counts as a click,
      // which would keep the first click's leave to open the port list alive.
      await sleep(7500);
      const note = await page3.evaluate(() => document.getElementById('bc-link-note').textContent);
      const calls1 = await page3.evaluate(() => window.__fake.requestCalls);
      await page3.click('#bc-connect');
      await page3.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the second click did not open the port' });
      const calls2 = await page3.evaluate(() => ({ picker: window.__fake.pickerCalls, request: window.__fake.requestCalls }));
      check('connect: when the click no longer counts, a second CONNECT opens the port list', /CONNECT again/.test(note) && calls1 === 0 && calls2.picker === 1 && calls2.request === 1,
        `after the slow save box: "${note}"; port list calls ${calls1} then ${calls2.request}; save box ${calls2.picker} time`);
      // 8. A test capture, then a real connection: the test leaves the live view.
      noteFiles(await logStatus(page3));
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page3.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page3.evaluate(() => document.querySelector('dialog.fc-dialog')?.open || new Promise((r) => setTimeout(r, 300)));
      if (await page3.evaluate(() => Boolean(document.querySelector('dialog.fc-dialog')?.open))) await saveNameBox(page3);
      const played = await page3.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      const afterTest = await page3.evaluate(() => window.fcLaunch.ctx.live.stores.flight.getTotals().samples);
      await page3.click('#bc-connect');
      await page3.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open after the test' });
      const cleared = await page3.evaluate(() => window.fcLaunch.ctx.live.stores.flight.getTotals().samples);
      await page3.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 10));
      await sleep(400);
      const real = await page3.evaluate(() => ({ samples: window.fcLaunch.ctx.live.stores.flight.getTotals().samples, lat: window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples[0]?.gps.lat, logs: window.fcLaunch.parts.log.status().logs }));
      check('connect: a real connection after a test capture starts with a clean live view', played.ok && afterTest === 126 && cleared === 0 && real.samples === 5 && Math.abs(real.lat - 35.1234567) < 1e-7,
        `the test put ${afterTest} samples on the live view, CONNECT cleared it to ${cleared}, then 5 real packets went in at ${real.lat}; logs ${real.logs.map((l) => `${l.kind}: ${l.server}`).join(', ')}`);
      for (const l of real.logs) made.add(l.server);
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // reconnect: a lost port comes back with nothing clicked
  // ------------------------------------------------------------------
  if (WANT.includes('reconnect')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      const reconnecting = () => page.waitFor(() => window.fcLaunch.parts.log.status().link.reconnecting, { timeout: 10000, message: 'the page did not start reconnecting' });
      const buttonWord = () => page.evaluate(() => document.getElementById('bc-connect-text').textContent);
      await connectFresh(page);
      await sendLines(page, CAPTURE_LINES.slice(0, 20));
      let st = await settled(page, { browserLines: 20 });
      noteFiles(st);
      const firstRec = await page.evaluate(() => window.fcLaunch.ctx.localConsole.recording().id);

      // 1. The cable comes out, and stays out for one look at the ports.
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      await sleep(2600);
      const lostLine = await barLine(page, 'fcl-receiver-alert');
      const lostView = await page.evaluate(() => ({
        linkNote: document.getElementById('fc-link-note-box').hidden ? '' : document.getElementById('bc-link-note').textContent,
        panel: document.getElementById('fcl-log-msg')?.textContent ?? '',
        tries: window.__fake.openTries,
        locks: window.fcLaunch.parts.log.status().link.locks,
      }));
      const lostButton = await buttonWord();
      await page.screenshot(path.join(OUT, 'reconnect-trying.png'));
      said.push(lostLine.text);
      check('reconnect: a lost port says under the bar that the page is reconnecting by itself',
        lostLine.shown && lostLine.onScreen && lostLine.kind === 'warn' && lostLine.tag === 'RECEIVER LOST' &&
        /^The receiver's port was lost at \d\d:\d\d:\d\d\. The page is trying to reconnect by itself/.test(lostLine.text) && /Press DISCONNECT to stop it/.test(lostLine.text) &&
        lostButton === 'DISCONNECT' && lostView.linkNote === '' && lostView.panel === lostLine.text && lostView.tries === 1,
        `${lostLine.tag}: "${lostLine.text}" (${lostLine.box}); the bar's button reads ${lostButton}; the link's own note is "${lostView.linkNote}"; opens tried while unplugged: ${lostView.tries - 1}; locks held: ${lostView.locks.join(', ') || 'none'}`);

      // 2. Plugged back in. The first two opens fail, as when Windows is
      // not ready for the port yet. Nothing is clicked.
      const before = await fakeCounts(page);
      const replugAt = Date.now();
      await page.evaluate(() => { window.__fake.openFails = 2; window.__fake.replug(); });
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 15000, interval: 20, message: 'the page did not reconnect by itself' });
      const backMs = Date.now() - replugAt;
      await sendLines(page, CAPTURE_LINES.slice(20, 40));
      st = await settled(page, { browserLines: 20 });
      noteFiles(st);
      const after = await fakeCounts(page);
      const backLine = await barLine(page, 'fcl-receiver-alert');
      const backButton = await buttonWord();
      said.push(backLine.text);
      await page.screenshot(path.join(OUT, 'reconnect-back.png'));
      const picked = await readOpfs(page, after.pickedName);
      const pickedCmp = compareLog(picked, CAPTURE_LINES.slice(0, 40));
      const serverText = readServerLog(st.server.name);
      const firstSaved = (await savedFlights(page)).find((r) => r.id === firstRec);
      const running = await page.evaluate(async () => {
        const lc = window.fcLaunch.ctx.localConsole;
        await lc.flushNow();
        return (await lc.readLines(lc.recording().id)).lines;
      });
      const browserLines = [...(firstSaved?.lines ?? []), ...running];
      const browserSame = browserLines.length === 40 && browserLines.every((l, i) => l === CAPTURE_LINES[i]);
      check('reconnect: unplug, replug, and the lines carry on in all three copies with nothing clicked',
        pickedCmp.ok && picked === serverText && /\n# connection closed [^\n]+\n# connected [^\n]+\n/.test(picked) && browserSame && backMs < BUSY_MS &&
        after.pickerCalls === 1 && after.requestCalls === 1 && after.openTries - before.openTries === 3 && st.link.back && !st.link.reconnecting,
        `the port was open again ${backMs} ms after the replug (${after.openTries - before.openTries} opens tried, the first 2 made to fail); the disk file has ${pickedCmp.data.length} lines ${pickedCmp.ok ? 'in order' : pickedCmp.problems.join('; ')} with "# connection closed" and "# connected" between; the server copy is ${picked === serverText ? 'the same bytes' : 'DIFFERENT'}; the browser copy has ${firstSaved?.lines.length ?? 0} + ${running.length} lines (${browserSame ? 'the same lines' : 'NOT the same'}); save box ${after.pickerCalls} time and port list ${after.requestCalls} time in the whole visit`);
      check('reconnect: the page says that it has reconnected', backLine.shown && backLine.kind === 'info' && backLine.tag === 'RECEIVER BACK' && backButton === 'DISCONNECT' &&
        /^The receiver's port was lost at \d\d:\d\d:\d\d\. The page reconnected by itself \d+ seconds? later, at \d\d:\d\d:\d\d\. The log carries on in the same files\.$/.test(backLine.text),
        `${backLine.tag}: "${backLine.text}"; the bar's button reads ${backButton}`);

      // 3. Again, with no "connect" event: the page's own look every 2 s finds it.
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      const quietAt = Date.now();
      await page.evaluate(() => window.__fake.replug({ event: false }));
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, interval: 20, message: 'the page did not find the port without the connect event' });
      const quietMs = Date.now() - quietAt;
      await sendLines(page, CAPTURE_LINES.slice(40, 50));
      st = await settled(page, { browserLines: 10 });
      const server50 = compareLog(readServerLog(st.server.name), CAPTURE_LINES.slice(0, 50));
      check('reconnect: without the "connect" event the page still finds the port', quietMs < BUSY_MS && server50.ok,
        `open again ${quietMs} ms after the replug (the page looks every 2 s); the server copy has ${server50.data.length} lines${server50.ok ? '' : `, ${server50.problems.join('; ')}`}`);

      // Plugged in, but the port will not open, as when another program
      // has it. The page says so, keeps trying, and opens it once it can.
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      const busyStart = (await fakeCounts(page)).openTries;
      await page.evaluate(() => { window.__fake.openFails = 1000; window.__fake.replug(); });
      await page.waitFor(() => /will not open/.test(window.fcLaunch.parts.log.status().alerts.receiver?.text ?? ''), { timeout: 15000, interval: 50, message: 'the page did not say that the port will not open' });
      await sleep(400);
      const busyLine = await barLine(page, 'fcl-receiver-alert');
      const busyTries = (await fakeCounts(page)).openTries - busyStart;
      said.push(busyLine.text);
      await page.screenshot(path.join(OUT, 'reconnect-will-not-open.png'));
      const freeAt = Date.now();
      await page.evaluate(() => { window.__fake.openFails = 0; });
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, interval: 20, message: 'the page did not open the port once it could' });
      const freeMs = Date.now() - freeAt;
      check('reconnect: a port that is plugged in and will not open is said plainly, and the page keeps trying',
        busyLine.shown && busyLine.kind === 'warn' && busyLine.tag === 'RECEIVER LOST' && freeMs < BUSY_MS &&
        /^The receiver's port was lost at \d\d:\d\d:\d\d\. It is plugged in, but it will not open\. Another program may be using it, so close the backup logger or any serial monitor\. The page keeps trying by itself\. Press DISCONNECT to stop it\.$/.test(busyLine.text),
        `after ${busyTries} opens that failed: "${busyLine.text}"; the port opened ${freeMs} ms after it could`);

      // 4. DISCONNECT while it is trying stops it, so the port is free.
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      await page.waitFor(() => document.getElementById('bc-connect-text').textContent === 'DISCONNECT', { timeout: 5000, message: 'the button did not read DISCONNECT while reconnecting' });
      await page.click('#bc-connect');
      await page.waitFor(() => !window.fcLaunch.parts.log.status().link.reconnecting, { timeout: 5000, message: 'DISCONNECT did not stop the reconnecting' });
      const triesBefore = (await fakeCounts(page)).openTries;
      await page.evaluate(() => window.__fake.replug());
      await sleep(4500);
      const stopped = await page.evaluate(() => ({
        open: window.fcLaunch.ctx.live.link.open,
        tries: window.__fake.openTries,
        locks: window.fcLaunch.parts.log.status().link.locks,
      }));
      const stopLine = await barLine(page, 'fcl-receiver-alert');
      const stopButton = await buttonWord();
      said.push(stopLine.text);
      check('reconnect: DISCONNECT while it is trying stops it and frees the port',
        !stopped.open && stopped.tries === triesBefore && stopButton === 'CONNECT' && !stopped.locks.includes('fc-launch-receiver') && stopLine.kind === 'info' && /stopped trying to reconnect, so the receiver's port is free\. Press CONNECT to connect again\./.test(stopLine.text),
        `4.5 s after the replug: port open ${stopped.open}, ${stopped.tries - triesBefore} opens tried, the button reads ${stopButton}, locks held: ${stopped.locks.join(', ') || 'none'}; "${stopLine.text}"`);
      // CONNECT then shows the port list, and the same files carry on.
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'CONNECT did not open the port after the stop' });
      await sendLines(page, CAPTURE_LINES.slice(50, 60));
      st = await settled(page, { browserLines: 10 });
      const last = await fakeCounts(page);
      const server60 = compareLog(readServerLog(st.server.name), CAPTURE_LINES.slice(0, 60));
      check('reconnect: CONNECT after that shows the port list and carries on in the same files',
        last.requestCalls === 2 && last.pickerCalls === 1 && server60.ok && st.logs.filter((l) => l.kind === 'flight').length === 1,
        `port list ${last.requestCalls} times, save box ${last.pickerCalls} time; one flight log, flight-logs/${st.server.name}, with ${server60.data.length} lines${server60.ok ? '' : `, ${server60.problems.join('; ')}`}`);

      // 5. Some other board this browser may open is plugged in while the
      // receiver's cable is out. It is the only port the page may open, and
      // it is never opened in the receiver's place.
      await page.evaluate(() => { window.__fake.otherPlugged = true; });
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      const otherBefore = await fakeCounts(page);
      await sleep(4500);
      const otherWait = await page.evaluate(async () => ({
        granted: (await navigator.serial.getPorts()).length,
        open: window.fcLaunch.ctx.live.link.open,
        tries: window.__fake.openTries,
        otherTries: window.__fake.otherTries,
        reconnecting: window.fcLaunch.parts.log.status().link.reconnecting,
      }));
      // The receiver goes back in, with no "connect" event: of the two
      // ports the page may open now, it takes the one with the receiver's ids.
      await page.evaluate(() => window.__fake.replug({ event: false }));
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, interval: 20, message: 'the page did not pick the receiver out of two ports' });
      const which = await page.evaluate(() => ({ receiver: window.fcLaunch.ctx.live.link.port === window.__fake.port, otherTries: window.__fake.otherTries }));
      await sendLines(page, CAPTURE_LINES.slice(60, 70));
      st = await settled(page, { browserLines: 10 });
      const server70 = compareLog(readServerLog(st.server.name), CAPTURE_LINES.slice(0, 70));
      await page.evaluate(() => { window.__fake.otherPlugged = false; });
      check('reconnect: another board that is plugged in is never opened in the receiver\'s place',
        otherWait.granted === 1 && !otherWait.open && otherWait.reconnecting && otherWait.otherTries === 0 && otherWait.tries === otherBefore.openTries &&
        which.receiver && which.otherTries === 0 && server70.ok,
        `4.5 s with the receiver out and ${otherWait.granted} other port the page may open: ${otherWait.otherTries} opens tried on it, port open ${otherWait.open}, still reconnecting ${otherWait.reconnecting}; after the replug the page opened ${which.receiver ? 'the receiver' : 'THE OTHER BOARD'} (${which.otherTries} opens on the other board), and the server copy has ${server70.data.length} lines${server70.ok ? '' : `, ${server70.problems.join('; ')}`}`);

      // 6. DISCONNECT pressed in the instant the port opens again (it is
      // open, and not ready yet): the port is closed again and stays free.
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      const raceBefore = await fakeCounts(page);
      await page.evaluate(() => { window.__fake.signalDelayMs = 1500; window.__fake.replug(); });
      await page.waitFor((n) => window.__fake.opens > n, { timeout: 10000, interval: 20, args: [raceBefore.opens], message: 'the page did not open the port again' });
      await page.click('#bc-connect');
      await sleep(3500);
      const race = await page.evaluate(() => ({
        link: window.fcLaunch.ctx.live.link.link,
        closes: window.__fake.closes,
        tries: window.__fake.openTries,
        reconnecting: window.fcLaunch.parts.log.status().link.reconnecting,
        locks: window.fcLaunch.parts.log.status().link.locks,
        button: document.getElementById('bc-connect-text').textContent,
      }));
      await page.evaluate(() => { window.__fake.signalDelayMs = 0; });
      const raceLine = await barLine(page, 'fcl-receiver-alert');
      check('reconnect: DISCONNECT pressed in the instant the port opens again still frees the port',
        race.link === 'closed' && race.closes === raceBefore.closes + 1 && race.tries === raceBefore.openTries + 1 && !race.reconnecting &&
        !race.locks.includes('fc-launch-receiver') && race.button === 'CONNECT' && /so the receiver's port is free/.test(raceLine.text),
        `3.5 s later: link ${race.link}, the port was closed ${race.closes - raceBefore.closes} time after ${race.tries - raceBefore.openTries} open, reconnecting ${race.reconnecting}, the button reads ${race.button}, locks held: ${race.locks.join(', ') || 'none'}; "${raceLine.text}"`);

      // 7. A port that reports no USB ids, so there is nothing to tell it
      // by: the page takes the only port it may open.
      await page.evaluate(() => { window.__fake.noIds = true; });
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'CONNECT did not open the port with no ids' });
      await sendLines(page, CAPTURE_LINES.slice(70, 76));
      await page.evaluate(() => window.__fake.unplug());
      await reconnecting();
      const noIdsAt = Date.now();
      await page.evaluate(() => window.__fake.replug({ event: false }));
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, interval: 20, message: 'the page did not open the only port it may open' });
      const noIdsMs = Date.now() - noIdsAt;
      await sendLines(page, CAPTURE_LINES.slice(76, 80));
      st = await settled(page, { browserLines: 4 });
      const server80 = compareLog(readServerLog(st.server.name), CAPTURE_LINES.slice(0, 80));
      await page.evaluate(() => { window.__fake.noIds = false; });
      check('reconnect: a port with no USB ids is found as the only port the page may open', noIdsMs < BUSY_MS && server80.ok && !st.link.reconnecting,
        `open again ${noIdsMs} ms after the replug with no "connect" event; the server copy has ${server80.data.length} lines${server80.ok ? '' : `, ${server80.problems.join('; ')}`}`);
      check('reconnect: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
      await page.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });

      // 8. A fresh page with a port it may open (from an earlier visit)
      // never opens it by itself.
      await page.evaluate(() => localStorage.setItem('__fakeGranted', '1'));
      await page.close();
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await sleep(6000);
      const fresh = await page2.evaluate(async () => ({
        granted: (await navigator.serial.getPorts()).length,
        tries: window.__fake.openTries,
        link: window.fcLaunch.ctx.live.link.link,
        reconnecting: window.fcLaunch.parts.log.status().link.reconnecting,
        logs: window.fcLaunch.parts.log.status().logs.length,
      }));
      await page2.evaluate(() => localStorage.removeItem('__fakeGranted'));
      check('reconnect: a fresh page never opens a port by itself', fresh.granted === 1 && fresh.tries === 0 && fresh.link === 'idle' && !fresh.reconnecting && fresh.logs === 0,
        `6 s after loading with ${fresh.granted} port it may open: ${fresh.tries} opens tried, link ${fresh.link}, ${fresh.logs} logs`);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // silent: a connected port that says nothing
  // ------------------------------------------------------------------
  if (WANT.includes('silent')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      const quietNow = () => page.evaluate(() => window.fcLaunch.parts.log.status().link.quiet);
      // What the receiver's line under the bar and the log's status say now.
      const silence = () => page.evaluate(() => {
        const el = document.getElementById('fcl-receiver-alert');
        return { tag: el && !el.hidden ? el.querySelector('.fc-status-tag').textContent : '', quiet: window.fcLaunch.parts.log.status().link.quiet };
      });
      const openedAt = Date.now();
      await connectFresh(page);
      noteFiles(await logStatus(page));
      // 1. Nothing arrives at all: probably the wrong port. Not before 8 s,
      // though: 6.5 s after CONNECT there is no warning yet.
      await sleep(Math.max(0, 6500 - (Date.now() - openedAt)));
      const early = await silence();
      const earlyMs = Date.now() - openedAt;
      await page.waitFor(() => window.fcLaunch.parts.log.status().link.quiet, { timeout: NO_DATA_WARN_MS + BUSY_MS, interval: 50, message: 'no warning for a port that says nothing' });
      const warnedMs = Date.now() - openedAt;
      await sleep(700);
      const wrong = await barLine(page, 'fcl-receiver-alert');
      const rows = await page.evaluate(() => ({
        lines: document.getElementById('fcl-log-lines')?.textContent ?? '',
        state: document.querySelector('.fcl-log-row--lines')?.dataset.state,
        panel: document.getElementById('fcl-log-msg')?.textContent ?? '',
      }));
      await page.screenshot(path.join(OUT, 'silent-wrong-port.png'));
      said.push(wrong.text);
      check('silent: a connected port that says nothing warns that it may be the wrong port',
        wrong.shown && wrong.onScreen && wrong.kind === 'warn' && wrong.tag === 'NO DATA' &&
        early.tag === '' && early.quiet === null && earlyMs < NO_DATA_WARN_MS && warnedMs >= NO_DATA_WARN_MS && warnedMs < NO_DATA_WARN_MS + BUSY_MS &&
        /^Nothing has come from this port in \d+ seconds\. It may be the wrong port\. Press DISCONNECT, then CONNECT, and pick the receiver's port\.$/.test(wrong.text) &&
        rows.state === 'warn' && /^0NOTHING FOR /.test(rows.lines),
        `${earlyMs} ms after CONNECT there was no warning yet ("${early.tag}"). It came ${warnedMs} ms after CONNECT (the limit is ${NO_DATA_WARN_MS} ms). ${wrong.tag}: "${wrong.text}" (${wrong.box}); the LINES row reads "${rows.lines.replace(/^0/, '0, ')}" (${rows.state})`);
      // 2. DISCONNECT, then CONNECT: the port list shows again.
      const c0 = await fakeCounts(page);
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.link === 'closed', { timeout: 5000, message: 'DISCONNECT did not close the port' });
      await sleep(400);
      const gone = await barLine(page, 'fcl-receiver-alert');
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open again' });
      const c1 = await fakeCounts(page);
      check('silent: DISCONNECT, then CONNECT shows the port list again', c1.requestCalls === c0.requestCalls + 1 && c1.pickerCalls === c0.pickerCalls && !gone.shown,
        `port list ${c0.requestCalls} time before and ${c1.requestCalls} after, save box still ${c1.pickerCalls} time; the warning ${gone.shown ? 'STAYED' : 'went away'} with the connection`);
      // 3. Lines arrive, then the receiver stops. A healthy receiver that
      // hears no packets prints a line about every 5 s, so 9.5 s after the
      // last line there is still no warning. It comes after 12 s.
      await sendLines(page, CAPTURE_LINES.slice(0, 2), { each: 2, gapMs: 300 });
      const lastLineAt = Date.now();
      await sendLines(page, CAPTURE_LINES.slice(2, 4), { each: 2, gapMs: 300 });
      const fine = await barLine(page, 'fcl-receiver-alert');
      const fineQuiet = await quietNow();
      await sleep(Math.max(0, 9500 - (Date.now() - lastLineAt)));
      const waiting = await silence();
      const waitingMs = Date.now() - lastLineAt;
      await page.waitFor(() => window.fcLaunch.parts.log.status().link.quiet, { timeout: SILENT_WARN_MS + BUSY_MS, interval: 50, message: 'no warning for a receiver that stopped' });
      const stuckMs = Date.now() - lastLineAt;
      await sleep(700);
      const stuck = await barLine(page, 'fcl-receiver-alert');
      await page.screenshot(path.join(OUT, 'silent-receiver-stuck.png'));
      said.push(stuck.text);
      check('silent: a receiver that stops sending warns that it may be stuck',
        !fine.shown && fineQuiet === null && stuck.shown && stuck.onScreen && stuck.kind === 'warn' && stuck.tag === 'RECEIVER SILENT' &&
        waiting.tag === '' && waiting.quiet === null && waitingMs < SILENT_WARN_MS && stuckMs >= SILENT_WARN_MS && stuckMs < SILENT_WARN_MS + BUSY_MS &&
        /^The receiver has sent nothing for \d+ seconds\. It prints a line at least every 5 seconds, so it may be stuck\. Unplug it and plug it back in\. The page reconnects by itself\.$/.test(stuck.text),
        `no warning while lines came, and none ${waitingMs} ms after the last line ("${waiting.tag}"); it came after ${stuckMs} ms (the limit is ${SILENT_WARN_MS} ms). ${stuck.tag}: "${stuck.text}"`);
      // 4. A line arrives: the warning goes.
      await sendLines(page, CAPTURE_LINES.slice(4, 6), { each: 2, gapMs: 400 });
      const cleared = await barLine(page, 'fcl-receiver-alert');
      check('silent: the warning clears when a line arrives', !cleared.shown && (await quietNow()) === null, `shown: ${cleared.shown}`);
      // 5. The receiver's radio did not start: what to do next.
      await page.evaluate(() => window.__fake.port.send('# DEKEL_RX radio-failed error=-2 good=0 bad=0 rx_up_s=5.0\r\n'));
      await sleep(400);
      const radio = await page.evaluate(() => ({ text: document.getElementById('bc-link-note').textContent, kind: document.getElementById('fc-link-note-box').dataset.kind, hidden: document.getElementById('fc-link-note-box').hidden }));
      await page.screenshot(path.join(OUT, 'silent-radio-failed.png'));
      said.push(radio.text);
      check('silent: a radio that did not start says what to do next', !radio.hidden && radio.kind === 'warn' &&
        radio.text === 'Radio board receiver is connected, but its radio didn\'t start (error -2). It can\'t hear the rocket until that is fixed. Unplug the receiver and plug it back in. If it says the same again, its radio is not working, so switch to the spare receiver or check its antenna and wiring.',
        `"${radio.text}"`);
      check('silent: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
      await page.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // receiver: the receiver's newer firmware (plain lines and status blocks)
  // ------------------------------------------------------------------
  if (WANT.includes('receiver')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      const send = (lines) => page.evaluate((part) => { window.__fake.port.send(`${part.join('\r\n')}\r\n`); }, lines);
      const look = () => page.evaluate(() => {
        const st = window.fcLaunch.parts.log.status();
        const live = window.fcLaunch.ctx.live;
        const box = document.getElementById('fc-link-note-box');
        return {
          source: live.source?.name ?? null,
          mode: live.mode,
          bench: live.stores.bench?.getTotals?.().samples ?? 0,
          flight: live.stores.flight?.getTotals?.().samples ?? 0,
          note: box.hidden ? '' : document.getElementById('bc-link-note').textContent,
          noteKind: box.dataset.kind ?? null,
          unknown: !document.getElementById('fc-notice').hidden,
          alert: st.alerts.receiver?.tag ?? '',
          quiet: st.link.quiet,
          lines: st.lines,
          fix: document.querySelector('#fc-launch-panel .fcl-recovery')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      // The latitude LAST GOOD FIX shows, from the panel's text.
      const latOf = (fix) => /Latitude\s*(-?\d+\.\d+)/.exec(fix)?.[1] ?? 'none';
      await connectFresh(page);
      noteFiles(await logStatus(page));

      // 1. A healthy receiver that waits for the rocket: its start-up
      // report, then its waiting line at the real rhythm. The line under
      // the bar is looked at 50 times a second for the whole time.
      const waitMs = RX_GAPS_MS.reduce((a, b) => a + b, 0);
      await page.evaluate((start, gaps) => {
        const t0 = performance.now();
        window.__fake.port.send(`${start.join('\r\n')}\r\n`);
        window.__rx = { sentAt: [], seen: [], unknown: false };
        let at = 0;
        gaps.forEach((gap, i) => {
          at += gap;
          setTimeout(() => {
            window.__fake.port.send(`Error: No packets received for ${13 + 5 * i} s\r\n`);
            window.__rx.sentAt.push(Math.round(performance.now() - t0));
          }, at);
        });
        let last = '';
        window.__rx.watch = setInterval(() => {
          const el = document.getElementById('fcl-receiver-alert');
          const tag = el && !el.hidden ? el.querySelector('.fc-status-tag').textContent : '';
          if (tag !== last) {
            window.__rx.seen.push({ at: Math.round(performance.now() - t0), tag });
            last = tag;
          }
          if (!document.getElementById('fc-notice').hidden) window.__rx.unknown = true;
        }, 20);
      }, RX_START, RX_GAPS_MS);
      await sleep(2000);
      const found = await look();
      await page.screenshot(path.join(OUT, 'receiver-waiting.png'));
      await sleep(waitMs - 2000 + 1500);
      const rhythm = await page.evaluate(() => {
        clearInterval(window.__rx.watch);
        return { sentAt: window.__rx.sentAt, seen: window.__rx.seen, unknown: window.__rx.unknown };
      });
      const idle = await look();
      const sentGaps = rhythm.sentAt.map((t, i) => t - (i ? rhythm.sentAt[i - 1] : 0));
      const warned = rhythm.seen.filter((s) => s.tag !== '');
      said.push(found.note);
      check('receiver: a receiver that waits for the rocket never gets a silent-port warning',
        rhythm.sentAt.length === RX_GAPS_MS.length && Math.max(...sentGaps) >= 6400 && warned.length === 0 && idle.quiet === null && idle.alert === '',
        `${rhythm.sentAt.length} waiting lines over ${(waitMs / 1000).toFixed(1)} s, sent ${sentGaps.join(', ')} ms apart (the real board's gaps, and one line 1.5 s late). Warnings under the bar: ${warned.map((s) => `${s.tag} at ${(s.at / 1000).toFixed(1)} s`).join(', ') || 'none'}`);
      check('receiver: the page says the receiver was found and is listening', found.note === RX_FOUND && found.noteKind === 'info' && idle.note === RX_FOUND && idle.lines === RX_START.length + RX_GAPS_MS.length,
        `2 s after CONNECT and ${(waitMs / 1000).toFixed(0)} s later the note under the bar reads "${idle.note}" (${idle.noteKind}); ${idle.lines} lines in the log`);

      // 2. Seventy more waiting lines, more than the 60 with no match that
      // make the console call the data unknown.
      await send(Array.from({ length: 70 }, (_, i) => `Error: No packets received for ${60 + 5 * i} s`));
      await sleep(700);
      const many = await look();
      await page.screenshot(path.join(OUT, 'receiver-waiting-long.png'));
      check('receiver: a receiver that waits is never called NOT RECOGNIZED', !rhythm.unknown && !many.unknown && many.source === null && many.note === RX_FOUND && many.lines === idle.lines + 70,
        `after ${many.lines} lines with no packet: NOT RECOGNIZED ${many.unknown ? 'SHOWS' : 'hidden'}, source ${many.source}, note "${many.note}"`);

      // 3. The radio did not start, in the firmware's own words. Then a
      // later try works.
      await send([RX_RADIO_DEAD]);
      await sleep(500);
      const dead = await look();
      await page.screenshot(path.join(OUT, 'receiver-radio-failed.png'));
      said.push(dead.note);
      await send([RX_RADIO_DEAD]);
      await sleep(300);
      const deadAgain = await look();
      await send([RX_START[3]]);
      await sleep(500);
      const alive = await look();
      check('receiver: a radio that did not start says what to do next, and the warning goes when the radio starts',
        dead.note === RX_DEAD_NOTE && dead.noteKind === 'warn' && deadAgain.note === RX_DEAD_NOTE && !dead.unknown && alive.note === RX_FOUND && alive.noteKind === 'info',
        `after "${RX_RADIO_DEAD.slice(0, 58)}...": "${dead.note}" (${dead.noteKind}). After "Radio: ... listening": "${alive.note}"`);

      // 4. Packets: one status block each, five of them a second apart.
      const REAL_LAT = 44.8412345;
      for (let i = 0; i < 5; i += 1) {
        await send(rxBlock(807 + i, REAL_LAT + i * 0.00001, -73.1512345, 120 + i));
        await sleep(i < 4 ? 1000 : 300);
      }
      // The 70 lines of step 2, the 3 of step 3 and the 5 blocks.
      const expectedLines = many.lines + 3 + 5 * rxBlock(0, 0, 0, 0).length;
      const st4 = await settled(page, { browserLines: expectedLines });
      const flying = await look();
      await page.screenshot(path.join(OUT, 'receiver-packets.png'));
      check('receiver: its status blocks reach the live view and every copy, and the waiting note goes',
        flying.source === 'Dogtooth board over USB' && flying.bench === 5 && flying.flight === 0 && flying.note === '' && !flying.unknown &&
        flying.lines === expectedLines && st4.file.lines === expectedLines && st4.server.lines === expectedLines && st4.browser.lines === expectedLines && latOf(flying.fix).startsWith('44.8412'),
        `5 packets: source "${flying.source}", ${flying.bench} samples on the live view, note "${flying.note}"; log ${flying.lines} lines, disk file ${st4.file.lines}, server copy ${st4.server.lines}, browser copy ${st4.browser.lines} (${expectedLines} sent); LAST GOOD FIX latitude ${latOf(flying.fix)}`);

      // 5. The radio's line again, now after packets, and a packet clears it.
      await send([RX_RADIO_DEAD]);
      await sleep(500);
      const deadLate = await look();
      await send(rxBlock(812, REAL_LAT + 0.00005, -73.1512345, 125));
      await sleep(500);
      const clearedLate = await look();
      check('receiver: the radio warning also shows after packets, and the next packet clears it',
        deadLate.note === RX_DEAD_NOTE && deadLate.noteKind === 'warn' && clearedLate.note === '' && clearedLate.bench === 6,
        `after the radio's line: "${deadLate.note.slice(0, 70)}..." (${deadLate.noteKind}); after the next packet: "${clearedLate.note}", ${clearedLate.bench} samples`);

      // 6. DISCONNECT, then PLAY TEST CAPTURE: it must not play over the
      // real packets, which are in the bench store with this firmware.
      noteFiles(await settled(page));
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.link === 'closed', { timeout: 5000, message: 'DISCONNECT did not close the port' });
      const before = await look();
      const played = await page.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 20 }));
      await sleep(800);
      const after = await look();
      const capNote = await page.evaluate(() => document.getElementById('fcl-cap-msg')?.textContent ?? '');
      noteFiles(await logStatus(page));
      await page.screenshot(path.join(OUT, 'receiver-capture-refused.png'));
      said.push(capNote);
      check('receiver: the test capture refuses to play over packets from the newer firmware',
        played.ok === false && played.sent === 0 && played.reason === 'The live view has data from a real connection, and a test capture would mix with it. Reload the page to test again.' && capNote === played.reason &&
        after.bench === 6 && after.flight === 0 && after.mode === 'bench' && latOf(before.fix).startsWith('44.8412') && latOf(after.fix) === latOf(before.fix),
        `PLAY TEST CAPTURE answered ok ${played.ok}, ${played.sent} lines sent, "${played.reason}"; the live view still has ${after.bench} real samples and ${after.flight} test samples; LAST GOOD FIX latitude ${latOf(before.fix)} before and ${latOf(after.fix)} after`);
      check('receiver: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);

      // 7. The other way round, in a new visit: a flight log in the newer
      // format played as a test capture (?capture= does this), then a real
      // connection. The test's packets are in the bench store, and they
      // must be gone before the flight's first packet. The test's blocks
      // are earlier on the rocket's clock than the flight's, so nothing
      // but the page's own clearing can take them away.
      await page.close();
      const TEST_LAT = 44.81;
      const FLIGHT_LAT = 44.83;
      const stamp = (ms) => new Date(ms - 5 * 3600e3).toISOString().replace('Z', '-05:00');
      const t0 = Date.UTC(2026, 10, 19, 20, 0, 0);
      const capLines = ['# Dogtooth flight log', `# started ${stamp(t0)}`];
      RX_START.forEach((l) => capLines.push(`${stamp(t0)} > ${l}`));
      for (let i = 0; i < 4; i += 1) rxBlock(100 + i, TEST_LAT + i * 0.00001, -73.16, 80 + i).forEach((l) => capLines.push(`${stamp(t0 + 1000 * (i + 1))} > ${l}`));
      const capName = `test-newer-format-${process.pid}.log`;
      fs.mkdirSync(LOGS, { recursive: true });
      fs.writeFileSync(path.join(LOGS, capName), `${capLines.join('\n')}\n`);
      made.add(capName);
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      const look2 = () => page2.evaluate(() => {
        const live = window.fcLaunch.ctx.live;
        return {
          liveData: window.fcLaunch.parts.log.liveData(),
          bench: live.stores.bench?.getTotals?.().samples ?? 0,
          flight: live.stores.flight?.getTotals?.().samples ?? 0,
          lats: (live.stores.bench?.getRockets?.() ?? []).flatMap((r) => r.track.map((p) => Number(p.lat.toFixed(2)))),
          fix: document.querySelector('#fc-launch-panel .fcl-recovery')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      const played2 = await page2.evaluate((url) => window.fcLaunch.parts.capture.play({ url, speed: 20, shift: 'none' }), server.url(`/flight-logs/${capName}`));
      await sleep(500);
      const tested = await look2();
      noteFiles(await logStatus(page2));
      await connectFresh(page2);
      const opened = await look2();
      await page2.evaluate((part) => { window.__fake.port.send(`${part.join('\r\n')}\r\n`); }, RX_START);
      for (let i = 0; i < 3; i += 1) {
        await page2.evaluate((part) => { window.__fake.port.send(`${part.join('\r\n')}\r\n`); }, rxBlock(807 + i, FLIGHT_LAT + i * 0.00001, -73.15, 120 + i));
        await sleep(300);
      }
      const flightLines = RX_START.length + 3 * rxBlock(0, 0, 0, 0).length;
      const st7 = await settled(page2, { browserLines: flightLines });
      noteFiles(st7);
      const flown = await look2();
      await sleep(300);
      await page2.screenshot(path.join(OUT, 'receiver-test-then-flight.png'));
      check('receiver: a test capture in the newer format leaves the live view when the real connection opens',
        played2.ok === true && played2.sent === capLines.length - 2 && tested.liveData === 'test' && tested.bench === 4 && tested.lats.every((lat) => lat === TEST_LAT) &&
        opened.bench === 0 && opened.flight === 0 && opened.liveData === 'none' &&
        flown.liveData === 'real' && flown.bench === 3 && flown.lats.length === 3 && flown.lats.every((lat) => lat === FLIGHT_LAT) && latOf(flown.fix).startsWith('44.83') &&
        st7.logs.length === 2 && st7.logs[0].kind === 'test' && st7.logs[1].kind === 'flight' &&
        st7.lines === flightLines && st7.file.lines === flightLines && st7.server.lines === flightLines,
        `the test played ${played2.sent} lines and put ${tested.bench} packets near ${TEST_LAT} on the live view (${tested.liveData}). After CONNECT: ${opened.bench} samples (${opened.liveData}). After 3 real packets: ${flown.bench} samples, track latitudes ${[...new Set(flown.lats)].join(', ')}, LAST GOOD FIX latitude ${latOf(flown.fix)}; the flight's log has ${st7.lines} lines, disk file ${st7.file.lines}, server copy ${st7.server.lines}, browser copy ${st7.browser.lines}; logs: ${st7.logs.map((l) => `${l.kind} ${l.server}`).join(', ')}`);
      check('receiver: no exceptions in the second visit', page2.exceptions().length === 0, `${page2.exceptions().length} exceptions`);
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await sleep(400);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // server: the local server's window gets closed
  // ------------------------------------------------------------------
  if (WANT.includes('server')) {
    // A server of this check's own, so it can be stopped and started.
    let own = await startServer({ port: SERVER_PORT });
    const browser = await launchChrome({ network: 'blocked' });
    try {
      if (!own.owned) throw new Error(`Something already serves port ${SERVER_PORT}, and this check has to stop and start its own server. Pick another with --server-port.`);
      const page = await openPage(browser, own, '/flight-console/launch.html?track', { fake: true });
      const serverRow = () => page.evaluate(() => ({ text: document.getElementById('fcl-log-server')?.textContent ?? '', state: document.querySelector('.fcl-log-row--server')?.dataset.state }));
      const warned = () => page.waitFor(() => Boolean(window.fcLaunch.parts.log.status().alerts.server), { timeout: 40000, interval: 50, message: 'no warning after the server stopped' });
      await page.waitFor(() => /^READY/.test(document.getElementById('fcl-log-server')?.textContent ?? ''), { timeout: 10000, message: 'the SERVER row never said READY' });

      // 1. Before the first CONNECT: READY must not stay.
      await own.stop();
      let stopAt = Date.now();
      await warned();
      const firstMs = Date.now() - stopAt;
      await sleep(600);
      const row1 = await serverRow();
      const line1 = await barLine(page, 'fcl-server-alert');
      await page.screenshot(path.join(OUT, 'server-stopped-before-connect.png'));
      said.push(line1.text);
      check('server: before CONNECT, a stopped server does not stay READY',
        line1.shown && line1.onScreen && line1.kind === 'warn' && line1.tag === 'SERVER STOPPED' && row1.state === 'warn' && !/READY/.test(row1.text) && firstMs < 17000 + BUSY_MS &&
        line1.text === 'The launch mode server has stopped. Do not reload or close this page. Double-click launch-mode.bat to start the server again, then close the extra tab that opens and come back to this one.',
        `the warning came ${firstMs} ms after the server stopped (it is asked every 12 s, and warned about after 5 s of silence). ${line1.tag}: "${line1.text}" (${line1.box}); the SERVER row reads "${row1.text}" (${row1.state})`);
      own = await startServer({ port: SERVER_PORT });
      let backAt = Date.now();
      await page.waitFor(() => !window.fcLaunch.parts.log.status().alerts.server && /^READY/.test(document.getElementById('fcl-log-server')?.textContent ?? ''), { timeout: 15000, interval: 50, message: 'the warning stayed after the server came back' });
      const readyMs = Date.now() - backAt;
      check('server: the warning clears when the server is back', readyMs < BUSY_MS && !(await barLine(page, 'fcl-server-alert')).shown, `${readyMs} ms after it started again the SERVER row reads "${(await serverRow()).text}"`);

      // 2. In the middle of a connection, with the receiver still sending.
      await connectFresh(page);
      await sendLines(page, CAPTURE_LINES.slice(0, 20));
      let st = await settled(page, { browserLines: 20 });
      noteFiles(st);
      await own.stop();
      stopAt = Date.now();
      let warnedMs = null;
      for (let i = 20; i < 56; i += 2) {
        await page.evaluate((part) => { for (const l of part) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(i, i + 2));
        await sleep(480);
        if (warnedMs === null && await page.evaluate(() => Boolean(window.fcLaunch.parts.log.status().alerts.server))) warnedMs = Date.now() - stopAt;
      }
      await page.waitFor(() => { const s = window.fcLaunch.parts.log.status(); return s.file.lines === 56 && s.browser.lines === 56; }, { timeout: 10000, message: 'the disk file and the browser copy did not keep saving' });
      st = await logStatus(page);
      const line2 = await barLine(page, 'fcl-server-alert');
      const row2 = await serverRow();
      await page.screenshot(path.join(OUT, 'server-stopped-connected.png'));
      said.push(line2.text);
      check('server: a stopped server is said under the bar while the other copies keep saving',
        line2.shown && line2.onScreen && line2.kind === 'warn' && line2.tag === 'SERVER STOPPED' && warnedMs !== null && warnedMs < 6000 + BUSY_MS &&
        line2.text === 'The launch mode server has stopped. The disk file and the browser copy are still saving. Do not reload or close this page. Double-click launch-mode.bat to start the server again, then close the extra tab that opens and come back to this one.' &&
        st.file.lines === 56 && st.browser.lines === 56 && st.server.lines < 56 && row2.state === 'warn' && /^NOT SAVING/.test(row2.text),
        `the warning came ${warnedMs} ms after the server stopped. "${line2.text}" (${line2.box}); 36 more lines arrived meanwhile: disk file ${st.file.lines}, browser ${st.browser.lines}, server ${st.server.lines} with ${st.server.pending} waiting; the SERVER row reads "${row2.text.replace(/flight-logs.*/, '')}"`);

      // 3. On screen in a small window too, with the panel and the page
      // scrolled as far as they go.
      const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const sizes = [];
      for (const [width, height] of [[1000, 620], [760, 560]]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
        const scrolled = await page.evaluate(() => {
          const panel = document.getElementById('fc-launch-panel');
          if (panel) panel.scrollTop = panel.scrollHeight;
          window.scrollTo(0, document.documentElement.scrollHeight);
          const row = document.querySelector('.fcl-log-row--server')?.getBoundingClientRect();
          return { pageY: Math.round(window.scrollY), panelTop: Math.round(panel?.scrollTop ?? 0), rowOnScreen: Boolean(row) && row.top >= 0 && row.bottom <= window.innerHeight && row.height > 0 };
        });
        await sleep(300);
        const seen = await barLine(page, 'fcl-server-alert');
        await page.screenshot(path.join(OUT, `server-stopped-${width}x${height}.png`));
        sizes.push({ width, height, ...scrolled, onScreen: seen.onScreen, box: seen.box });
      }
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(() => { window.scrollTo(0, 0); const p = document.getElementById('fc-launch-panel'); if (p) p.scrollTop = 0; });
      check('server: the warning is on screen in smaller windows with everything scrolled', sizes.every((s) => s.onScreen),
        sizes.map((s) => `${s.width} by ${s.height}: warning ${s.onScreen ? 'on screen' : 'OFF SCREEN'} at ${s.box} (page scrolled ${s.pageY} px, panel ${s.panelTop} px, the SERVER row itself ${s.rowOnScreen ? 'on screen' : 'out of sight'})`).join('; '));

      // 4. The server comes back: the warning goes and its copy catches up.
      own = await startServer({ port: SERVER_PORT });
      backAt = Date.now();
      await page.waitFor(() => { const s = window.fcLaunch.parts.log.status(); return !s.alerts.server && s.server.state === 'saving' && s.server.pending === 0; }, { timeout: 20000, interval: 50, message: 'the server copy did not catch up' });
      const caughtMs = Date.now() - backAt;
      // The page draws a few times a second.
      await sleep(400);
      st = await logStatus(page);
      const picked = await readOpfs(page, (await fakeCounts(page)).pickedName);
      const serverText = readServerLog(st.server.name);
      const cmp = compareLog(serverText, CAPTURE_LINES.slice(0, 56));
      check('server: when the server is back the warning clears and its copy catches up', cmp.ok && serverText === picked && caughtMs < BUSY_MS && !(await barLine(page, 'fcl-server-alert')).shown,
        `${caughtMs} ms after it started again: flight-logs/${st.server.name} has ${cmp.data.length} lines${cmp.ok ? ', every one in order' : `, ${cmp.problems.join('; ')}`}, ${serverText === picked ? 'the same bytes as the disk file' : 'DIFFERENT from the disk file'}`);
      check('server: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
      await page.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page.evaluate(() => window.fcLaunch.parts.log.flush());
    } finally {
      await browser.close();
      await own.stop();
    }
  }

  // ------------------------------------------------------------------
  // tabs: launch-mode.bat run twice opens a second tab
  // ------------------------------------------------------------------
  if (WANT.includes('tabs')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const a = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await connectFresh(a);
      await sendLines(a, CAPTURE_LINES.slice(0, 6));
      noteFiles(await logStatus(a));
      const b = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      const loadedAt = Date.now();
      await b.waitFor(() => window.fcLaunch.parts.log.status().link.otherTab, { timeout: 8000, interval: 50, message: 'the second tab did not see that the first one is connected' });
      const sawMs = Date.now() - loadedAt;
      await sleep(600);
      const note = await barLine(b, 'fcl-receiver-alert');
      await b.screenshot(path.join(OUT, 'tabs-second-tab.png'));
      said.push(note.text);
      check('tabs: a second launch tab says that another tab has the receiver',
        note.shown && note.onScreen && note.kind === 'warn' && note.tag === 'OTHER TAB' && note.text === 'Another launch tab on this laptop is connected to the receiver. Use that tab and close this one.',
        `${sawMs} ms after it loaded. ${note.tag}: "${note.text}" (${note.box})`);
      // CONNECT there: no save box, no port list, no file.
      await b.click('#bc-connect');
      await sleep(1500);
      const tried = await b.evaluate(() => ({
        picker: window.__fake.pickerCalls,
        request: window.__fake.requestCalls,
        opens: window.__fake.openTries,
        logs: window.fcLaunch.parts.log.status().logs.length,
        asked: window.fcLaunch.parts.log.status().asked,
        link: window.fcLaunch.ctx.live.link.link,
      }));
      const played = await b.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      const stillNote = await barLine(b, 'fcl-receiver-alert');
      check('tabs: CONNECT in the second tab shows no save box, makes no file and opens nothing',
        tried.picker === 0 && tried.request === 0 && tried.opens === 0 && tried.logs === 0 && !tried.asked && tried.link === 'idle' && stillNote.tag === 'OTHER TAB' && played.ok === false && /^Another launch tab/.test(played.reason),
        `save box ${tried.picker} times, port list ${tried.request} times, ${tried.opens} opens, ${tried.logs} logs, link ${tried.link}; the note stays; a test capture there answers "${played.reason}"`);
      // The first tab closes: the second one works as usual.
      const closedAt = Date.now();
      await a.close();
      await b.waitFor(() => !window.fcLaunch.parts.log.status().link.otherTab, { timeout: 10000, interval: 50, message: 'the second tab did not see the first one go' });
      const freeMs = Date.now() - closedAt;
      await sleep(400);
      const freeNote = await barLine(b, 'fcl-receiver-alert');
      await connectFresh(b);
      await sendLines(b, CAPTURE_LINES.slice(0, 6));
      const stB = await settled(b, { browserLines: 6 });
      noteFiles(stB);
      const cB = await fakeCounts(b);
      const offer = await b.evaluate(() => !document.getElementById('fc-recover').hidden);
      check('tabs: once the first tab is closed the second one connects as usual',
        !freeNote.shown && cB.pickerCalls === 1 && cB.requestCalls === 1 && stB.link.locks.includes('fc-launch-receiver') && stB.server.lines === 6 && stB.file.lines === 6,
        `the note went ${freeMs} ms after the first tab closed; then CONNECT: save box ${cB.pickerCalls} time, port list ${cB.requestCalls} time, 6 lines in every copy, this tab holds ${stB.link.locks.join(', ')}; RECOVER for the first tab's recording offered: ${offer}`);
      check('tabs: no exceptions', b.exceptions().length === 0, `${b.exceptions().length} exceptions`);
      await b.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // files: the flight's file waits for the flight, and names never repeat
  // ------------------------------------------------------------------
  if (WANT.includes('files')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const diskRow = (page) => page.evaluate(() => ({
        main: document.querySelector('#fcl-log-disk .fcl-log-main')?.textContent ?? '',
        file: document.querySelector('#fcl-log-disk .fcl-log-file')?.hidden ? '' : document.querySelector('#fcl-log-disk .fcl-log-file')?.textContent ?? '',
        choose: !document.getElementById('fcl-log-choose')?.hidden,
        msg: document.getElementById('fcl-log-msg')?.hidden ? '' : document.getElementById('fcl-log-msg')?.textContent ?? '',
      }));
      // 1. A save box that outlasts the click: the file is picked, and the
      // port is not open yet ("press CONNECT again").
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page.evaluate(() => { window.__fake.pickerDelayMs = 5600; });
      await page.click('#bc-connect');
      // No looking in the meantime (see the connect check).
      await sleep(7500);
      const waiting = await logStatus(page);
      const pickedName = (await fakeCounts(page)).pickedName;
      // A test capture plays before the real connection.
      const played = await page.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      await sleep(700);
      const afterTest = await logStatus(page);
      const rowTest = await diskRow(page);
      await page.screenshot(path.join(OUT, 'files-flight-file-waits.png'));
      noteFiles(afterTest);
      check('files: a file picked before the port opened is not taken by a test capture',
        waiting.file.state === 'ready' && waiting.file.waiting === pickedName && played.ok && afterTest.kind === 'test' && afterTest.file.state === 'none' && afterTest.logs[0].file === '' && afterTest.file.waiting === pickedName &&
        rowTest.main === 'NONE FOR THIS TEST. THE FLIGHT\'S FILE IS READY' && rowTest.file === pickedName && !rowTest.choose,
        `picked ${pickedName} with the port still closed; the capture played ${played.sent} lines; its log has ${afterTest.logs[0].file ? `the file ${afterTest.logs[0].file}` : 'no disk file'}; the DISK FILE row reads "${rowTest.main}" with "${rowTest.file}" under it`);
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the second CONNECT did not open the port' });
      await sendLines(page, CAPTURE_LINES.slice(0, 10));
      let st = await settled(page, { browserLines: 10 });
      noteFiles(st);
      const c1 = await fakeCounts(page);
      const flightCmp = compareLog(await readOpfs(page, pickedName), CAPTURE_LINES.slice(0, 10));
      check('files: the flight log then gets that file', st.kind === 'flight' && st.file.state === 'saving' && st.file.name === pickedName && st.file.waiting === null && flightCmp.ok && c1.pickerCalls === 1,
        `${st.file.name}: ${flightCmp.data.length} lines${flightCmp.ok ? ', the flight\'s own and nothing from the test' : `, ${flightCmp.problems.join('; ')}`}; save box ${c1.pickerCalls} time`);
      await page.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      const names = [...c1.names];
      await page.close();

      // 2. CHOOSE FILE after a finished test picks the flight's file.
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page2.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      await sleep(700);
      noteFiles(await logStatus(page2));
      const rowDone = await diskRow(page2);
      await page2.click('#fcl-log-choose');
      await page2.waitFor(() => window.fcLaunch.parts.log.status().file.waiting, { timeout: 10000, message: 'CHOOSE FILE after the test picked nothing for the flight' });
      const chosen = await logStatus(page2);
      const c2 = await fakeCounts(page2);
      const rowChosen = await diskRow(page2);
      await page2.screenshot(path.join(OUT, 'files-choose-after-test.png'));
      await page2.click('#bc-connect');
      await page2.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'CONNECT did not open the port' });
      await sendLines(page2, CAPTURE_LINES.slice(0, 6));
      st = await settled(page2, { browserLines: 6 });
      noteFiles(st);
      const c3 = await fakeCounts(page2);
      said.push(rowDone.msg);
      check('files: CHOOSE FILE after a finished test picks the file for the flight to come',
        rowDone.choose && rowDone.main === 'NONE FOR THIS TEST' && /^flight-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.log$/.test(c2.names[0]) && chosen.kind === 'test' && chosen.logs[0].file === '' && chosen.file.waiting === c2.pickedName &&
        rowChosen.file === c2.pickedName && !rowChosen.choose && c3.pickerCalls === 1 && st.kind === 'flight' && st.file.name === c2.pickedName && st.file.lines === 6,
        `after the test: "${rowDone.main}", CHOOSE FILE shown, "${rowDone.msg}"; the save box suggested ${c2.names[0]}; the test log still has no file; CONNECT asked for no second file (${c3.pickerCalls} save box) and the flight log writes to ${st.file.name} (${st.file.lines} lines)`);
      names.push(...c3.names);
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page2.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page2.close();

      // 3. A quick restart in the same minute: the save box never suggests
      // a name it suggested before (this browser's profile remembers them).
      for (let round = 0; round < 2; round += 1) {
        const p = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
        await connectFresh(p);
        noteFiles(await logStatus(p));
        names.push(...(await fakeCounts(p)).names);
        await p.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
        await p.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
        await p.close();
      }
      const minute = (n) => /^flight-(\d{4}-\d{2}-\d{2}-\d{4})/.exec(n)?.[1];
      const repeats = names.filter((n, i) => names.indexOf(n) !== i);
      const sameMinute = names.filter((n) => minute(n) === minute(names.at(-1)));
      const numbered = sameMinute.length < 2 || /^flight-\d{4}-\d{2}-\d{2}-\d{4}-\d+\.log$/.test(names.at(-1));
      check('files: the save box never suggests the same name twice', names.length === 4 && repeats.length === 0 && names.every((n) => /^flight-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.log$/.test(n)) && numbered,
        `four visits in this profile were offered ${names.join(', ')}${repeats.length ? `. REPEATED: ${repeats.join(', ')}` : ''}`);

      // 4. A cancelled save box does not use a name up.
      const page3 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page3.evaluate(() => { window.__fake.pickerMode = 'cancel'; });
      await connectFresh(page3);
      noteFiles(await logStatus(page3));
      await page3.evaluate(() => { window.__fake.pickerMode = 'opfs'; });
      // The status draws a few times a second, so the button shows a moment
      // after the port opened.
      await page3.waitFor(() => !document.getElementById('fcl-log-choose').hidden, { timeout: 10000, message: 'CHOOSE FILE did not show after the cancelled save box' });
      await page3.click('#fcl-log-choose');
      await page3.waitFor(() => window.fcLaunch.parts.log.status().file.state === 'saving', { timeout: 10000, message: 'CHOOSE FILE did not give the log a file' });
      const c4 = await fakeCounts(page3);
      check('files: a cancelled save box does not use its name up', c4.names.length === 2 && c4.names[0] === c4.names[1] && !names.includes(c4.names[0]),
        `cancelled at ${c4.names[0]}, then CHOOSE FILE offered ${c4.names[1]}`);
      check('files: no exceptions', page3.exceptions().length === 0, `${page3.exceptions().length} exceptions`);
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page3.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page3.close();

      // 5. CHOOSE FILE after a finished test, and the box is cancelled:
      // nothing is settled, so CONNECT still asks where to save.
      const page4 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page4.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      await sleep(700);
      noteFiles(await logStatus(page4));
      await page4.evaluate(() => { window.__fake.pickerMode = 'cancel'; });
      await page4.click('#fcl-log-choose');
      await page4.waitFor(() => window.__fake.pickerCalls === 1, { timeout: 10000, message: 'CHOOSE FILE did not open the save box' });
      await sleep(500);
      const cancelled = await logStatus(page4);
      const rowCancelled = await diskRow(page4);
      await page4.evaluate(() => { window.__fake.pickerMode = 'opfs'; });
      await connectFresh(page4);
      await sendLines(page4, CAPTURE_LINES.slice(0, 4));
      const st4 = await settled(page4, { browserLines: 4 });
      noteFiles(st4);
      const c5 = await fakeCounts(page4);
      check('files: a CHOOSE FILE box cancelled after a test does not stop CONNECT from asking',
        !cancelled.asked && cancelled.file.waiting === null && rowCancelled.choose && rowCancelled.main === 'NONE FOR THIS TEST' &&
        c5.pickerCalls === 2 && st4.kind === 'flight' && st4.file.state === 'saving' && st4.file.name === c5.pickedName && st4.file.lines === 4,
        `after the cancelled box: "${rowCancelled.main}", CHOOSE FILE still shown, "${rowCancelled.msg}"; then CONNECT showed the save box (${c5.pickerCalls} in all) and the flight log writes to ${st4.file.name} (${st4.file.lines} lines)`);
      await page4.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // recover: RECOVER pressed after CONNECT
  // ------------------------------------------------------------------
  if (WANT.includes('recover')) {
    const profile = path.join(OUT, `profile-v-${process.pid}`);
    profiles.push(profile);
    const STATUS_ONLY = CAPTURE_LINES.filter((l) => l.startsWith('# DEKEL_RX'));
    const samplesOf = (page) => page.evaluate(() => {
      const live = window.fcLaunch.ctx.live;
      const s = live.stores.flight?.getRocket('1')?.samples ?? [];
      return { n: s.length, seqs: s.map((x) => x.extra.seq), restarts: live.flightFeed?.counts.restarts ?? 0 };
    });
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await connectFresh(page);
      await sendLines(page, CAPTURE_LINES.slice(0, 60), { gapMs: 300 });
      await page.waitFor(() => window.fcLaunch.parts.log.status().browser.lines === 60, { timeout: 10000, message: 'the browser copy did not reach 60 lines' });
      noteFiles(await logStatus(page));
      await browser.kill();

      // 1. CONNECT first, then RECOVER while only status lines have come.
      browser = await launchChrome({ network: 'blocked', userDataDir: profile });
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page2.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed' });
      await connectFresh(page2);
      // The receiver prints its status line all along, twice a second
      // here, and hears no packet.
      await page2.evaluate((line) => {
        window.__beats = 0;
        window.__beat = setInterval(() => {
          window.__fake.port.send(`${line}\r\n`);
          window.__beats += 1;
        }, 500);
      }, STATUS_ONLY[0]);
      await page2.waitFor(() => window.fcLaunch.parts.log.status().lines >= 4, { timeout: 10000, message: 'the status lines did not arrive' });
      const beforeRecover = await samplesOf(page2);
      await recover(page2, path.join(OUT, 'recover-after-connect-offer.png'));
      await page2.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 15000, message: 'the recording did not go back on the live view with the port open' });
      await sleep(500);
      const beats = await page2.evaluate(() => {
        clearInterval(window.__beat);
        return window.__beats;
      });
      await sleep(300);
      const backOn = await samplesOf(page2);
      const st2 = await logStatus(page2);
      const told = await barLine(page2, 'fcl-receiver-alert');
      await page2.screenshot(path.join(OUT, 'recover-after-connect.png'));
      said.push(told.text);
      // New packets carry the same flight on.
      await sendLines(page2, CAPTURE_LINES.slice(60, 80));
      await page2.waitFor(() => window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples.length === 40, { timeout: 10000, message: 'the new packets did not join the recovered flight' });
      const carried = await samplesOf(page2);
      const continuous = carried.seqs.every((q, i) => i === 0 || q === carried.seqs[i - 1] + 1);
      noteFiles(await logStatus(page2));
      check('recover: RECOVER after CONNECT puts the flight back while no packet has come yet',
        beforeRecover.n === 0 && backOn.n === 30 && st2.restored?.lines === 60 && st2.open && st2.lines === beats && told.tag === 'RECOVERED' &&
        told.text === '60 lines from the recovered recording are back on the live view. The flight carries on from here.' && carried.n === 40 && continuous && carried.restarts === 0,
        `port open with status lines coming in and ${beforeRecover.n} packets, then RECOVER: ${st2.restored?.lines} lines played back, rocket 1 has ${backOn.n} samples, and the log has the ${beats} status lines the receiver sent and no more (${st2.lines}, nothing logged twice). ${told.tag}: "${told.text}" Then 10 new packets: ${carried.n} samples, sequence ${carried.seqs[0]} to ${carried.seqs.at(-1)} with ${continuous ? 'no gap' : 'a GAP'}, ${carried.restarts} restarts`);
      const secondLines = beats + 20;
      await page2.waitFor((want) => window.fcLaunch.parts.log.status().browser.lines === want, { timeout: 10000, args: [secondLines], message: 'the browser copy did not get every line of the second connection' });
      await browser.kill();

      // 2. CONNECT, packets on the live view, then RECOVER: it stays in
      // SAVED FLIGHTS, and the page says why.
      browser = await launchChrome({ network: 'blocked', userDataDir: profile });
      const page3 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page3.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed the second time' });
      await connectFresh(page3);
      await sendLines(page3, CAPTURE_LINES.slice(80, 90));
      await page3.waitFor(() => window.fcLaunch.ctx.live.stores.flight?.getRocket('1')?.samples.length === 5, { timeout: 10000, message: 'the new packets did not reach the live view' });
      // The receiver keeps printing its status line meanwhile.
      await page3.evaluate((line) => { window.__beat = setInterval(() => window.__fake.port.send(`${line}\r\n`), 500); }, STATUS_ONLY[0]);
      const { name } = await recover(page3, null);
      await page3.waitFor(() => window.fcLaunch.parts.log.status().alerts.receiver?.tag === 'RECOVERED', { timeout: 10000, message: 'the page did not say what happened to the recovered recording' });
      await sleep(400);
      const kept = await barLine(page3, 'fcl-receiver-alert');
      const st3 = await logStatus(page3);
      const after3 = await samplesOf(page3);
      const panelMsg = await page3.evaluate(() => document.getElementById('fcl-log-msg')?.textContent ?? '');
      const inSaved = (await savedFlights(page3)).find((r) => r.title === name);
      await page3.screenshot(path.join(OUT, 'recover-kept-in-saved-flights.png'));
      said.push(kept.text);
      noteFiles(st3);
      check('recover: with packets already on the live view, RECOVER says where the recording is and why',
        st3.restored === null && after3.n === 5 && inSaved?.lines.length === secondLines && kept.shown && kept.onScreen && panelMsg === kept.text &&
        kept.text === `The recovered recording is saved in SAVED FLIGHTS as "${name}". It was not put back on the live view, because the live view already has data from this visit, and the two would mix. Open it from SAVED FLIGHTS to see it.`,
        `"${kept.text}" (${kept.box}); the live view still has its own ${after3.n} samples; "${inSaved?.title}" in SAVED FLIGHTS has ${inSaved?.lines.length} lines`);
      await page3.evaluate(() => clearInterval(window.__beat));
      check('recover: no exceptions', page3.exceptions().length === 0, `${page3.exceptions().length} exceptions`);
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // clock: Windows sets the clock back during the flight
  // ------------------------------------------------------------------
  if (WANT.includes('clock')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
      await page.waitFor(() => window.fcLaunch.parts.capture.status().playing, { timeout: 30000, message: 'the capture never started' });
      noteFiles(await logStatus(page));
      await giveOpfsFile(page, 'opfs-clock-check.log');
      await page.waitFor(() => window.fcLaunch.parts.capture.status().sent >= 8 && window.fcLaunch.parts.log.status().file.lines >= 6, { timeout: 20000, message: 'the capture did not get going' });
      const look = () => page.evaluate(() => {
        const c = window.fcLaunch.parts.capture.status();
        const s = window.fcLaunch.parts.log.status();
        return { sent: c.sent, file: s.file.lines, server: s.server.lines, browser: s.browser.lines, ago: s.file.lastWriteAgoMs, row: document.querySelector('#fcl-log-disk .fcl-log-main')?.textContent ?? '', rec: document.getElementById('fc-rec-time')?.textContent ?? '' };
      });
      const before = await look();
      // The computer's clock goes back an hour, as a time sync can do.
      await page.evaluate(() => {
        const real = Date.now.bind(Date);
        Date.now = () => real() - 3600000;
      });
      const looks = [];
      for (let i = 0; i < 9; i += 1) {
        await sleep(1000);
        looks.push(await look());
      }
      const tail = looks.slice(1);
      const behind = (key) => Math.max(...tail.map((l) => l.sent - l[key]));
      const ages = tail.map((l) => l.ago);
      const last = looks.at(-1);
      noteFiles(await logStatus(page));
      // Every line sent in those 9 s has to reach every copy. A copy that
      // waits for the clock to catch up would stand still for the hour. (On
      // a busy laptop a copy can be some lines behind for a moment, so the
      // check is that it gets there, and the numbers say how close it stayed.)
      const reached = await page.waitFor((want) => {
        const s = window.fcLaunch.parts.log.status();
        return s.file.lines >= want && s.server.lines >= want && s.browser.lines >= want;
      }, { timeout: 15000, args: [last.sent], message: 'a copy stood still after the clock was set back' }).then(() => true, () => false);
      const end = await look();
      check('clock: with the clock set back an hour every copy keeps up',
        reached && last.sent >= before.sent + 10 && !/-/.test(last.rec),
        `${last.sent - before.sent} lines came in the 9 s after the step, and ${reached ? 'every copy got all of them' : `NOT every copy got them (disk file ${end.file}, server ${end.server}, browser ${end.browser} of ${last.sent})`}. In those 9 s the disk file was at most ${behind('file')} lines behind, the server copy ${behind('server')} and the browser copy ${behind('browser')}, and the disk file's newest write at most ${Math.max(...ages)} ms old; the row read "${last.row}" and REC ${last.rec}`);
      await page.evaluate(() => window.fcLaunch.parts.capture.stop());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('normal')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/index.html?track', { fake: true });
      const bare = await page.evaluate(() => ({
        hub: typeof window.fcLaunch,
        panel: Boolean(document.getElementById('fc-launch-panel')),
        banner: Boolean(document.getElementById('fcl-test-banner')),
        log: Boolean(document.getElementById('fcl-log-lines')),
      }));
      await page.click('#bc-connect');
      await page.waitFor(() => document.getElementById('bc-connect').dataset.state === 'open', { timeout: 10000, message: 'the port did not open on the normal page' });
      // Ten lines a second for six seconds, like a busy board.
      for (let i = 0; i < 60; i += 1) {
        await page.evaluate((line) => window.__fake.port.send(`${line}\r\n`), CAPTURE_LINES[i]);
        await sleep(100);
      }
      await sleep(2500);
      const chunks = await page.evaluate(() => new Promise((resolve, reject) => {
        const req = indexedDB.open('dogtooth-flight-console');
        req.onsuccess = () => {
          const tx = req.result.transaction(['chunks', 'flights'], 'readonly');
          const all = tx.objectStore('chunks').getAll();
          const flights = tx.objectStore('flights').getAll();
          tx.oncomplete = () => resolve({ chunks: all.result.map((c) => c.lines.length), flights: flights.result.map((f) => f.status) });
        };
        req.onerror = () => reject(req.error);
      }));
      const fake = await page.evaluate(() => ({ picker: window.__fake.pickerCalls, request: window.__fake.requestCalls }));
      const launchRequests = page.requests().filter((r) => r.url.includes('/launch-mode/') || r.url.includes('/launch/'));
      check('normal: no launch mode on the normal page', bare.hub === 'undefined' && !bare.panel && !bare.banner && !bare.log && fake.picker === 0 && fake.request === 1 && launchRequests.filter((r) => r.url.includes('/launch-mode/')).length === 0,
        `fcLaunch ${bare.hub}, launch panel ${bare.panel}, test banner ${bare.banner}, log status ${bare.log}, save box ${fake.picker} times, port list ${fake.request} time, requests to /launch-mode/: ${launchRequests.filter((r) => r.url.includes('/launch-mode/')).length}`);
      const total = chunks.chunks.reduce((a, b) => a + b, 0);
      check('normal: the recorder still writes a chunk every 2 s', total === 60 && chunks.chunks.length >= 3 && chunks.chunks.length <= 5,
        `60 lines over 6 s went into ${chunks.chunks.length} chunks of ${chunks.chunks.join(', ')} lines (2 s chunks give 3 or 4; the launch page's 250 ms would give about 24)`);
      // Six seconds of silence on an open port: the launch page's warnings
      // stay away, and no launch lock is held.
      await sleep(3500);
      const quietPage = await page.evaluate(async () => ({
        alerts: document.querySelectorAll('.fcl-alert').length,
        note: document.getElementById('fc-link-note-box').hidden ? '' : document.getElementById('bc-link-note').textContent,
        locks: ((await navigator.locks.query()).held ?? []).map((l) => l.name).filter((n) => n.startsWith('fc-launch')),
        names: localStorage.getItem('fc-launch-log-names'),
      }));
      // The receiver's radio did not start: the normal page's words are the old ones.
      await page.evaluate(() => window.__fake.port.send('# DEKEL_RX radio-failed error=-2 good=0 bad=0 rx_up_s=5.0\r\n'));
      await sleep(400);
      const radioNote = await page.evaluate(() => document.getElementById('bc-link-note').textContent);
      // The cable comes out and goes back in: the name box, the old note,
      // and nothing reconnects by itself.
      await page.evaluate(() => window.__fake.unplug());
      await saveNameBox(page);
      const triesBefore = await page.evaluate(() => window.__fake.openTries);
      await page.evaluate(() => window.__fake.replug());
      await sleep(4500);
      const afterReplug = await page.evaluate(() => ({
        state: document.getElementById('bc-connect').dataset.state,
        button: document.getElementById('bc-connect-text').textContent,
        tries: window.__fake.openTries,
        note: document.getElementById('bc-link-note').textContent,
      }));
      check('normal: no reconnecting, no warnings, no locks and the old words on the normal page',
        quietPage.alerts === 0 && quietPage.locks.length === 0 && quietPage.names === null &&
        radioNote === 'Radio board receiver is connected, but its radio didn\'t start (error -2). It can\'t hear the rocket until that is fixed.' &&
        afterReplug.state === 'lost' && afterReplug.button === 'CONNECT' && afterReplug.tries === triesBefore &&
        afterReplug.note === 'The board was unplugged or stopped answering. Plug it back in and press CONNECT.',
        `after 6 s of silence: ${quietPage.alerts} launch warnings, note "${quietPage.note}", launch locks: ${quietPage.locks.join(', ') || 'none'}; radio-failed note "${radioNote}"; 4.5 s after a replug: link ${afterReplug.state}, button ${afterReplug.button}, ${afterReplug.tries - triesBefore} opens tried, note "${afterReplug.note}"`);
      await page.click('#bc-connect');
      await page.waitFor(() => document.getElementById('bc-connect').dataset.state === 'open', { timeout: 10000, message: 'CONNECT did not open the port again on the normal page' });
      // The receiver's newer firmware on the normal page: its plain lines
      // are read on the launch page only, so nothing is said here.
      await page.evaluate((part) => { window.__fake.port.send(`${part.join('\r\n')}\r\n`); }, [...RX_START, RX_RADIO_DEAD, 'Error: No packets received for 13 s']);
      await sleep(400);
      const plainNote = await page.evaluate(() => (document.getElementById('fc-link-note-box').hidden ? '' : document.getElementById('bc-link-note').textContent));
      check('normal: the receiver\'s plain lines put no note under the bar on the normal page', plainNote === '', `after its start-up report, a radio line and a waiting line the note reads "${plainNote}"`);
      await page.evaluate((line) => window.__fake.port.send(`${line}\r\n`), CAPTURE_LINES[60]);
      await sleep(300);
      await page.evaluate(() => document.getElementById('bc-connect').click());
      await saveNameBox(page);
      if (fullServerLog) {
        await page.setFiles('input.fc-file-input', [serverCopyFile()]);
        await page.waitFor(() => location.search.includes('flight=local-'), { timeout: 20000, message: 'LOAD FILE did not open the flight on the normal page' });
        const loaded = await page.evaluate(() => document.getElementById('fc-file-text')?.textContent ?? '');
        check('normal: LOAD FILE takes a launch flight log on the normal page too', /Loaded /.test(loaded), loaded);
      }
      check('normal: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    } finally {
      await browser.close();
    }
  }

  // Every sentence the checks above read off the page.
  if (said.length) {
    const bad = said.filter((t) => !t || !plain(t));
    check('words: what the page said follows the writing rules', bad.length === 0,
      `${said.length} sentences read off the page, ${bad.length} with a dash, a semicolon, an "&" or a colon phrase${bad.length ? `: ${bad.map((t) => `"${t}"`).join(' | ')}` : ''}`);
  }
} catch (err) {
  check('the run itself', false, err.stack ?? String(err));
} finally {
  await server.stop();
  // The files this run made in flight-logs/: exactly the ones its pages
  // named. Other programs may be writing there at the same time, so
  // nothing else is touched.
  let deleted = 0;
  for (const name of made) {
    if (logsBefore.has(name) || !fs.existsSync(path.join(LOGS, name))) continue;
    try {
      fs.unlinkSync(path.join(LOGS, name));
      deleted += 1;
    } catch (err) {
      console.log(`could not delete flight-logs/${name}: ${err.message}`);
    }
  }
  const others = (fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []).filter((n) => !logsBefore.has(n));
  console.log(`flight-logs/: deleted the ${deleted} files this run made.${others.length ? ` New files from something else, left alone: ${others.join(', ')}` : ''}`);
  for (const p of profiles) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* a file still held */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length} of ${results.length} checks passed. Pictures in ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
