// acceptance.mjs
// The launch day acceptance test for launch mode. One command runs the
// whole check list for the Flight Console's launch page
// (flight-console/launch.html) in real headless Chromes, then the other
// test suites, and prints one PASS or FAIL line per check with the real
// numbers. It ends with every request the page tried to send to the
// internet, and with exit code 0 only when every check passed.
//
// Run it from the website folder, with the laptop awake (the times it took
// on a quiet laptop are in launch-mode/test/README.md):
//
//   node launch-mode/test/acceptance.mjs
//   node launch-mode/test/acceptance.mjs --shots C:/some/folder
//   node launch-mode/test/acceptance.mjs --skip unit,browser,logger
//   node launch-mode/test/acceptance.mjs --only start,maps,capture
//
// THE STAND-IN PORT. Headless Chrome has no serial ports and can't show a
// save box. The checks that press CONNECT (6 and 8 to 12) put a stand-in
// for navigator.serial and the save box in the page before its own code
// runs (see FAKE below). The page's serial-link.js reads the stand-in's
// stream exactly as it reads a real port, so CONNECT, the reader, the
// flight log and the reconnect all run as they do at the field. Nothing
// here was tested with the real receiver or the real save box.
//
// THE CHECKS (the names are what --only and --skip take)
//   With every host but this laptop blocked (like Wi-Fi off), 1366 by 768,
//   a fresh Chrome profile:
//   start     1. launch.html?track starts, the launch panel has the field's
//                center as the ground station, no page exceptions, and how
//                long it took
//   maps      2. the 3D view is ready with no Cesium ion and flat ground, and
//                its saved tiles come from /offline-maps/crmrc/ with no
//                failures. The 2D map (SATELLITE) loads saved tiles around
//                the field at two zooms with no failures. From high up, the
//                saved box shows imagery and the ground outside it is plain.
//                Pictures of each.
//   capture   3. the test capture (test/radio-board-rx-capture.log) at 20
//                times real speed, moved to the field, through the live
//                path: every PKT line reaches the flight store, the board is
//                on the live view at the field, nothing uses the replay path
//   log       4. the flight log: the server copy in flight-logs/ has every
//                line in order with a valid time, a file from the browser's
//                private file system (useFileHandle) gets the same bytes, and
//                IndexedDB has every line
//   panel     5. the recovery panel: the last PKT line's position to 6
//                decimals, its altitude, range and bearing within 1 m and 0.1
//                degree of an independent great circle, the age counts up,
//                COPY COORDINATES copies the exact text, OPEN IN MAPS hidden
//   restore   6. CONNECT on the stand-in port and the capture's lines at
//                real pace (a status line and a packet each second), then
//                (a) the tab closed and (b) Chrome killed about a second
//                after the last packet, then the page opened again on the
//                same profile. BEFORE RECOVER is pressed the panel shows the
//                last packet's fix with the time it really arrived, and says
//                to press RECOVER. After the kill the disk file and the
//                server copy have every line but the last seconds. RECOVER
//                brings back every line, the panel shows the fix with its
//                real time, the recording is in SAVED FLIGHTS. Also a plain
//                reload after the capture shows the SAVED FIX.
//   replay    7. the server copy from check 4 loads with LOAD FILE (the real
//                file input) and replays with as many samples as the capture
//                has packets. So does flight-logs/backup-sample-from-test.log
//                (the backup logger's format) when it is there.
//   One more page with the stand-in port, CONNECT pressed once, and the
//   capture's lines sent through it. Checks 8 to 11 are its steps in order:
//   silent    8. the port is open and sends nothing: no warning after 6 s
//                (a healthy receiver prints its first lines by then), the NO
//                DATA warning under the bar within about 10 s, and it clears
//                when the first line arrives
//   badfix    9. after six good packets, a fix=yes packet 50 km away and
//                one at 0, 0: the readout, COPY COORDINATES and the saved
//                fix in localStorage stay on the good fix, and the next
//                good packet is the current fix again
//   reconnect 10. the cable comes out and goes back in: the page says the
//                port was lost, opens it again by itself with nothing
//                clicked, and every line sent before and after is in all
//                three copies, in order, in the same files
//   server    11. the test's own server is stopped (by its process ID) while
//                lines keep coming: the SERVER STOPPED warning shows, the
//                disk file and the browser copy keep saving. Then it is
//                started again on the same port: the warning clears and the
//                server copy catches up with no line lost or doubled.
//   ground   12. a flight first heard in the air (the first packets climb
//                at 60 m/s): the flight store takes the ground height from
//                launch-mode/field.json (groundElevM), not config.js's 700
//                m, so ABOVE GROUND is the GPS altitude minus the field's
//   tarpit   13. the same start and capture with connections that open and
//                never answer: the start, the 3D view and the capture stay
//                within a few seconds of the blocked run
//   requests 14. every request that tried to reach the internet in every
//                run above: host, path, count, which part of the page made
//                it and what happened to it
//   With the internet open, on http://localhost:8000 (the map keys only
//   work there) through another address of this laptop (--online-host):
//   online   15. Esri's photos show outside the saved box in the 3D view
//                and on the 2D map (tile requests answer 200, and a picture
//                from high up has imagery inside and outside the box), and
//                the saved tiles are still used inside it
//   normal   16. the normal page (index.html?track): no launch panel, no
//                window.fcLaunch, nothing from /offline-maps/, /launch-mode/
//                or /flight-console/vendor/, Cesium and Leaflet from their
//                CDNs
//   The other suites:
//   unit         node --test "flight-console/test/*.test.mjs"
//   browser      flight-console/test/launch-panel-browser.mjs,
//                launch-log-browser.mjs, launch-restore-browser.mjs and
//                map-names-browser.mjs, each on its own port after --port
//   logger       python launch-mode/test/backup_logger_test.py --quick, then
//                the serial ports. If a receiver board is plugged in, the
//                backup logger runs on its COM port for about 10 seconds and
//                the first lines it saved are printed. With no board it says
//                so and moves on (that is not a failure).
//
// OPTIONS
//   --port N            the test server's port (default 8131, never 8000).
//                       The other browser suites use N+1 to N+4.
//   --online-host ADDR  the address of this laptop the online check's server
//                       listens on, port 8000 (default 127.0.0.4). Never
//                       127.0.0.1 or ::1: those belong to the real server.
//   --shots DIR         where the pictures and the suites' output go
//                       (default %TEMP%/fc-launch-acceptance). Look at the
//                       pictures: a check that only reads numbers can pass on
//                       a broken picture.
//   --skip-online       skips 15 and 16, the checks that need the internet
//   --only LIST         runs only these checks (comma separated names)
//   --skip LIST         runs everything but these
//   --com PORT          the receiver's COM port for the logger check, when
//                       more than one USB serial port is plugged in
//
// THE SERVER CHECK stops and starts the test's own server on --port. It
// only ever ends the process it started itself. When something else
// already serves that port, the check fails and says so, and nothing is
// stopped.
//
// CLEANING UP. It stops the servers and Chromes it started (cdp.mjs ends
// them even if this test throws), removes its Chrome profiles, and deletes
// the files its own pages and the other suites' pages wrote in flight-logs/.
// It knows them by name: the names the pages gave, and the names in the
// append requests its servers answered (every server here, the suites'
// included, runs with --verbose). Nothing else in flight-logs/ is touched,
// and offline-maps/ is only read.
//
// Exit code: 0 when every check passed, 1 when one failed, 2 when the test
// itself could not run. Built on cdp.mjs (see the top of that file).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, launchChrome, sleep, ROOT, isExternalUrl } from './cdp.mjs';
import { planCapture } from '../../flight-console/js/launch/capture-plan.js';
// The ground height the normal page falls back on (700 m, the simulator's
// site). Check 12 prints it next to the field's.
import { GROUND_ELEV_FALLBACK_M } from '../../flight-console/js/config.js';

// ------------------------------------------------------------------
// Options
// ------------------------------------------------------------------
const GROUPS = {
  start: '1. The launch page starts with the internet blocked',
  maps: '2. Both maps show the saved imagery around the field',
  capture: '3. The test capture goes through the live path',
  log: '4. The flight log is saved',
  panel: '5. The recovery panel',
  restore: '6. Closing and opening the page again',
  replay: '7. A saved log replays',
  silent: '8. A connected port that sends nothing',
  badfix: '9. Packets that must not take the fix',
  reconnect: '10. A lost port is opened again by the page',
  server: '11. The local server stopped and started again',
  ground: '12. A flight first heard in the air',
  tarpit: '13. Nothing hangs on a dead connection',
  requests: '14. Requests that tried to reach the internet',
  online: '15. Online imagery outside the saved box',
  normal: '16. The normal page is as before',
  unit: 'The Node unit tests',
  browser: 'The other browser checks',
  logger: 'The backup logger and the receiver board',
};
const NAMES = Object.keys(GROUPS);
// The steps of the one page that checks 8 to 11 share.
const PORT_STEPS = ['silent', 'badfix', 'reconnect', 'server'];

function readArgs(argv) {
  const args = {
    port: 8131,
    onlineHost: '127.0.0.4',
    shots: path.join(os.tmpdir(), 'fc-launch-acceptance'),
    skipOnline: false,
    only: null,
    skip: [],
    com: null,
  };
  const list = (text, name) => {
    const items = String(text).split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      if (!GROUPS[item]) throw new Error(`${name} takes ${NAMES.join(', ')}. I don't know "${item}".`);
    }
    return items;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const need = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${name} needs a value`);
      i += 1;
      return value;
    };
    if (name === '--port') args.port = Number(need());
    else if (name === '--online-host') args.onlineHost = need();
    else if (name === '--shots') args.shots = path.resolve(need());
    else if (name === '--skip-online') args.skipOnline = true;
    else if (name === '--only') args.only = list(need(), '--only');
    else if (name === '--skip') args.skip = list(need(), '--skip');
    else if (name === '--com') args.com = need();
    else if (name === '--help' || name === '-h') args.help = true;
    else throw new Error(`I don't know the option ${name}`);
  }
  // The other suites use the next four ports, so none of the five may be 8000.
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65530 || (args.port <= 8000 && args.port + 4 >= 8000)) {
    throw new Error('--port needs a test port such as 8131, with 8000 not among it and the next four. Port 8000 is the real one.');
  }
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(args.onlineHost) || args.onlineHost === '127.0.0.1') {
    throw new Error('--online-host needs an address of this laptop other than 127.0.0.1, such as 127.0.0.4');
  }
  return args;
}

let ARGS;
try {
  ARGS = readArgs(process.argv.slice(2));
} catch (err) {
  console.error(`acceptance.mjs: ${err.message}`);
  console.error('node launch-mode/test/acceptance.mjs --help shows every option.');
  process.exit(2);
}
if (ARGS.help) {
  const text = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const end = text.findIndex((line) => !line.startsWith('//'));
  console.log(text.slice(0, end).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const want = (name) => (ARGS.only ? ARGS.only.includes(name) : true)
  && !ARGS.skip.includes(name)
  && !(ARGS.skipOnline && (name === 'online' || name === 'normal'));

// ------------------------------------------------------------------
// What the checks compare against
// ------------------------------------------------------------------
const LAUNCH = '/flight-console/launch.html?track';
const LOGS = path.join(ROOT, 'flight-logs');
const CAPTURE_FILE = path.join(ROOT, 'flight-console', 'test', 'radio-board-rx-capture.log');
const CAPTURE_TEXT = fs.readFileSync(CAPTURE_FILE, 'utf8');
const CAPTURE_LINES = CAPTURE_TEXT.split(/\r?\n/).filter((l) => l !== '');
const CAPTURE_PKTS = CAPTURE_LINES.filter((l) => l.startsWith('PKT ')).length;
const FIELD_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch-mode', 'field.json'), 'utf8'));
const FIELD = FIELD_JSON.center;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, FIELD_JSON.tiles.folder, 'manifest.json'), 'utf8'));
const TILES_PATH = `/${FIELD_JSON.tiles.folder.replace(/^\/+|\/+$/g, '')}/`;
// The capture moved so its first fix lands on the field, as the page does it.
const PLAN = planCapture(CAPTURE_TEXT, { target: FIELD, speed: 1 });
const SHIFTED = PLAN.lines;
const LAST_PKT = [...SHIFTED].reverse().find((l) => l.startsWith('PKT '));
const pktField = (line, name) => Number(new RegExp(`\\b${name}=(-?[\\d.]+)`).exec(line)[1]);
const WANT_FIX = { lat: pktField(LAST_PKT, 'lat'), lon: pktField(LAST_PKT, 'lon'), altM: pktField(LAST_PKT, 'alt_m') };
const WANT_COPY = `${WANT_FIX.lat.toFixed(6)}, ${WANT_FIX.lon.toFixed(6)}`;
const BACKUP_SAMPLE = path.join(LOGS, 'backup-sample-from-test.log');
const PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}) > /;

const LAPTOP = { width: 1366, height: 768 };
const GPU = ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
const SEL = {
  satellite: '#fc-map-controls [aria-label="Map view"] button:nth-child(1)',
  three: '#fc-map-controls [aria-label="Map view"] button:nth-child(3)',
};
// How far apart (s) the tarpit run may be from the blocked run.
const TARPIT_SLACK_S = 3;
// The page's own limits (flight-log.js): a port that has sent nothing at
// all is warned about after NO_DATA_MS, 8 s, and a server that stopped
// after SERVER_WARN_MS, 5 s. The checks give each a few seconds on top, and
// print the time it really took.
const NO_DATA_QUIET_MS = 6000;     // still no warning this long after CONNECT
const NO_DATA_LATEST_MS = 11000;   // the warning is up by then
const SERVER_WARN_LATEST_MS = 9000;
const SERVER_BACK_LATEST_MS = 10000;
const RECONNECT_LATEST_MS = 8000;
// Check 6 kills Chrome one second after the last packet. A laptop that
// stalls can make that much later. Past this many ms the session is run
// again on a new profile, at most KILL_TRIES times.
const KILL_LATEST_MS = 2500;
const KILL_TRIES = 3;
// After a kill, a copy that is written about once a second must have every
// line that arrived at least this long (ms) before it.
const KILL_KEPT_MS = 3000;
// The words the checks look for. They are the page's own (recovery-fix.js
// and flight-log.js).
const RECOVER_WORDS = 'The page closed suddenly. Press RECOVER to put the flight back on the live view.';
const SAVED_FIX_KEY = 'fc-launch-last-fix';
// A picture patch with a luminance spread (standard deviation) above this
// shows imagery. Plain ground is one flat color and measures under 1.
const TEXTURE_STD = 4;
const FLAT_STD = 1.5;

// An independent great circle on the same sphere as js/geo.js: the spherical
// law of cosines for the distance, and the bearing from the tangent form.
// geo.js uses the haversine and a different atan2 form.
const EARTH_R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function greatCircle(a, b) {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dl = rad(b.lon - a.lon);
  const c = Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl));
  const m = EARTH_R * Math.acos(c);
  const deg = ((Math.atan2(Math.sin(dl), Math.cos(p1) * Math.tan(p2) - Math.sin(p1) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
  return { m, deg };
}
const metersBetween = (a, b) => (a && b ? greatCircle(a, b).m : Infinity);

// ------------------------------------------------------------------
// The stand-in port and save box
// ------------------------------------------------------------------
// This goes into the page before its own code runs: a navigator.serial with
// one port, the receiver's, and a save box that hands over a file from the
// browser's private file system. The port list asks for a click the way
// Chrome does (navigator.userActivation), so CONNECT is tested honestly. It
// is the stand-in flight-console/test/launch-log-browser.mjs uses, without
// the parts only that file needs. window.__fake holds:
//   port.send(text)   hands the page bytes, as the receiver would
//   unplug()          the cable comes out: the open stream fails the way
//                     Chrome's does, the port leaves getPorts(), and
//                     "disconnect" fires
//   replug()          plugged back in. As in Chrome that is a NEW port
//                     object with the same USB ids, and "connect" fires.
//   pickedName        the name of the file the save box handed over
//   pickerCalls, requestCalls, opens   how often the save box and the port
//                     list were shown, and how often a port was opened
const FAKE = `(() => {
  const enc = new TextEncoder();
  const fake = window.__fake = { requestCalls: 0, pickerCalls: 0, names: [], pickedName: null, granted: false, plugged: true, opens: 0, openTries: 0, made: 0 };
  const heard = { connect: new Set(), disconnect: new Set() };
  const tell = (type, port) => {
    for (const fn of [...heard[type]]) {
      try { fn({ type, target: port, port }); } catch (err) { console.error(err); }
    }
  };
  function makePort() {
    fake.made += 1;
    const port = {
      gone: false,
      readable: null,
      controller: null,
      async open() {
        fake.openTries += 1;
        if (port.gone || !fake.plugged) throw new DOMException('Failed to open serial port.', 'NetworkError');
        fake.opens += 1;
        port.readable = new ReadableStream({ start(c) { port.controller = c; } });
      },
      async setSignals() {},
      async close() { port.readable = null; },
      getInfo() { return { usbVendorId: 0x239a, usbProductId: 0x800b }; },
      send(text) { port.controller.enqueue(enc.encode(text)); },
    };
    return port;
  }
  fake.port = makePort();
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
  Object.defineProperty(fake, 'replug', { enumerable: false, value: () => {
    fake.port = makePort();
    fake.plugged = true;
    tell('connect', fake.port);
  } });
  Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    async requestPort() {
      fake.requestCalls += 1;
      if (!navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      fake.granted = true;
      return fake.port;
    },
    async getPorts() { return fake.granted && fake.plugged ? [fake.port] : []; },
    addEventListener(type, fn) { if (heard[type]) heard[type].add(fn); },
    removeEventListener(type, fn) { if (heard[type]) heard[type].delete(fn); },
  } });
  window.showSaveFilePicker = async (opts) => {
    fake.pickerCalls += 1;
    fake.names.push(opts.suggestedName);
    const dir = await navigator.storage.getDirectory();
    fake.pickedName = 'picked-' + Math.random().toString(36).slice(2, 8) + '-' + opts.suggestedName;
    return dir.getFileHandle(fake.pickedName, { create: true });
  };
})();`;

// One packet line with its position changed, the rest as the receiver sent it.
const movePkt = (line, { lat, lon }) => line
  .replace(/\blat=-?[\d.]+/, `lat=${lat.toFixed(7)}`)
  .replace(/\blon=-?[\d.]+/, `lon=${lon.toFixed(7)}`);
const pktPosition = (line) => ({ lat: pktField(line, 'lat'), lon: pktField(line, 'lon') });
const six = (p) => `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;

// ------------------------------------------------------------------
// Results and clean-up bookkeeping
// ------------------------------------------------------------------
const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `\n        ${detail}` : ''}`);
  return Boolean(ok);
}
const note = (text) => console.log(`        ${text}`);
const heading = (text) => console.log(`\n== ${text} ==`);

const logsBefore = new Set(fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []);
const madeLogs = new Set();      // flight-logs/ files this run's pages wrote
const profiles = [];             // Chrome profiles this run made itself
const shots = [];                // every picture saved
const timings = {};              // per run: start, panel, globe, capture
const internet = [];             // { run, requests, tarpitHosts }

function noteLogNames(page, status) {
  for (const l of status?.logs ?? []) if (l.server) madeLogs.add(l.server);
  for (const r of page?.requests?.() ?? []) {
    const m = /\/launch-mode\/log\/append\?(?:[^#]*&)?name=([^&#]+)/.exec(r.url);
    if (m) madeLogs.add(decodeURIComponent(m[1]));
  }
}

// The log names in a verbose server's request lines, such as
// "[14:03:22] 200 POST /launch-mode/log/append?name=flight-....log 3 ms".
// Beacons from a closing page are in there too.
function noteServerLogs(server) {
  for (const m of String(server?.output?.() ?? '').matchAll(/\/launch-mode\/log\/append\?(?:[^\s#]*&)?name=([^&\s#]+)/g)) {
    madeLogs.add(decodeURIComponent(m[1]));
  }
}

async function noteLogs(page) {
  const status = await page.evaluate(() => window.fcLaunch?.parts?.log?.status?.() ?? null).catch(() => null);
  noteLogNames(page, status);
  return status;
}

async function shot(page, name) {
  const file = path.join(ARGS.shots, `${name}.png`);
  await page.screenshot(file);
  shots.push(file);
  note(`picture: ${file}`);
  return file;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const short = (text, max = 160) => {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

// ------------------------------------------------------------------
// Page helpers
// ------------------------------------------------------------------
const panelStatus = (page) => page.evaluate(() => window.fcLaunch.parts.panel.status());
const globeStatus = (page) => page.evaluate(() => window.fcLaunch.parts.globe?.status() ?? null);
const mapStatus = (page) => page.evaluate(() => window.fcLaunch.parts.map2d?.status() ?? null);
const logStatus = (page) => page.evaluate(() => window.fcLaunch.parts.log.status());
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

// Opens the launch page and waits for it to start. Returns the times (ms
// from the moment it was asked for) to window.fcStarted, to the launch
// panel and to the 3D view's first picture.
async function openLaunch(page, server, url = LAUNCH, { globe = true } = {}) {
  const began = Date.now();
  await page.goto(server.url(url), { waitUntil: 'none' });
  await page.waitFor(() => window.fcStarted === true, { timeout: 60000, interval: 50, message: 'the console did not start (window.fcStarted)' });
  const startMs = Date.now() - began;
  await page.waitFor(() => window.fcLaunch?.parts?.panel && window.fcLaunch.parts.log && window.fcLaunch.parts.capture,
    { timeout: 60000, interval: 50, message: 'launch mode\'s panel, log and capture did not start' });
  const panelMs = Date.now() - began;
  let globeMs = null;
  if (globe) {
    await page.waitFor(() => window.fcLaunch.parts.globe?.status().ready === true,
      { timeout: 90000, interval: 50, message: 'the 3D view never got its first picture' });
    globeMs = Date.now() - began;
  }
  return { startMs, panelMs, globeMs };
}

// Waits until the 3D view has nothing left to load and is not moving, three
// looks in a row. Never throws: returns { settled, status }.
async function globeSettled(page, timeout = 40000) {
  const began = Date.now();
  let calm = 0;
  let status = null;
  while (Date.now() - began < timeout) {
    status = await globeStatus(page);
    const quiet = status && status.ready && status.tilesLoaded && !status.moving && status.savedPending === 0 && (status.onlinePending ?? 0) === 0;
    calm = quiet ? calm + 1 : 0;
    if (calm >= 3) return { settled: true, status, ms: Date.now() - began };
    await sleep(250);
  }
  return { settled: false, status, ms: Date.now() - began };
}

// Waits until the 2D map has no map tile request out and its counts have
// stopped changing for a second. Never throws.
async function mapSettled(page, sinceMs, timeout = 30000) {
  const began = Date.now();
  let last = '';
  let sameSince = Date.now();
  let status = null;
  await sleep(800);
  while (Date.now() - began < timeout) {
    status = await mapStatus(page);
    const out = page.requests().filter((r) => r.startedAt >= sinceMs && r.pending && (r.url.includes(TILES_PATH) || /arcgis\.com/.test(r.url))).length;
    const key = JSON.stringify([status?.savedLoaded, status?.savedFailed, status?.savedEmpty, status?.onlineLoaded, status?.onlineFailed, status?.onlineSkipped, out]);
    if (key !== last) {
      last = key;
      sameSince = Date.now();
    }
    if (out === 0 && Date.now() - sameSince >= 1000) return { settled: true, status, ms: Date.now() - began };
    await sleep(200);
  }
  return { settled: false, status, ms: Date.now() - began };
}

// The saved tile requests in a list, with what happened to them.
function tileSummary(requests) {
  const tiles = requests.filter((r) => r.url.includes(TILES_PATH) && /\.(jpg|jpeg|png)(\?|$)/.test(r.url));
  const out = { total: tiles.length, ok: 0, failed: 0, canceled: 0, pending: 0, byZoom: {}, statuses: {} };
  for (const r of tiles) {
    const z = /\/(\d+)\/\d+\/\d+\.\w+/.exec(new URL(r.url).pathname)?.[1];
    if (z !== undefined) out.byZoom[z] = (out.byZoom[z] ?? 0) + 1;
    if (r.status !== null) out.statuses[r.status] = (out.statuses[r.status] ?? 0) + 1;
    if (r.pending) out.pending += 1;
    else if (r.failed && /canceled|ERR_ABORTED/.test(r.errorText ?? '')) out.canceled += 1;
    else if (r.failed || (r.status !== null && r.status >= 400)) out.failed += 1;
    else out.ok += 1;
  }
  return out;
}
const zoomWords = (byZoom) => Object.entries(byZoom).sort((a, b) => Number(a[0]) - Number(b[0])).map(([z, n]) => `z${z}: ${n}`).join(', ') || 'none';

// A screenshot, then how much texture each part of the view has. kind is
// '3d' (the Cesium canvas, camera straight down) or '2d' (the Leaflet map).
// mpp is meters per CSS pixel at the middle of the view. Each patch is
// sorted as inside the saved box, outside it, or near its edge (left out).
// Patches with something drawn over them (the HUD, a label, a marker, the
// scale bar) are left out too.
async function textureShot(page, name, kind, mpp) {
  const file = await shot(page, name);
  const b64 = (await fsp.readFile(file)).toString('base64');
  const b = MANIFEST.bounds;
  const box = {
    halfNsM: ((b.north - b.south) / 2) * 111320,
    halfEwM: ((b.east - b.west) / 2) * 111320 * Math.cos(rad((b.north + b.south) / 2)),
  };
  return page.evaluate(async (data, viewKind, metersPerPx, saved) => {
    const raw = atob(data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const scale = bmp.width / innerWidth;
    let area;
    if (viewKind === '3d') {
      area = [...document.querySelectorAll('#fc-map canvas')].map((c) => ({ c, r: c.getBoundingClientRect() }))
        .sort((x, y) => y.r.width * y.r.height - x.r.width * x.r.height)[0];
    } else {
      const c = document.querySelector('#fc-map .leaflet-container');
      area = c ? { c, r: c.getBoundingClientRect() } : null;
    }
    if (!area) return { problem: `no ${viewKind} view on the page` };
    const { r } = area;
    const belongs = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      if (viewKind === '3d') return el === area.c;
      return el === area.c || (area.c.contains(el) && Boolean(el.closest('.leaflet-tile-pane')));
    };
    const P = 24;
    // elementFromPoint() does not see what lets clicks through (the scale
    // bar, the map labels, the ground station's mark), so the boxes of what
    // is drawn over the view are collected too: text, pictures, anything
    // with a border or a background, and small SVG shapes. Map tiles are
    // the view itself. A large SVG shape is an outline on the 2D map, whose
    // box covers everything inside it, so those are left in. So is a
    // canvas: the 2D map draws its lines on one that covers the whole view.
    const SHAPES = ['path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'image', 'use'];
    const SMALL = 2 * P;
    const drawn = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el === area.c || el.contains(area.c) || el.closest('.leaflet-layer, .leaflet-tile')) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'canvas') continue;
      const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      const box = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none'
        || ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none');
      if (words || box || tag === 'img' || (SHAPES.includes(tag) && b.width <= SMALL && b.height <= SMALL)) drawn.push(b);
    }
    const clear = (x, y) => drawn.every((b) => x + P / 2 + 2 < b.left || x - P / 2 - 2 > b.right || y + P / 2 + 2 < b.top || y - P / 2 - 2 > b.bottom);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const patches = [];
    for (let gx = -12; gx <= 12; gx += 1) {
      for (let gy = -8; gy <= 8; gy += 1) {
        const x = cx + gx * 40;
        const y = cy + gy * 40;
        if (x - P / 2 < r.left + 4 || x + P / 2 > r.right - 4 || y - P / 2 < r.top + 4 || y + P / 2 > r.bottom - 4) continue;
        const corners = [[x, y], [x - P / 2 + 1, y - P / 2 + 1], [x + P / 2 - 1, y - P / 2 + 1], [x - P / 2 + 1, y + P / 2 - 1], [x + P / 2 - 1, y + P / 2 - 1]];
        if (!corners.every(([px, py]) => belongs(px, py)) || !clear(x, y)) continue;
        const eastM = (x - cx) * metersPerPx;
        const northM = (cy - y) * metersPerPx;
        const fx = Math.abs(eastM) / saved.halfEwM;
        const fy = Math.abs(northM) / saved.halfNsM;
        const where = fx < 0.85 && fy < 0.85 ? 'inside' : (fx > 1.15 || fy > 1.15 ? 'outside' : 'edge');
        if (where === 'edge') continue;
        const d = g.getImageData(Math.round((x - P / 2) * scale), Math.round((y - P / 2) * scale), Math.round(P * scale), Math.round(P * scale)).data;
        let sum = 0;
        let sum2 = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sum += lum;
          sum2 += lum * lum;
        }
        const mean = sum / n;
        const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        patches.push({ where, x: Math.round(x), y: Math.round(y), eastKm: eastM / 1000, northKm: northM / 1000, std, mean });
      }
    }
    return { view: { left: r.left, top: r.top, width: r.width, height: r.height }, patches };
  }, b64, kind, mpp, box);
}

function textureWords(stats) {
  if (!stats || stats.problem) return { inside: null, outside: null, words: stats?.problem ?? 'no picture', spots: '' };
  const part = (where) => {
    const list = stats.patches.filter((p) => p.where === where);
    const textured = list.filter((p) => p.std > TEXTURE_STD).length;
    const flat = list.filter((p) => p.std < FLAT_STD).length;
    const stds = list.map((p) => p.std).sort((a, b) => a - b);
    const median = stds.length ? stds[Math.floor(stds.length / 2)] : NaN;
    return { n: list.length, textured, flat, median, max: stds.at(-1) ?? NaN };
  };
  const inside = part('inside');
  const outside = part('outside');
  const one = (name, p) => `${name}: ${p.n} patches, ${p.textured} with imagery, ${p.flat} plain (median spread ${p.median.toFixed(1)}, highest ${p.max.toFixed(1)})`;
  // Where on the picture the patches outside the box are not plain, so a
  // failure can be looked up in it.
  const notPlain = stats.patches.filter((p) => p.where === 'outside' && p.std >= FLAT_STD);
  const spots = notPlain.length ? `. Not plain outside the box at ${notPlain.slice(0, 6).map((p) => `${p.x}, ${p.y} (spread ${p.std.toFixed(1)})`).join(' and ')}${notPlain.length > 6 ? ` and ${notPlain.length - 6} more` : ''}` : '';
  return { inside, outside, words: `${one('inside the saved box', inside)}. ${one('outside it', outside)}`, spots };
}

// The page's saved LOCAL flights, newest first, with their lines.
const savedFlights = (page) => page.evaluate(async () => {
  const db = window.fcLaunch?.ctx?.localConsole?.test?.db;
  const all = (await db.listFlights()).filter((r) => r.status === 'saved').sort((a, b) => b.createdAt - a.createdAt);
  const out = [];
  for (const r of all) {
    const data = await db.readLines(r.id);
    out.push({ id: r.id, title: r.title, test: Boolean(r.test), source: r.source, sampleCount: r.sampleCount, lines: data.lines, times: data.times?.length ?? 0, originalName: r.originalName ?? null });
  }
  return out;
});

// A flight log's text checked against the receiver lines it should hold.
function compareLog(textIn, expected, { from = -Infinity, to = Infinity } = {}) {
  const problems = [];
  const lines = textIn.split('\n');
  if (lines.at(-1) !== '') problems.push('the file does not end with a line feed');
  lines.pop();
  if (lines[0] !== '# Dogtooth flight log') problems.push(`the first line is ${JSON.stringify(lines[0])}`);
  if (!/^# started \d{4}-/.test(lines[1] ?? '')) problems.push('no "# started" line');
  if (!/^# each line: /.test(lines[3] ?? '')) problems.push('no "# each line" line');
  const data = [];
  let lastT = -Infinity;
  let outside = 0;
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    const m = PREFIX.exec(line);
    if (!m) {
      problems.push(`a line with no time: ${line.slice(0, 60)}`);
      continue;
    }
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) problems.push(`a time that does not read: ${m[1]}`);
    if (!(t >= lastT)) problems.push(`the time goes back at ${m[1]}`);
    if (t < from - 2000 || t > to + 2000) outside += 1;
    lastT = t;
    data.push(line.slice(m[0].length));
  }
  if (outside) problems.push(`${outside} times are outside the run`);
  if (data.length !== expected.length) problems.push(`${data.length} receiver lines, expected ${expected.length}`);
  const firstDiff = data.findIndex((l, i) => l !== expected[i]);
  if (firstDiff >= 0) problems.push(`line ${firstDiff + 1} differs: ${short(data[firstDiff], 60)}`);
  return { ok: problems.length === 0, problems, data };
}

// Clicks RECOVER, then SAVE in the name box. Returns the offer's words.
async function recover(page, shotName) {
  await page.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed' });
  const offer = await page.evaluate(() => document.getElementById('fc-recover').textContent.replace(/\s+/g, ' ').trim());
  if (shotName) await shot(page, shotName);
  await page.click('#fc-recover-actions button');
  await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not open' });
  await page.click('dialog.fc-dialog button[type="submit"]');
  await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not close' });
  return offer;
}

// The times of day in the page's own words, like "AT 14:02:11".
const clockOf = (page, ms) => page.evaluate((t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}, ms);

// A log cut short by a crash: its receiver lines must be the first ones of
// `sent`, in order. n is how many it has.
function logPrefix(textIn, sent) {
  const n = compareLog(textIn, sent).data.length;
  const cmp = compareLog(textIn, sent.slice(0, n));
  return { n, ok: cmp.ok, problems: cmp.problems };
}

// ------------------------------------------------------------------
// Helpers for the pages with the stand-in port
// ------------------------------------------------------------------

// A new launch page with the stand-in port and save box in it.
async function launchPageWithPort(browser, server) {
  const page = await browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await openLaunch(page, server, LAUNCH, { globe: false });
  return page;
}

// CONNECT, pressed the way a person presses it: one real click, which
// shows the save box and the port list and opens the port.
async function pressConnect(page) {
  await page.click('#bc-connect');
  await page.waitFor(() => Boolean(window.fcLaunch.ctx.live.link.open), { timeout: 15000, interval: 20, message: 'CONNECT did not open the stand-in port' });
}

// Hands the page receiver lines through the stand-in port, as one write.
// Returns the page's clock at that moment.
const sendToPort = (page, lines) => page.evaluate((part) => {
  const t = Date.now();
  window.__fake.port.send(part.map((l) => `${l}\r\n`).join(''));
  return t;
}, lines);

// One of the two warning lines under the bar as a person sees it: its tag
// and words, whether it shows, and whether all of it is inside the window
// with nothing over it.
const barLine = (page, id) => page.evaluate((elId) => {
  const el = document.getElementById(elId);
  if (!el) return { shown: false, onScreen: false, kind: null, tag: '', text: '', box: 'not on the page' };
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
    box: `${Math.round(r.left)}, ${Math.round(r.top)} to ${Math.round(r.right)}, ${Math.round(r.bottom)} in a ${window.innerWidth} by ${window.innerHeight} window`,
  };
}, id);

// What the recovery readout shows, what the lines under it show, and the
// fix the panel has saved in localStorage.
const readout = (page) => page.evaluate((key) => {
  const st = window.fcLaunch.parts.panel.status();
  const el = (id) => document.getElementById(id);
  const words = (id) => (el(id) && !el(id).hidden ? el(id).textContent : '');
  const under = el('fcl-weak');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { saved = null; }
  const counts = window.fcLaunch.ctx.live.flightFeed?.counts ?? {};
  return {
    fix: st.fix,
    copyText: st.copyText,
    lat: words('fcl-lat'),
    lon: words('fcl-lon'),
    state: words('fcl-fix-state'),
    detail: words('fcl-fix-detail'),
    under: under && !under.hidden ? `${words('fcl-weak-state')}, ${words('fcl-weak-coords')}` : '',
    saved,
    heard: (counts.samples ?? 0) + (counts.bad ?? 0),
  };
}, SAVED_FIX_KEY);

// The three copies of the flight log on a page with the stand-in port: the
// disk file (the file the stand-in save box handed over), the server copy
// (read from flight-logs/ here) and the browser copy. The browser copy is
// every recording of a real connection in IndexedDB, oldest first, because
// a lost port ends one recording and the reconnect starts the next.
async function threeCopies(page) {
  const got = await page.evaluate(async () => {
    const hub = window.fcLaunch;
    const db = hub.ctx.localConsole.test.db;
    let disk = '';
    try {
      const dir = await navigator.storage.getDirectory();
      disk = await (await (await dir.getFileHandle(window.__fake.pickedName)).getFile()).text();
    } catch (err) {
      disk = '';
    }
    const recordings = (await db.listFlights()).filter((r) => !r.test).sort((a, b) => a.createdAt - b.createdAt);
    const browser = [];
    const parts = [];
    for (const r of recordings) {
      const lines = (await db.readLines(r.id)).lines;
      parts.push(lines.length);
      browser.push(...lines);
    }
    return {
      status: hub.parts.log.status(),
      disk,
      browser,
      parts,
      fake: { pickerCalls: window.__fake.pickerCalls, requestCalls: window.__fake.requestCalls, opens: window.__fake.opens, pickedName: window.__fake.pickedName, suggested: window.__fake.names },
    };
  });
  const serverName = got.status.server.name;
  const serverFile = serverName ? path.join(LOGS, serverName) : null;
  const serverText = serverFile && fs.existsSync(serverFile) ? fs.readFileSync(serverFile, 'utf8') : '';
  return { ...got, serverName, serverText };
}

// Waits until the copies that can keep up have every line: the disk file,
// the browser copy, and the server copy unless the server is down.
const copiesSettled = (page, { server = true, timeout = 20000 } = {}) => page.waitFor((withServer) => {
  const s = window.fcLaunch.parts.log.status();
  const r = window.fcLaunch.ctx.localConsole.recording();
  const fileOk = s.file.state !== 'saving' || s.file.pending === 0;
  const serverOk = !withServer || s.server.state === 'none' || s.server.pending === 0;
  const browserOk = !r.active || r.storedLines >= r.lineCount;
  return fileOk && serverOk && browserOk;
}, { timeout, args: [server], message: 'the copies of the log did not catch up' }).then(() => true, () => false);

// The requests a page sent toward the internet, kept for check 14.
function addInternet(run, network, requests) {
  const entry = internet.find((e) => e.run === run);
  if (entry) entry.requests.push(...requests);
  else internet.push({ run, network, requests: [...requests] });
}

// ------------------------------------------------------------------
// The blocked run: checks 1 to 5, the reload of check 6 and check 7
// ------------------------------------------------------------------
let serverCopy = null;    // { name, file } the capture's server copy, for check 7

async function blockedRun(server) {
  heading('Internet blocked, a fresh profile, 1366 by 768');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: GPU });
  let page = null;
  try {
    page = await browser.newPage();
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    // ---- 1. start
    const t = await openLaunch(page, server);
    timings.blocked = { ...t };
    await page.waitFor(() => window.fcLaunch.parts.panel.status().groundStation !== undefined, { timeout: 5000 });
    let st = await panelStatus(page);
    const gs = {
      state: await text(page, '#fcl-gs-state'),
      lat: await page.evaluate(() => document.getElementById('fcl-gs-lat')?.value ?? null),
      lon: await page.evaluate(() => document.getElementById('fcl-gs-lon')?.value ?? null),
      store: await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getGroundStation()),
    };
    const exceptionsAtStart = page.exceptions();
    if (want('start')) {
      check('start', 'launch.html?track starts with the internet blocked', t.startMs < 15000,
        `window.fcStarted after ${seconds(t.startMs)}, the launch panel after ${seconds(t.panelMs)}, the 3D view's first picture after ${seconds(t.globeMs)}`);
      check('start', 'the launch panel shows the field center as the ground station',
        st.panelShown === true && st.groundStation?.lat === FIELD.lat && st.groundStation?.lon === FIELD.lon && st.groundStation?.typed === false
          && gs.state === 'FIELD CENTER' && gs.lat === FIELD.lat.toFixed(6) && gs.lon === FIELD.lon.toFixed(6)
          && gs.store?.lat === FIELD.lat && gs.store?.lon === FIELD.lon,
        `panel ${JSON.stringify(st.groundStation)}, says "${gs.state}", boxes ${gs.lat}, ${gs.lon}, flight store ${gs.store?.lat}, ${gs.store?.lon} (${gs.store?.source}). field.json says ${FIELD.lat}, ${FIELD.lon}`);
      check('start', 'no page exceptions at the start', exceptionsAtStart.length === 0,
        `${exceptionsAtStart.length} exceptions${exceptionsAtStart.length ? `: ${exceptionsAtStart.map((e) => short(e.text, 100)).join(' | ')}` : ''}`);
    }

    // ---- 2. maps
    if (want('maps')) {
      const settled = await globeSettled(page);
      const g = settled.status;
      const tiles3d = tileSummary(page.requests());
      check('maps', '3D view: ready, Cesium ion not used, flat ground',
        g.ready === true && g.ionUsed === false && g.terrain === 'flat',
        `ready ${g.ready}, ionUsed ${g.ionUsed}, terrain "${g.terrain}", ${g.layers} imagery layers (plain ground ${g.plainGround}, ${g.savedLayers} saved, max levels ${g.savedMaxLevels.join('/')}), Esri key ${g.onlineKey}, Esri layer on ${g.onlineLayerOn}`);
      check('maps', `3D view: saved tiles loaded from ${TILES_PATH}, 0 failures`,
        settled.settled && g.savedLoaded > 0 && g.savedFailed === 0 && tiles3d.total > 0 && tiles3d.failed === 0 && tiles3d.pending === 0,
        `the view's own count: ${g.savedLoaded} loaded, ${g.savedFailed} failed, ${g.savedSkipped} skipped, ${g.savedPending} pending (settled ${settled.settled} after ${seconds(settled.ms)}). Requests: ${tiles3d.total} (${tiles3d.ok} ok, ${tiles3d.failed} failed, ${tiles3d.canceled} canceled by Cesium, ${tiles3d.pending} pending), answers ${JSON.stringify(tiles3d.statuses)}, by zoom ${zoomWords(tiles3d.byZoom)}`);
      const home = g.lookingAt;
      note(`the 3D view looks at ${home.lat.toFixed(5)}, ${home.lon.toFixed(5)} from ${Math.round(home.rangeM)} m (${Math.round(metersBetween(home, FIELD))} m from the field center), pitch ${home.pitchDeg.toFixed(1)}`);
      await shot(page, '2-3d-over-the-field');

      // From high up: the saved box has imagery, and outside it is plain.
      await page.evaluate((f) => window.fcLaunch.parts.globe.lookAt({ lat: f.lat, lon: f.lon, heightM: 90000 }), FIELD);
      const high = await globeSettled(page);
      const cam = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.camera());
      const mpp3 = cam.range / cam.f;
      const tex3 = textureWords(await textureShot(page, '2-3d-high-up-blocked', '3d', mpp3));
      check('maps', '3D view from 90 km up: imagery inside the saved box, plain ground outside it',
        high.settled && tex3.inside?.n > 0 && tex3.inside.textured >= tex3.inside.n * 0.6 && tex3.outside?.n > 0 && tex3.outside.flat === tex3.outside.n,
        `${tex3.words}${tex3.spots}. ${Math.round(mpp3)} m per pixel, saved ${high.status.savedLoaded} loaded and ${high.status.savedFailed} failed`);
      await page.evaluate(() => window.fcLaunch.parts.globe.resetView());

      // The 2D map.
      const since1 = Date.now();
      await page.click(SEL.satellite);
      await page.waitFor(() => window.fcLaunch.parts.map2d?.status().view === 'map', { timeout: 15000, message: 'the 2D map did not show after SATELLITE' });
      const m1 = await mapSettled(page, since1);
      const req1 = tileSummary(page.requests().filter((r) => r.startedAt >= since1));
      const z1 = m1.status.zoom;
      check('maps', `2D map (SATELLITE) at zoom ${z1}: saved tiles around the field, 0 failures`,
        m1.settled && m1.status.savedLayerOn && m1.status.savedLoaded > 0 && m1.status.savedFailed === 0 && req1.total > 0 && req1.failed === 0 && (req1.byZoom[z1] ?? 0) > 0
          && metersBetween(m1.status.center, FIELD) < 2000,
        `center ${m1.status.center.lat.toFixed(5)}, ${m1.status.center.lon.toFixed(5)} (${Math.round(metersBetween(m1.status.center, FIELD))} m from the field center). The map's own count: ${m1.status.savedLoaded} loaded, ${m1.status.savedFailed} failed, ${m1.status.savedEmpty} empty. Requests: ${req1.total} (${req1.ok} ok, ${req1.failed} failed, ${req1.canceled} canceled), by zoom ${zoomWords(req1.byZoom)}`);
      await shot(page, `2-2d-zoom-${z1}`);
      const z2 = z1 === 18 ? 13 : 18;
      const since2 = Date.now();
      const before2 = m1.status;
      await page.evaluate((f, z) => window.fcLaunch.parts.map2d.setView(f.lat, f.lon, z), FIELD, z2);
      const m2 = await mapSettled(page, since2);
      const req2 = tileSummary(page.requests().filter((r) => r.startedAt >= since2));
      check('maps', `2D map at zoom ${z2}: saved tiles around the field, 0 failures`,
        m2.settled && m2.status.zoom === z2 && m2.status.savedLoaded > before2.savedLoaded && m2.status.savedFailed === 0 && req2.total > 0 && req2.failed === 0 && (req2.byZoom[z2] ?? 0) > 0,
        `zoom ${m2.status.zoom}. The map's own count went from ${before2.savedLoaded} to ${m2.status.savedLoaded} loaded, ${m2.status.savedFailed} failed. Requests: ${req2.total} (${req2.ok} ok, ${req2.failed} failed, ${req2.canceled} canceled), by zoom ${zoomWords(req2.byZoom)}`);
      await shot(page, `2-2d-zoom-${z2}`);
      // Zoomed out: the saved box, and plain ground around it.
      const since3 = Date.now();
      await page.evaluate((f) => window.fcLaunch.parts.map2d.setView(f.lat, f.lon, 10), FIELD);
      const m3 = await mapSettled(page, since3);
      const mpp2 = (156543.03392 * Math.cos(rad(FIELD.lat))) / 2 ** 10;
      const tex2 = textureWords(await textureShot(page, '2-2d-zoom-10-blocked', '2d', mpp2));
      check('maps', '2D map at zoom 10: imagery inside the saved box, plain ground outside it',
        m3.settled && tex2.inside?.n > 0 && tex2.inside.textured >= tex2.inside.n * 0.6 && tex2.outside?.n > 0 && tex2.outside.flat === tex2.outside.n,
        `${tex2.words}${tex2.spots}. Map note: "${m3.status.note}"`);
      const allTiles = tileSummary(page.requests());
      check('maps', 'every saved tile request of the run answered (none failed or hung)', allTiles.failed === 0 && allTiles.pending === 0,
        `${allTiles.total} requests to ${TILES_PATH}: ${allTiles.ok} ok, ${allTiles.failed} failed, ${allTiles.canceled} canceled by the maps, ${allTiles.pending} pending, answers ${JSON.stringify(allTiles.statuses)}`);
      // Back to the 3D view for the capture.
      await page.click(SEL.three);
      await page.waitFor(() => document.getElementById('fc-map')?.fcMapTest?.counts().view === '3d', { timeout: 10000, message: 'the 3D view did not come back' });
      await page.evaluate(() => window.fcLaunch.parts.globe.resetView());
      await globeSettled(page, 15000);
    }

    // ---- 3. the capture through the live path
    const needCapture = ['capture', 'log', 'panel', 'restore', 'replay', 'tarpit', 'requests'].some(want);
    if (needCapture) {
      await page.evaluate(() => {
        const hub = window.fcLaunch;
        const acc = { taps: 0, views: [], result: null };
        window.__acc = acc;
        hub.link.onLine(() => { acc.taps += 1; });
        const look = () => {
          const stage = hub.ctx.getStage();
          const k = `${hub.ctx.getScreen()}|${stage?.session.kind}|player ${stage?.session.player ? 'yes' : 'no'}|${stage?.store.current() === hub.ctx.live.stores.flight ? 'flight store' : stage?.store.current() === hub.ctx.live.stores.bench ? 'bench store' : 'other store'}|${location.search}`;
          if (acc.views.at(-1) !== k) acc.views.push(k);
        };
        acc.timer = setInterval(look, 25);
        hub.parts.capture.play({ speed: 20, shift: 'field' }).then((r) => { acc.result = r; acc.endedAt = Date.now(); look(); clearInterval(acc.timer); });
        return true;
      });
      const playingAt = await page.waitFor(() => (window.fcLaunch.parts.capture.status().playing ? Date.now() : false), { timeout: 20000, interval: 20, message: 'the capture never started' });
      await page.waitFor(() => window.fcLaunch.parts.log.status().logs.length > 0, { timeout: 10000, message: 'the flight log did not start a log for the capture' });
      noteLogNames(page, await logStatus(page));
      // The disk file: a file from the browser's private file system, given
      // the way the save box would.
      const given = page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        try { await dir.removeEntry('acceptance-capture.log'); } catch { /* not there */ }
        const handle = await dir.getFileHandle('acceptance-capture.log', { create: true });
        return window.fcLaunch.parts.log.useFileHandle(handle);
      });
      await sleep(2500);
      await shot(page, '3-capture-playing');
      const result = await page.waitFor(() => window.__acc.result, { timeout: 60000, interval: 20, message: 'the capture never ended' });
      const endedAt = await page.evaluate(() => window.__acc.endedAt);
      const fileGiven = await given;
      timings.blocked.captureMs = endedAt - playingAt;
      const settledLog = await page.waitFor((want) => {
        const s = window.fcLaunch.parts.log.status();
        return (s.file.state !== 'saving' || s.file.pending === 0) && (s.server.state === 'none' || s.server.pending === 0) && s.browser.lines === want ? s : false;
      }, { timeout: 20000, args: [SHIFTED.length], message: 'the copies of the log did not catch up' });
      noteLogNames(page, settledLog);
      await page.waitFor(() => !window.fcLaunch.ctx.localConsole.recording().active, { timeout: 15000, message: 'the capture\'s recording did not stop' });
      await sleep(1500);
      await shot(page, '3-capture-ended-3d');
      const live = await page.evaluate(() => {
        const hub = window.fcLaunch;
        const l = hub.ctx.live;
        const rocket = l.stores.flight.getRocket('1');
        const stage = hub.ctx.getStage();
        const cam = document.getElementById('fc-map').fcMapTest.camera();
        return {
          counts: l.flightFeed.counts,
          samples: rocket?.samples.length ?? 0,
          first: rocket?.samples[0]?.gps ?? null,
          last: rocket?.lastGoodFix ? { lat: rocket.lastGoodFix.lat, lon: rocket.lastGoodFix.lon } : null,
          mode: l.mode,
          views: window.__acc.views,
          taps: window.__acc.taps,
          onStage: stage.store.current() === l.stores.flight,
          board: cam?.board ?? null,
          canvas: cam ? { width: cam.width, height: cam.height } : null,
          looking: hub.parts.globe?.status().lookingAt ?? null,
        };
      });
      if (want('capture')) {
        check('capture', 'the capture played every line at 20 times real speed', result.ok === true && result.reason === 'ended' && result.sent === SHIFTED.length,
          `sent ${result.sent} of ${result.total} lines (the file has ${CAPTURE_LINES.length}), ${seconds(timings.blocked.captureMs)} from start to end (${(PLAN.durationS / 20).toFixed(1)} s of capture at 20x)`);
        check('capture', 'every PKT line reached the flight store', live.counts.samples === CAPTURE_PKTS && live.samples === CAPTURE_PKTS && live.counts.bad === 0,
          `the capture file has ${CAPTURE_PKTS} PKT lines. The flight feed counted ${JSON.stringify(live.counts)}, rocket 1 has ${live.samples} samples, live mode "${live.mode}"`);
        check('capture', 'the live view moved to the field: the first fix is the field center, the board is on the 3D view',
          Math.abs(live.first.lat - FIELD.lat) < 1e-6 && Math.abs(live.first.lon - FIELD.lon) < 1e-6 && metersBetween(live.last, FIELD) < 200
            && live.onStage && live.board && live.board.x >= 0 && live.board.x <= live.canvas.width && live.board.y >= 0 && live.board.y <= live.canvas.height,
          `first fix ${live.first.lat}, ${live.first.lon}, last fix ${Math.round(metersBetween(live.last, FIELD))} m from the field center, the board drawn at ${live.board ? `${Math.round(live.board.x)}, ${Math.round(live.board.y)}` : 'nowhere'} in a ${live.canvas?.width} by ${live.canvas?.height} view, the camera looks ${Math.round(metersBetween(live.looking, FIELD))} m from the field center`);
        const replayUsed = live.views.some((v) => !/^track\|live\|player no\|flight store\|\?track$/.test(v));
        check('capture', 'nothing went through the replay path', !replayUsed && live.taps === SHIFTED.length,
          `${live.taps} lines went through the live taps (hub.link.onLine). Screen, session, player, store and address seen during the capture: ${live.views.join(' then ')}`);
      }

      // ---- 4. the log is saved
      const runFrom = playingAt - 2000;
      const runTo = Date.now();
      const serverName = settledLog.server.name;
      const serverFile = path.join(LOGS, serverName);
      const serverText = fs.existsSync(serverFile) ? fs.readFileSync(serverFile, 'utf8') : '';
      serverCopy = { name: serverName, file: serverFile, text: serverText };
      const cmp = compareLog(serverText, SHIFTED, { from: runFrom, to: runTo });
      const opfs = await page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        return (await (await dir.getFileHandle('acceptance-capture.log')).getFile()).text();
      });
      const saved = await savedFlights(page);
      const testRec = saved.find((r) => r.test);
      const idbSame = Boolean(testRec) && testRec.lines.length === SHIFTED.length && testRec.lines.every((l, i) => l === SHIFTED[i]);
      if (want('log')) {
        check('log', 'the server copy has every line in order, each with a valid time',
          cmp.ok && /^test-capture-\d{4}-\d{2}-\d{2}-\d{6}-page\.log$/.test(serverName),
          `flight-logs/${serverName}: ${serverText.length} bytes, ${cmp.data.length} receiver lines${cmp.problems.length ? `. Problems: ${cmp.problems.join('. ')}` : `, all ${SHIFTED.length} the same as the moved capture line by line, times in order and inside the run`}`);
        // (useFileHandle's own answer is only noted. It says whether its first
        // write caught up, and lines kept coming in while it wrote.)
        check('log', 'a private file system file given to useFileHandle gets the same bytes',
          opfs === serverText && settledLog.file.state === 'saving' && settledLog.file.lines === SHIFTED.length && settledLog.file.pending === 0,
          `the file has ${opfs.length} bytes, ${opfs === serverText ? 'byte for byte the same as the server copy' : 'DIFFERENT from the server copy'}. File status ${JSON.stringify({ state: settledLog.file.state, name: settledLog.file.name, lines: settledLog.file.lines, pending: settledLog.file.pending })}. useFileHandle itself resolved ${fileGiven} (given 2.5 s into the capture)`);
        check('log', 'IndexedDB has every line', idbSame && testRec.times === SHIFTED.length,
          testRec ? `"${testRec.title}": ${testRec.lines.length} lines (${idbSame ? 'all the same as the capture' : 'NOT the same'}), ${testRec.times} arrival times. Browser copy status ${JSON.stringify(settledLog.browser)}` : 'no test recording was saved');
      }

      // ---- 5. the recovery panel
      if (want('panel')) {
        st = await panelStatus(page);
        const words = {
          lat: await text(page, '#fcl-lat'),
          lon: await text(page, '#fcl-lon'),
          alt: await text(page, '#fcl-alt'),
          range: await text(page, '#fcl-range'),
        };
        check('panel', 'the coordinates are the last PKT line\'s lat and lon (after the shift) to 6 decimals',
          words.lat === WANT_FIX.lat.toFixed(6) && words.lon === WANT_FIX.lon.toFixed(6) && st.fix?.lat === WANT_FIX.lat && st.fix?.lon === WANT_FIX.lon,
          `shown ${words.lat}, ${words.lon}, status ${st.fix?.lat}, ${st.fix?.lon}. The last PKT line says ${WANT_FIX.lat}, ${WANT_FIX.lon}`);
        check('panel', 'the altitude is the last PKT line\'s alt_m', st.fix?.altM === WANT_FIX.altM && words.alt === `${WANT_FIX.altM.toFixed(1)} M ABOVE SEA LEVEL`,
          `shown "${words.alt}", status ${st.fix?.altM}, alt_m=${WANT_FIX.altM}`);
        const gc = greatCircle(FIELD, WANT_FIX);
        check('panel', 'range and bearing from the ground station match a great circle within 1 m and 0.1 degree',
          Math.abs(st.rangeM - gc.m) < 1 && Math.abs(st.bearingDeg - gc.deg) < 0.1,
          `panel ${st.rangeM.toFixed(2)} m at ${st.bearingDeg.toFixed(3)} degrees ("${words.range}"), great circle ${gc.m.toFixed(2)} m at ${gc.deg.toFixed(3)} degrees`);
        const a1 = await panelStatus(page);
        await sleep(5000);
        const a2 = await panelStatus(page);
        const rise = a2.fix.packetAgeS - a1.fix.packetAgeS;
        check('panel', 'the age counts up after the lines stop', rise > 4.5 && rise < 6 && a2.fix.ageS > a1.fix.ageS && a2.fix.old === true,
          `LAST PACKET age ${a1.fix.packetAgeS.toFixed(1)} s, then ${a2.fix.packetAgeS.toFixed(1)} s five seconds later. The fix is ${a2.fix.why} ("${await text(page, '#fcl-fix-state')}")`);
        await browser.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
        await page.click('#fcl-copy');
        await sleep(300);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        const copiedWords = await text(page, '#fcl-copied');
        check('panel', 'COPY COORDINATES puts the exact text on the clipboard', copied === WANT_COPY && copiedWords === `COPIED ${WANT_COPY}`,
          `clipboard "${copied}", the panel says "${copiedWords}", expected "${WANT_COPY}"`);
        const maps = await page.evaluate(() => {
          const link = document.getElementById('fcl-maps');
          const hud = [...document.querySelectorAll('.fc-hud-recovery a')].find((a) => a.textContent.includes('OPEN IN MAPS'));
          const seen = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
          return { hidden: link?.hidden ?? null, seen: seen(link), hudSeen: seen(hud), hud: Boolean(hud), online: window.fcLaunch.online.get() };
        });
        check('panel', 'OPEN IN MAPS is hidden', a2.mapsLinkShown === false && maps.hidden === true && !maps.seen && !maps.hudSeen,
          `the panel's link: hidden ${maps.hidden}, on screen ${maps.seen}. The HUD's link: ${maps.hud ? `on screen ${maps.hudSeen}` : 'not there'}. Online ${maps.online}`);
        await shot(page, '5-recovery-panel');
      }

      // ---- 6 (part). A plain reload after the capture shows the SAVED FIX.
      if (want('restore')) {
        const fixBefore = (await panelStatus(page)).fix;
        await page.reload({ waitUntil: 'load' });
        await page.waitFor(() => window.fcLaunch?.parts?.panel, { timeout: 60000, message: 'the panel did not come back after the reload' });
        await sleep(800);
        const after = await panelStatus(page);
        const head = await text(page, '#fcl-fix-state');
        const detail = await text(page, '#fcl-fix-detail');
        const realAge = await page.evaluate((ms) => (Date.now() - ms) / 1000, fixBefore.wallMs);
        check('restore', 'a plain reload after the capture shows the SAVED FIX',
          after.fix?.lat === WANT_FIX.lat && after.fix?.lon === WANT_FIX.lon && after.fix?.source === 'reload' && after.fix?.restored === true
            && /^SAVED FIX, FROM \d+:\d\d AGO$/.test(head ?? '') && Math.abs(after.fix.ageS - realAge) < 1.5
            && (await text(page, '#fcl-lat')) === WANT_FIX.lat.toFixed(6),
          `"${head}" "${detail}", ${after.fix?.lat}, ${after.fix?.lon}, source ${after.fix?.source}, age ${after.fix?.ageS?.toFixed(1)} s (real ${realAge.toFixed(1)} s), marked as a test ${after.fix?.test}`);
        await shot(page, '6-reload-saved-fix');
      }

      // ---- 7. a saved log replays
      if (want('replay')) {
        const loadOne = async (file, label) => {
          await page.goto(server.url(LAUNCH), { waitUntil: 'none' });
          await page.waitFor(() => window.fcStarted === true && window.fcLaunch?.parts?.panel && document.querySelector('input.fc-file-input'), { timeout: 60000, message: 'the page did not start for LOAD FILE' });
          const name = path.basename(file);
          await page.setFiles('input.fc-file-input', [file]);
          await page.waitFor((n) => (document.getElementById('fc-file-text')?.textContent ?? '').includes(`Loaded ${n}`) && location.search.includes('flight=local-'),
            { timeout: 30000, args: [name], message: `LOAD FILE did not load ${name}` });
          await page.waitFor(() => window.fcLaunch.ctx.getScreen() === 'replay' && window.fcLaunch.ctx.getStage()?.session.player,
            { timeout: 30000, message: `the replay of ${name} did not start` });
          await sleep(2500);
          const out = await page.evaluate(async (n) => {
            const lc = window.fcLaunch.ctx.localConsole;
            const loaded = (await lc.test.db.listFlights()).filter((x) => x.originalName === n).sort((a, b) => b.createdAt - a.createdAt)[0];
            const flight = await (await lc.find(loaded.id)).load();
            const stage = window.fcLaunch.ctx.getStage();
            return {
              title: loaded.title,
              sampleCount: loaded.sampleCount,
              replay: flight.samples.length,
              first: flight.samples[0]?.gps ?? null,
              screen: window.fcLaunch.ctx.getScreen(),
              player: Boolean(stage?.session.player),
              said: document.getElementById('fc-file-text')?.textContent ?? '',
            };
          }, name);
          await shot(page, `7-replay-${label}`);
          return out;
        };
        const fileText = serverCopy.text;
        const pkts = fileText.split('\n').filter((l) => / > PKT /.test(l)).length;
        const a = await loadOne(serverCopy.file, 'server-copy');
        check('replay', 'the server copy loads with LOAD FILE and replays with as many samples as the capture',
          a.sampleCount === CAPTURE_PKTS && a.replay === CAPTURE_PKTS && pkts === CAPTURE_PKTS && a.screen === 'replay' && a.player,
          `${serverCopy.name}: ${pkts} PKT lines, loaded as "${a.title}" with ${a.sampleCount} samples, the replay has ${a.replay} (the capture has ${CAPTURE_PKTS} packets), screen "${a.screen}", player ${a.player}. "${short(a.said, 120)}"`);
        if (fs.existsSync(BACKUP_SAMPLE)) {
          const bText = fs.readFileSync(BACKUP_SAMPLE, 'utf8');
          const bPkts = bText.split('\n').filter((l) => / > PKT /.test(l)).length;
          const b = await loadOne(BACKUP_SAMPLE, 'backup-logger-sample');
          check('replay', 'the backup logger\'s sample log loads and replays every packet',
            b.sampleCount === bPkts && b.replay === bPkts && b.screen === 'replay',
            `backup-sample-from-test.log: ${bPkts} PKT lines, loaded with ${b.sampleCount} samples, the replay has ${b.replay}, first fix ${b.first?.lat}, ${b.first?.lon}`);
        } else {
          note('flight-logs/backup-sample-from-test.log is not there, so the backup logger\'s format was not loaded');
        }
      }
    }

    const ex = page.exceptions();
    if (want('start')) {
      check('start', 'no page exceptions from the start to the end of the blocked run', ex.length === 0,
        `${ex.length} exceptions. Console errors: ${page.consoleErrors().length} (${[...new Set(page.consoleErrors().map((m) => short(m.text, 90)))].slice(0, 4).join(' | ') || 'none'})`);
    }
    await noteLogs(page);
    addInternet('Internet blocked, the main page (checks 1 to 7)', 'blocked', page.externalRequests());
  } finally {
    if (page) noteLogNames(page, null);
    await browser.close();
  }
}

// ------------------------------------------------------------------
// 6. Close and reopen
// ------------------------------------------------------------------

// A real-style session: CONNECT on the stand-in port, then the first
// `count` lines of the moved capture through it at real pace (a status line
// and a packet each second). Returns the page's clock when each line was
// handed to the port. The page's serial link stamps each line itself, a few
// ms later.
async function feedRealSession(page, count) {
  await pressConnect(page);
  const began = Date.now();
  const handed = [];
  for (let i = 0; i < count; i += 1) {
    const due = began + PLAN.times[i] * 1000;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    handed.push(await sendToPort(page, [SHIFTED[i]]));
  }
  return handed;
}

// Where a session's last packet line is, when it went in, and what it said.
function lastPacketOf(sent, handed) {
  const index = sent.map((l, i) => (l.startsWith('PKT ') ? i : -1)).filter((i) => i >= 0).at(-1);
  return { index, ms: handed[index], position: pktPosition(sent[index]) };
}

async function reopenAndRecover(page, server, { sent, handed, label }) {
  const last = lastPacketOf(sent, handed);
  const lastPktMs = last.ms;
  const lastPkt = last.position;
  const opened = Date.now();
  await openLaunch(page, server, LAUNCH, { globe: false });
  try {
    await page.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 60000, message: 'UNSAVED RECORDING FOUND never showed' });
  } catch (err) {
    // What the page saw: the recordings in IndexedDB and the Web Locks held.
    const seen = await page.evaluate(async () => {
      const db = window.fcLaunch.ctx.localConsole.test.db;
      const flights = (await db.listFlights()).map((r) => `${r.id} ${r.status} ${r.lineCount} lines`);
      const q = await navigator.locks.query();
      return { flights, held: (q.held ?? []).map((l) => l.name), pending: (q.pending ?? []).map((l) => l.name) };
    }).catch((e) => ({ problem: e.message }));
    throw new Error(`${err.message}. IndexedDB: ${JSON.stringify(seen)}`);
  }
  note(`(${label}) the offer showed ${seconds(Date.now() - opened)} after the page was asked for`);
  // What the panel shows before RECOVER is pressed. Chrome writes
  // localStorage to disk now and then, so after a kill the saved fix there
  // can be older than the last packet, or missing. The panel reads the
  // newest fix out of the unfinished recording too, and that takes a moment.
  const fixShown = await page.waitFor((w) => {
    const f = window.fcLaunch.parts.panel.status().fix;
    return Boolean(f) && f.lat === w.lat && f.lon === w.lon;
  }, { timeout: 15000, interval: 25, args: [lastPkt], message: 'the last packet\'s fix never showed' }).then(() => true, () => false);
  const fixShownMs = Date.now() - opened;
  await sleep(600);
  const early = await page.evaluate(() => {
    const st = window.fcLaunch.parts.panel.status();
    const el = (id) => document.getElementById(id);
    const offerBox = el('fc-recover');
    const box = offerBox.getBoundingClientRect();
    return {
      now: Date.now(),
      fix: st.fix,
      copyText: st.copyText,
      lat: el('fcl-lat').textContent,
      lon: el('fcl-lon').textContent,
      state: el('fcl-fix-state').textContent,
      detail: el('fcl-fix-detail').hidden ? '' : el('fcl-fix-detail').textContent,
      packet: el('fcl-packet').textContent,
      offered: !offerBox.hidden && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight,
      offer: offerBox.textContent.replace(/\s+/g, ' ').trim(),
      restored: window.fcLaunch.parts.log.status().restored,
    };
  });
  const clock = await clockOf(page, lastPktMs);
  const offer = await recover(page, `6-${label}-recover-offer`);
  await page.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 20000, message: 'the recording did not go back on the live view' });
  await sleep(1000);
  const back = await page.evaluate(() => {
    const l = window.fcLaunch.ctx.live;
    return {
      now: Date.now(),
      restored: window.fcLaunch.parts.log.status().restored,
      samples: l.stores.flight.getRocket('1')?.samples.length ?? 0,
      lastArrival: l.flightFeed.lastArrival('1'),
      fix: window.fcLaunch.parts.panel.status().fix,
      lat: document.getElementById('fcl-lat').textContent,
      lon: document.getElementById('fcl-lon').textContent,
      packet: document.getElementById('fcl-packet').textContent,
      state: document.getElementById('fcl-fix-state').textContent,
    };
  });
  const saved = await savedFlights(page);
  const rec = saved.find((r) => !r.test && r.source === 'recording');
  const same = Boolean(rec) && rec.lines.length === sent.length && rec.lines.every((l, i) => l === sent[i]);
  const pkts = sent.filter((l) => l.startsWith('PKT ')).length;
  const realAge = (back.now - lastPktMs) / 1000;
  await page.click('#fc-saved-button');
  await sleep(500);
  const listed = await page.evaluate(() => [...document.querySelectorAll('.fc-dd-local-item .fc-dd-name')].map((e) => e.textContent.trim()));
  await shot(page, `6-${label}-saved-flights`);
  await page.press('Escape');
  await sleep(300);
  await shot(page, `6-${label}-recovered`);
  return { offer, back, rec, same, pkts, clock, realAge, lastPktMs, lastPkt, listed, early, fixShown, fixShownMs };
}

// What the reopened page showed BEFORE RECOVER was pressed: the last
// packet's fix, the time it really arrived, and what to do next. This is
// what a person sees first after a crash, with the rocket in a field.
function earlyChecks(words, r) {
  const e = r.early;
  const f = e.fix;
  const realAge = (e.now - r.lastPktMs) / 1000;
  const off = f ? Math.round(metersBetween(f, r.lastPkt)) : null;
  check('restore', `${words}: before RECOVER is pressed, the panel shows the last packet's fix`,
    r.fixShown && f?.lat === r.lastPkt.lat && f?.lon === r.lastPkt.lon && e.lat === r.lastPkt.lat.toFixed(6) && e.lon === r.lastPkt.lon.toFixed(6)
      && e.copyText === six(r.lastPkt) && e.restored === null,
    `shown ${e.lat}, ${e.lon}${f ? ` (${off} m from the last packet)` : ' (no fix at all)'}, ${r.fixShown ? `up ${seconds(r.fixShownMs)} after the page was asked for` : 'and the right fix never came up'}. The last PKT line said ${r.lastPkt.lat}, ${r.lastPkt.lon}. COPY COORDINATES would copy "${e.copyText}". RECOVER not pressed yet: ${e.restored === null}`);
  check('restore', `${words}: with the time that packet really arrived`,
    Boolean(f) && Math.abs(f.wallMs - r.lastPktMs) < 250 && Math.abs(f.packetWallMs - r.lastPktMs) < 250 && Math.abs(f.ageS - realAge) < 1.5
      && e.packet.endsWith(`AT ${r.clock}`) && /^SAVED FIX, FROM \d+:\d\d AGO$/.test(e.state),
    `"${e.state}", LAST PACKET "${e.packet}". The packet went into the port at ${r.clock}. The fix's time is off by ${f ? f.wallMs - r.lastPktMs : 'n/a'} ms and the packet's by ${f ? f.packetWallMs - r.lastPktMs : 'n/a'} ms, its age reads ${f?.ageS?.toFixed(1)} s against a real ${realAge.toFixed(1)} s. Read out of the unfinished recording: ${f?.fromRecording}`);
  check('restore', `${words}: and it says to press RECOVER, with RECOVER on the same screen`,
    e.detail === RECOVER_WORDS && f?.unfinished === true && e.offered && /UNSAVED RECORDING FOUND/.test(e.offer) && /RECOVER/.test(e.offer),
    `the panel says "${e.detail}". The offer is ${e.offered ? 'on screen' : 'NOT on screen'}: "${short(e.offer, 130)}"`);
}

function restoreChecks(label, words, sent, r, serverInfo) {
  earlyChecks(words, r);
  check('restore', `${words}: RECOVER brings back every line written before it`,
    r.rec && r.same && r.back.restored?.lines === sent.length && r.back.samples === r.pkts,
    `${sent.length} lines sent (${r.pkts} PKT), ${r.rec?.lines.length ?? 0} came back from IndexedDB (${r.same ? 'the same lines in order' : 'NOT the same'}), ${r.back.restored?.lines} played back onto the live view, rocket 1 has ${r.back.samples} samples. The server copy has ${serverInfo}. The offer said: "${short(r.offer, 140)}"`);
  check('restore', `${words}: the panel shows the restored fix with its real time`,
    r.back.fix?.lat === r.lastPkt.lat && r.back.fix?.lon === r.lastPkt.lon && r.back.lat === r.lastPkt.lat.toFixed(6)
      && Math.abs(r.back.lastArrival - r.lastPktMs) < 250 && Math.abs(r.back.fix.packetWallMs - r.lastPktMs) < 250 && Math.abs(r.back.fix.ageS - r.realAge) < 2 && r.back.packet.endsWith(`AT ${r.clock}`),
    `${r.back.lat}, ${r.back.lon} ("${r.back.state}", LAST PACKET "${r.back.packet}"). The last PKT went into the port at ${r.clock}, the feed's arrival time is off by ${r.back.lastArrival - r.lastPktMs} ms and packetWallMs by ${r.back.fix ? r.back.fix.packetWallMs - r.lastPktMs : 'n/a'} ms, age ${r.back.fix?.ageS?.toFixed(1)} s against a real ${r.realAge.toFixed(1)} s`);
  check('restore', `${words}: the recording is in SAVED FLIGHTS`, r.rec && r.listed.some((l) => l.startsWith(r.rec.title)),
    `"${r.rec?.title}". The menu lists ${r.listed.map((l) => `"${short(l, 60)}"`).join(', ')}`);
}

// Starts Chrome again on a profile a killed Chrome just used. Its last
// processes can hold the profile for a few seconds after the kill (Chrome
// then ends at once with exit code 21), so it tries again for a while.
async function relaunch(options, tries = 10) {
  for (let i = 1; ; i += 1) {
    try {
      return await launchChrome(options);
    } catch (err) {
      if (i >= tries || !/exit code 21\b/.test(err.message)) throw err;
      note(`Chrome still had the profile after the kill (try ${i}), so it waits a second and tries again`);
      await sleep(1000);
    }
  }
}

async function restoreRuns(server) {
  heading('Close and reopen, internet blocked');
  // (a) The tab is closed part way through.
  const profileA = path.join(os.tmpdir(), `fc-acceptance-${process.pid}-close`);
  profiles.push(profileA);
  let browser = await launchChrome({ network: 'blocked', userDataDir: profileA, windowSize: LAPTOP, args: GPU });
  try {
    const page = await launchPageWithPort(browser, server);
    const count = 36;
    const handed = await feedRealSession(page, count);
    await sleep(500);
    const before = await logStatus(page);
    noteLogNames(page, before);
    addInternet('Internet blocked, close and reopen (check 6)', 'blocked', page.externalRequests());
    const sent = SHIFTED.slice(0, count);
    note(`(a) CONNECT on the stand-in port, then ${count} lines at real pace over ${seconds(handed.at(-1) - handed[0])} (planned ${(PLAN.times[count - 1] - PLAN.times[0]).toFixed(1)} s). The browser copy had ${before.browser.lines} when the tab was closed`);
    await page.close();
    await sleep(1500);
    const page2 = await browser.newPage();
    const r = await reopenAndRecover(page2, server, { sent, handed, label: 'tab-closed' });
    const serverText = fs.existsSync(path.join(LOGS, before.server.name)) ? fs.readFileSync(path.join(LOGS, before.server.name), 'utf8') : '';
    const cmp = compareLog(serverText, sent);
    restoreChecks('a', '(a) tab closed', sent, r, `${cmp.data.length} lines${cmp.ok ? ', every one' : ` (${cmp.problems.join('. ')})`}`);
    await noteLogs(page2);
    addInternet('Internet blocked, close and reopen (check 6)', 'blocked', page2.externalRequests());
    check('restore', '(a) no exceptions after reopening', page2.exceptions().length === 0, `${page2.exceptions().length} exceptions`);
  } finally {
    await browser.close();
  }

  // (b) Chrome is killed about a second after the last packet.
  const count = 30;
  const sent = SHIFTED.slice(0, count);
  let session = null;
  for (let attempt = 1; ; attempt += 1) {
    const profile = path.join(os.tmpdir(), `fc-acceptance-${process.pid}-kill-${attempt}`);
    profiles.push(profile);
    browser = await launchChrome({ network: 'blocked', userDataDir: profile, windowSize: LAPTOP, args: GPU });
    try {
      const page = await launchPageWithPort(browser, server);
      const handed = await feedRealSession(page, count);
      const last = lastPacketOf(sent, handed);
      // One second after the last packet, on the page's own clock.
      const since = await page.evaluate((t) => Date.now() - t, last.ms);
      await sleep(Math.max(0, 1000 - since - 30));
      const before = await page.evaluate((t) => ({
        killedAfterMs: Date.now() - t,
        status: window.fcLaunch.parts.log.status(),
        picked: window.__fake.pickedName,
        calls: `save box ${window.__fake.pickerCalls} time, port list ${window.__fake.requestCalls} time`,
      }), last.ms);
      await browser.kill();
      noteLogNames(page, before.status);
      addInternet('Internet blocked, close and reopen (check 6)', 'blocked', page.externalRequests());
      session = { profile, handed, last, ...before };
    } catch (err) {
      await browser.close();
      throw err;
    }
    if (session.killedAfterMs <= KILL_LATEST_MS || attempt >= KILL_TRIES) break;
    note(`(b) the laptop stalled: Chrome was killed ${session.killedAfterMs} ms after the last packet, not about 1,000. The session is run again.`);
  }
  note(`(b) CONNECT on the stand-in port (${session.calls}), then ${count} lines at real pace over ${seconds(session.handed.at(-1) - session.handed[0])} (planned ${(PLAN.times[count - 1] - PLAN.times[0]).toFixed(1)} s). The browser copy had ${session.status.browser.lines} when Chrome was killed`);
  check('restore', '(b) Chrome was killed about a second after the last packet', session.killedAfterMs >= 900 && session.killedAfterMs <= KILL_LATEST_MS,
    `${session.killedAfterMs} ms after the last PKT line went into the port`);
  browser = await relaunch({ network: 'blocked', userDataDir: session.profile, windowSize: LAPTOP, args: GPU });
  try {
    const page2 = await browser.newPage();
    const r = await reopenAndRecover(page2, server, { sent, handed: session.handed, label: 'chrome-killed' });
    // The two files, as the kill left them. Each is written about once a
    // second, and a killed Chrome writes nothing more.
    const serverName = session.status.server.name;
    const serverText = serverName && fs.existsSync(path.join(LOGS, serverName)) ? fs.readFileSync(path.join(LOGS, serverName), 'utf8') : '';
    const diskText = await page2.evaluate(async (name) => {
      try {
        const dir = await navigator.storage.getDirectory();
        return await (await (await dir.getFileHandle(name)).getFile()).text();
      } catch (err) {
        return '';
      }
    }, session.picked);
    const onServer = logPrefix(serverText, sent);
    const onDisk = logPrefix(diskText, sent);
    const killAt = session.last.ms + session.killedAfterMs;
    const mustHave = session.handed.filter((t) => t <= killAt - KILL_KEPT_MS).length;
    restoreChecks('b', '(b) Chrome killed', sent, r, `${onServer.n} lines`);
    check('restore', '(b) Chrome killed: the disk file and the server copy kept every line but the last seconds',
      onDisk.ok && onDisk.n >= mustHave && onServer.ok && onServer.n >= mustHave,
      `${count} lines went in, ${mustHave} of them more than ${KILL_KEPT_MS / 1000} s before the kill. The disk file (${session.picked}) has the first ${onDisk.n}${onDisk.ok ? ', in order' : ` (${onDisk.problems.join('. ')})`}. The server copy (flight-logs/${serverName}) has the first ${onServer.n}${onServer.ok ? ', in order' : ` (${onServer.problems.join('. ')})`}. The browser copy gave back all ${r.rec?.lines.length ?? 0}`);
    await noteLogs(page2);
    addInternet('Internet blocked, close and reopen (check 6)', 'blocked', page2.externalRequests());
    check('restore', '(b) no exceptions after reopening', page2.exceptions().length === 0, `${page2.exceptions().length} exceptions`);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// 8 to 11. One page with the stand-in port
// ------------------------------------------------------------------
// The test's server on --port. Check 11 stops it and starts it again, so
// every run reads it from here.
let testServer = null;

async function portRun() {
  heading('One page with the stand-in port, CONNECT pressed once, internet blocked');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: GPU });
  const sent = [];             // every receiver line handed to the port, in order
  let cursor = 0;              // the next line of the moved capture
  let serverDown = false;
  let page = null;
  try {
    page = await launchPageWithPort(browser, testServer);
    // Sends the next status line and packet of the moved capture, with the
    // packet's position changed when `to` is given. Returns the position
    // the packet says.
    const sendPair = async (to = null) => {
      const pair = [SHIFTED[cursor], SHIFTED[cursor + 1]];
      if (!pair[0]?.startsWith('# ') || !pair[1]?.startsWith('PKT ')) throw new Error(`the capture has no status line and packet at line ${cursor + 1}`);
      cursor += 2;
      if (to) pair[1] = movePkt(pair[1], to);
      await sendToPort(page, pair);
      sent.push(...pair);
      return pktPosition(pair[1]);
    };
    const sendPairs = async (n, gapMs = 250) => {
      let last = null;
      for (let i = 0; i < n; i += 1) {
        last = await sendPair();
        await sleep(gapMs);
      }
      return last;
    };
    const sameLines = (lines) => lines.length === sent.length && lines.every((l, i) => l === sent[i]);
    const logWords = (cmp) => `${cmp.data.length} lines${cmp.ok ? ', every one in order' : ` (${cmp.problems.join('. ')})`}`;

    // CONNECT. The port is open, and the receiver has said nothing yet.
    // Check 8 counts its times from the click, a moment before the port
    // opened, so they are never shorter than the page's own count.
    const pressedAt = Date.now();
    await pressConnect(page);
    const asked = await page.evaluate(() => ({ picker: window.__fake.pickerCalls, list: window.__fake.requestCalls, name: window.__fake.names[0] ?? '' }));
    noteLogNames(page, await logStatus(page));

    // ---- 8. the port sends nothing
    if (want('silent')) {
      await sleep(Math.max(0, NO_DATA_QUIET_MS - (Date.now() - pressedAt)));
      const early = await page.evaluate(() => window.fcLaunch.parts.log.status().alerts.receiver);
      const earlyMs = Date.now() - pressedAt;
      const warned = await page.waitFor(() => window.fcLaunch.parts.log.status().alerts.receiver?.kind === 'warn',
        { timeout: 30000, interval: 50, message: 'no warning for a port that sends nothing' }).then(() => true, () => false);
      const warnedMs = Date.now() - pressedAt;
      await sleep(600);
      const line = await barLine(page, 'fcl-receiver-alert');
      const row = await page.evaluate(() => ({
        text: (document.getElementById('fcl-log-lines')?.textContent ?? '').replace(/^0(?=\D)/, '0, '),
        state: document.querySelector('.fcl-log-row--lines')?.dataset.state ?? null,
      }));
      await shot(page, '8-port-sends-nothing');
      check('silent', 'a connected port that sends nothing: no warning after 6 s, the NO DATA warning within about 10 s',
        early === null && earlyMs < 8000 && warned && warnedMs < NO_DATA_LATEST_MS && line.shown && line.onScreen && line.kind === 'warn' && line.tag === 'NO DATA'
          && /^Nothing has come from this port in \d+ seconds\. It may be the wrong port\./.test(line.text) && /Press DISCONNECT, then CONNECT, and pick the receiver's port\.$/.test(line.text),
        `CONNECT showed the save box ${asked.picker} time (it suggested ${asked.name}) and the port list ${asked.list} time. ${seconds(earlyMs)} after CONNECT was pressed there was ${early ? `ALREADY a warning (${early.tag})` : 'no warning'}. The warning came ${seconds(warnedMs)} after the press (the page's limit is 8 s from the moment the port opens). ${line.tag || 'No line'}: "${line.text}" (${line.onScreen ? 'on screen' : 'NOT on screen'}, ${line.box}). The LINES row reads "${row.text}" (${row.state})`);
    }

    // Six good packets, as the receiver sends them once it hears the rocket.
    let good = await sendPairs(6);
    if (want('silent')) {
      const cleared = await page.waitFor(() => window.fcLaunch.parts.log.status().alerts.receiver === null, { timeout: 5000, interval: 50 }).then(() => true, () => false);
      await sleep(400);
      const line = await barLine(page, 'fcl-receiver-alert');
      check('silent', 'the warning clears when lines arrive', cleared && !line.shown,
        `after 12 lines the line under the bar ${line.shown ? `STAYED ("${line.tag}: ${line.text}")` : 'is gone'}`);
    }

    // ---- 9. packets that must not take the fix
    if (want('badfix')) {
      const fixOn = (p, state) => page.waitFor((w, s) => {
        const f = window.fcLaunch.parts.panel.status().fix;
        return Boolean(f) && f.lat === w.lat && f.lon === w.lon && document.getElementById('fcl-fix-state').textContent === s;
      }, { timeout: 5000, interval: 50, args: [p, state] }).then(() => true, () => false);
      const heard = (n) => page.waitFor((count) => {
        const c = window.fcLaunch.ctx.live.flightFeed.counts;
        return c.samples + c.bad >= count;
      }, { timeout: 5000, interval: 25, args: [n] }).then(() => true, () => false);
      const stays = (r) => r.fix?.lat === good.lat && r.fix?.lon === good.lon && r.lat === good.lat.toFixed(6) && r.lon === good.lon.toFixed(6) && r.copyText === six(good);
      const kept = (r) => r.saved?.lat === good.lat && r.saved?.lon === good.lon;
      const shownWords = (r) => `the readout shows ${r.lat}, ${r.lon} ("${r.state}"${r.detail ? ` "${r.detail}"` : ''}), COPY COORDINATES would copy "${r.copyText}", localStorage has ${r.saved ? six(r.saved) : 'no fix'}${r.under ? `. Under the readout: ${r.under}` : ''}`;

      await fixOn(good, 'CURRENT FIX');
      const r0 = await readout(page);
      // A packet with fix=yes and 12 satellites, 50 km due east of the last one.
      const farAt = { lat: good.lat, lon: good.lon + 50000 / (111320 * Math.cos(rad(good.lat))) };
      const far = await sendPair(farAt);
      await heard(r0.heard + 1);
      await sleep(700);
      const r1 = await readout(page);
      await shot(page, '9-packet-50-km-away');
      // And one at 0, 0, still with fix=yes.
      await sendPair({ lat: 0, lon: 0 });
      await heard(r1.heard + 1);
      await sleep(700);
      const r2 = await readout(page);
      await shot(page, '9-packet-at-0-0');
      // The rocket's next true packet.
      const next = await sendPair();
      const current = await fixOn(next, 'CURRENT FIX');
      const r3 = await readout(page);

      check('badfix', 'six good packets: the last one is the current fix and the saved fix', r0.state === 'CURRENT FIX' && stays(r0) && kept(r0),
        `the sixth packet said ${good.lat}, ${good.lon}. ${shownWords(r0)}`);
      check('badfix', 'a fix=yes packet 50 km away does not take the readout or the saved fix',
        r1.heard === r0.heard + 1 && stays(r1) && kept(r1) && r1.fix?.old === true && r1.state !== 'CURRENT FIX',
        `the packet said ${six(far)}, ${(metersBetween(good, far) / 1000).toFixed(1)} km from the good fix, and reached the flight store (${r1.heard} packets heard). ${shownWords(r1)}`);
      check('badfix', 'a packet at 0, 0 does not take the readout or the saved fix',
        r2.heard === r1.heard + 1 && stays(r2) && kept(r2) && r2.state !== 'CURRENT FIX',
        `the packet said 0.000000, 0.000000 and reached the flight store (${r2.heard} packets heard). ${shownWords(r2)}`);
      check('badfix', 'the next good packet is the current fix again', current && r3.state === 'CURRENT FIX' && r3.saved?.lat === next.lat && r3.saved?.lon === next.lon,
        `the packet said ${next.lat}, ${next.lon}. ${shownWords(r3)}`);
      good = next;
    }

    // ---- 10. the cable comes out and goes back in
    if (want('reconnect')) {
      await sleep(300);
      await page.evaluate(() => window.__fake.unplug());
      const lostSeen = await page.waitFor(() => window.fcLaunch.parts.log.status().link.reconnecting === true,
        { timeout: 10000, interval: 20, message: 'the page did not start to reconnect' }).then(() => true, () => false);
      await sleep(2500);
      const lostLine = await barLine(page, 'fcl-receiver-alert');
      const lostView = await page.evaluate(() => ({
        button: document.getElementById('bc-connect-text')?.textContent ?? '',
        open: Boolean(window.fcLaunch.ctx.live.link.open),
        nameBox: Boolean(document.querySelector('dialog.fc-dialog')?.open),
        fix: document.getElementById('fcl-lat').textContent,
      }));
      await shot(page, '10-port-lost');
      check('reconnect', 'a lost port is said under the bar, with what the page is doing about it',
        lostSeen && lostLine.shown && lostLine.onScreen && lostLine.kind === 'warn' && lostLine.tag === 'RECEIVER LOST'
          && /^The receiver's port was lost at \d\d:\d\d:\d\d\. The page is trying to reconnect by itself/.test(lostLine.text) && /plug it back in/.test(lostLine.text)
          && lostView.button === 'DISCONNECT' && !lostView.open && !lostView.nameBox && lostView.fix === good.lat.toFixed(6),
        `${lostLine.tag || 'No line'}: "${lostLine.text}" (${lostLine.onScreen ? 'on screen' : 'NOT on screen'}). The bar's button reads ${lostView.button}, no name box is in the way (${!lostView.nameBox}), and the readout still shows latitude ${lostView.fix}`);

      const replugAt = Date.now();
      await page.evaluate(() => window.__fake.replug());
      const reopened = await page.waitFor(() => Boolean(window.fcLaunch.ctx.live.link.open),
        { timeout: 20000, interval: 20, message: 'the page did not open the port again' }).then(() => true, () => false);
      const backMs = Date.now() - replugAt;
      good = await sendPairs(8);
      const settled = await copiesSettled(page);
      await sleep(400);
      const backLine = await barLine(page, 'fcl-receiver-alert');
      await shot(page, '10-port-back');
      const c = await threeCopies(page);
      noteLogNames(page, c.status);
      const disk = compareLog(c.disk, sent);
      const onServer = compareLog(c.serverText, sent);
      const marks = /\n# connection closed [^\n]+\n# connected [^\n]+\n/.test(c.disk);
      const flightLogs = c.status.logs.filter((l) => l.kind === 'flight').length;
      check('reconnect', 'the stand-in port comes back and the page opens it by itself, with nothing clicked',
        reopened && backMs < RECONNECT_LATEST_MS && c.fake.pickerCalls === 1 && c.fake.requestCalls === 1 && c.fake.opens === 2
          && Boolean(c.status.link.back) && !c.status.link.reconnecting && backLine.shown && backLine.tag === 'RECEIVER BACK' && /The page reconnected by itself/.test(backLine.text),
        `the port was open again ${seconds(backMs)} after the cable went back in. In the whole visit the save box showed ${c.fake.pickerCalls} time, the port list ${c.fake.requestCalls} time, and a port was opened ${c.fake.opens} times. ${backLine.tag || 'No line'}: "${backLine.text}"`);
      check('reconnect', 'the lines carry on in all three copies, in the same files',
        settled && disk.ok && onServer.ok && sameLines(c.browser) && marks && flightLogs === 1,
        `${sent.length} lines sent, ${sent.length - 16} before the cable came out and 16 after. The disk file (${c.fake.pickedName}) has ${logWords(disk)}, with "# connection closed" and "# connected" between (${marks}). The server copy (flight-logs/${c.serverName}) has ${logWords(onServer)}. The browser copy has ${c.browser.length} lines in ${c.parts.length} recordings (${c.parts.join(' + ')}), ${sameLines(c.browser) ? 'the same lines in order' : 'NOT the same'}. Flight logs this visit: ${flightLogs}`);
    }

    // ---- 11. the server is stopped and started again
    if (want('server')) {
      if (!testServer.owned) {
        check('server', 'the test\'s own server can be stopped', false,
          `port ${ARGS.port} was already served when this test began (process ${testServer.pid}), and this test only stops a server it started. Stop that one or pick another --port, and run this check again.`);
      } else {
        await copiesSettled(page);
        const start = await logStatus(page);
        const linesBefore = sent.length;
        const stoppedPid = testServer.pid;
        noteServerLogs(testServer);
        await testServer.stop();
        serverDown = true;
        const stopAt = Date.now();
        // The receiver keeps sending, two lines every half second.
        let warnedMs = null;
        for (let pairs = 1; pairs <= 40; pairs += 1) {
          await sendPair();
          await sleep(480);
          if (warnedMs === null && await page.evaluate(() => Boolean(window.fcLaunch.parts.log.status().alerts.server))) warnedMs = Date.now() - stopAt;
          if (warnedMs !== null && pairs >= 16 && Date.now() - stopAt > warnedMs + 2000) break;
        }
        const keptUp = await copiesSettled(page, { server: false, timeout: 10000 });
        await sleep(500);
        const downLine = await barLine(page, 'fcl-server-alert');
        const downRow = await page.evaluate(() => ({
          text: (document.getElementById('fcl-log-server')?.textContent ?? '').replace(/flight-logs.*/, '').trim(),
          state: document.querySelector('.fcl-log-row--server')?.dataset.state ?? null,
        }));
        await shot(page, '11-server-stopped');
        const down = await threeCopies(page);
        const downDisk = compareLog(down.disk, sent);
        const downServer = logPrefix(down.serverText, sent);
        const whileDown = sent.length - linesBefore;
        check('server', 'with the server stopped, the SERVER STOPPED warning shows under the bar',
          warnedMs !== null && warnedMs < SERVER_WARN_LATEST_MS && downLine.shown && downLine.onScreen && downLine.kind === 'warn' && downLine.tag === 'SERVER STOPPED'
            && /^The launch mode server has stopped\./.test(downLine.text) && /Do not reload or close this page\./.test(downLine.text) && /launch-mode\.bat/.test(downLine.text) && downRow.state === 'warn',
          `the test's server (process ${stoppedPid}, port ${ARGS.port}) was stopped. The warning came ${warnedMs === null ? 'NEVER' : `after ${seconds(warnedMs)}`} (the page's limit is 5 s). ${downLine.tag || 'No line'}: "${downLine.text}" (${downLine.onScreen ? 'on screen' : 'NOT on screen'}). The SERVER row reads "${downRow.text}" (${downRow.state}), and the page says the server is "${down.status.presence}"`);
        check('server', 'the disk file and the browser copy keep saving while it is stopped',
          keptUp && downDisk.ok && sameLines(down.browser) && down.status.file.state === 'saving' && down.status.file.pending === 0 && downServer.ok && downServer.n < sent.length && down.status.server.pending > 0,
          `${whileDown} more lines arrived while it was stopped, ${sent.length} in all. The disk file has ${logWords(downDisk)}. The browser copy has ${down.browser.length} (${sameLines(down.browser) ? 'the same lines in order' : 'NOT the same'}). The server copy on disk stopped at ${downServer.n}, and the page holds ${down.status.server.pending} lines for it`);

        // The server's window is opened again: the same port.
        testServer = await startServer({ port: ARGS.port, verbose: true });
        serverDown = false;
        const backAt = Date.now();
        const caught = await page.waitFor(() => {
          const s = window.fcLaunch.parts.log.status();
          return !s.alerts.server && s.server.state === 'saving' && s.server.pending === 0;
        }, { timeout: 30000, interval: 50, message: 'the server copy did not catch up' }).then(() => true, () => false);
        const caughtMs = Date.now() - backAt;
        good = await sendPairs(4);
        const settled = await copiesSettled(page);
        await sleep(500);
        const upLine = await barLine(page, 'fcl-server-alert');
        await shot(page, '11-server-back');
        const up = await threeCopies(page);
        noteLogNames(page, up.status);
        const upServer = compareLog(up.serverText, sent);
        const upDisk = compareLog(up.disk, sent);
        check('server', 'started again on the same port: the warning clears and the server copy catches up, no line lost or doubled',
          caught && caughtMs < SERVER_BACK_LATEST_MS && settled && !upLine.shown && upServer.ok && upDisk.ok && up.serverText === up.disk && sameLines(up.browser) && up.serverName === start.server.name,
          `a new server (process ${testServer.pid}) on port ${ARGS.port}. ${caught ? `The warning was gone and nothing was waiting ${seconds(caughtMs)} later` : 'The server copy did NOT catch up'}. 8 more lines were sent after that, ${sent.length} in all. flight-logs/${up.serverName} (${up.serverName === start.server.name ? 'the same file as before' : 'NOT the file from before'}) has ${logWords(upServer)}, ${up.serverText === up.disk ? 'byte for byte the same as the disk file' : 'DIFFERENT from the disk file'}. The disk file has ${logWords(upDisk)}, the browser copy ${up.browser.length} lines (${sameLines(up.browser) ? 'the same' : 'NOT the same'})`);
      }
    }

    // DISCONNECT, as at the end of the day.
    await page.click('#bc-connect');
    await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'DISCONNECT did not close the port' }).catch(() => {});
    await page.evaluate(() => window.fcLaunch.parts.log.flush()).catch(() => {});
    const ex = page.exceptions();
    check(PORT_STEPS.find(want), 'no page exceptions on the page with the stand-in port', ex.length === 0,
      `${ex.length} exceptions${ex.length ? `: ${ex.map((e) => short(e.text, 100)).join(' | ')}` : ''}`);
    await noteLogs(page);
    addInternet('Internet blocked, the stand-in port page (checks 8 to 11)', 'blocked', page.externalRequests());
  } finally {
    if (page) noteLogNames(page, null);
    await browser.close();
    // Whatever happened above, the runs after this one need the server.
    if (serverDown) testServer = await startServer({ port: ARGS.port, verbose: true });
  }
}

// ------------------------------------------------------------------
// 12. A flight first heard in the air
// ------------------------------------------------------------------
async function groundRun(server) {
  heading('A flight first heard in the air, internet blocked');
  const fieldElev = FIELD_JSON.groundElevM;
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: GPU });
  try {
    const page = await launchPageWithPort(browser, server);
    await pressConnect(page);
    noteLogNames(page, await logStatus(page));
    // The receiver is plugged in late. The first packets it hears come from
    // a rocket straight over the field center, already climbing at 60 m/s,
    // a second apart on the rocket's own clock (up_s).
    const alts = [350, 410, 470, 530, 590, 650];
    for (const [i, alt] of alts.entries()) {
      await sendToPort(page, [
        `# DEKEL_RX listening good=${i} bad=0 last_good_s_ago=0.9 rx_up_s=${(40 + i).toFixed(1)}`,
        `PKT node=1 seq=${i} up_s=${(300 + i).toFixed(1)} fix=yes sats=12 hdop=0.90 lat=${FIELD.lat.toFixed(7)} lon=${FIELD.lon.toFixed(7)} alt_m=${alt.toFixed(2)} spd_mps=1.20 crs_deg=90.00 utc=17:30:${String(i).padStart(2, '0')}.000 airborne=yes rssi_dbm=-92.0 snr_db=8.50 missed=0`,
      ]);
      await sleep(250);
    }
    const lastAlt = alts.at(-1);
    await page.waitFor((alt) => window.fcLaunch.parts.panel.status().fix?.altM === alt
      && Number.isFinite(window.fcLaunch.ctx.live.stores.flight?.getRocket('1')?.derived?.groundRef),
    { timeout: 10000, interval: 50, args: [lastAlt], message: 'the flight store never took a ground height' }).catch((err) => note(err.message));
    await sleep(600);
    const seen = await page.evaluate(() => {
      const rocket = window.fcLaunch.ctx.live.stores.flight?.getRocket('1');
      const d = rocket?.derived ?? {};
      const st = window.fcLaunch.parts.panel.status();
      const agl = document.getElementById('fcl-agl');
      return {
        samples: rocket?.samples.length ?? 0,
        groundRef: d.groundRef ?? null,
        groundEstimated: d.groundEstimated ?? null,
        startedInFlight: d.startedInFlight ?? null,
        phase: d.phase ?? null,
        liftoff: d.events?.liftoff?.message ?? '',
        altM: st.fix?.altM ?? null,
        aglM: st.fix?.aglM ?? null,
        aglShown: Boolean(agl) && !agl.closest('.fcl-row').hidden,
        agl: agl?.textContent ?? '',
        alt: document.getElementById('fcl-alt')?.textContent ?? '',
        setting: window.fcLaunch.settings?.field?.groundElevM ?? null,
      };
    });
    await shot(page, '12-first-heard-in-the-air');
    const wantAgl = lastAlt - fieldElev;
    check('ground', 'the flight store takes the ground height from launch-mode/field.json',
      Number.isFinite(fieldElev) && fieldElev !== GROUND_ELEV_FALLBACK_M && seen.samples === alts.length && seen.startedInFlight === true && seen.groundEstimated === true && seen.groundRef === fieldElev,
      `field.json says groundElevM ${fieldElev} (the page read ${seen.setting}), config.js's own guess is ${GROUND_ELEV_FALLBACK_M}. After ${seen.samples} packets climbing from ${alts[0]} to ${lastAlt} m, the store's ground height is ${seen.groundRef} m (estimated ${seen.groundEstimated}, started in flight ${seen.startedInFlight}, phase "${seen.phase}"). It says: "${short(seen.liftoff, 220)}"`);
    check('ground', 'ABOVE GROUND is the GPS altitude minus the field\'s ground height',
      seen.altM === lastAlt && seen.aglM === wantAgl && seen.aglShown && seen.agl === `${wantAgl.toLocaleString('en-US', { maximumFractionDigits: 0 })} M, ESTIMATED`,
      `GPS ALTITUDE "${seen.alt}", ABOVE GROUND "${seen.agl}"${seen.aglShown ? '' : ' (the row is hidden)'}, status ${seen.aglM}. ${lastAlt} minus ${fieldElev} is ${wantAgl}. Minus ${GROUND_ELEV_FALLBACK_M} it would be ${lastAlt - GROUND_ELEV_FALLBACK_M}`);
    await page.click('#bc-connect');
    await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'DISCONNECT did not close the port' }).catch(() => {});
    await page.evaluate(() => window.fcLaunch.parts.log.flush()).catch(() => {});
    check('ground', 'no page exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    await noteLogs(page);
    addInternet('Internet blocked, first heard in the air (check 12)', 'blocked', page.externalRequests());
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// 13. The tarpit run
// ------------------------------------------------------------------
async function tarpitRun(server) {
  heading('Internet up but dead (tarpit: connections open and never answer)');
  const browser = await launchChrome({ network: 'tarpit', windowSize: LAPTOP, args: GPU });
  try {
    const page = await browser.newPage();
    const t = await openLaunch(page, server);
    const played = await page.evaluate(() => {
      window.__acc = { result: null };
      window.fcLaunch.parts.capture.play({ speed: 20, shift: 'field' }).then((r) => { window.__acc.result = r; window.__acc.endedAt = Date.now(); });
      return true;
    });
    const playingAt = await page.waitFor(() => (window.fcLaunch.parts.capture.status().playing ? Date.now() : false), { timeout: 20000, interval: 20, message: 'the capture never started' });
    const result = await page.waitFor(() => window.__acc.result, { timeout: 60000, interval: 20, message: 'the capture never ended' });
    const endedAt = await page.evaluate(() => window.__acc.endedAt);
    timings.tarpit = { ...t, captureMs: endedAt - playingAt };
    const status = await page.waitFor((n) => {
      const s = window.fcLaunch.parts.log.status();
      return s.server.pending === 0 && s.browser.lines === n ? s : false;
    }, { timeout: 20000, args: [SHIFTED.length], message: 'the log did not catch up' }).catch(() => null);
    noteLogNames(page, status);
    const feed = await page.evaluate(() => ({ counts: window.fcLaunch.ctx.live.flightFeed.counts, online: window.fcLaunch.online.get() }));
    await sleep(1000);
    await shot(page, '13-tarpit-after-capture');
    const b = timings.blocked;
    if (want('tarpit')) {
      check('tarpit', 'the page starts as fast as with the internet blocked',
        played && b && t.startMs - b.startMs < TARPIT_SLACK_S * 1000 && t.panelMs - b.panelMs < TARPIT_SLACK_S * 1000,
        `window.fcStarted after ${seconds(t.startMs)} (blocked ${b ? seconds(b.startMs) : 'not run'}), the panel after ${seconds(t.panelMs)} (blocked ${b ? seconds(b.panelMs) : 'not run'})`);
      check('tarpit', 'the 3D view is ready as fast as with the internet blocked',
        b && t.globeMs - b.globeMs < TARPIT_SLACK_S * 1000,
        `first picture after ${seconds(t.globeMs)} (blocked ${b ? seconds(b.globeMs) : 'not run'})`);
      check('tarpit', 'the capture plays at the same speed, and every packet arrives',
        result.ok && result.sent === SHIFTED.length && b?.captureMs && Math.abs(timings.tarpit.captureMs - b.captureMs) < 1500 && feed.counts.samples === CAPTURE_PKTS,
        `${result.sent} of ${result.total} lines in ${seconds(timings.tarpit.captureMs)} (blocked ${b?.captureMs ? seconds(b.captureMs) : 'not run'}), ${feed.counts.samples} samples in the flight store, online says ${feed.online}`);
      check('tarpit', 'no page exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    }
    // Requests still out are given time to end the way they will.
    await sleep(9000);
    await noteLogs(page);
    const hosts = browser.tarpit.connections().map((c) => c.host ?? 'a host that did not say its name');
    internet.push({ run: 'Internet up but dead (tarpit)', network: 'tarpit', requests: page.externalRequests(), tarpitHosts: hosts });
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// 14. The requests that tried to reach the internet
// ------------------------------------------------------------------
// Which part of the page makes each kind of request, read from the code.
const SOURCES = [
  {
    test: (u) => u.hostname === 'www.google.com' && u.pathname === '/generate_204',
    part: 'the online check, createOnlineWatch() in js/launch/launch-mode.js: once at start, then every 30 s and on the browser\'s online and offline events. It gives up after 4 s.',
  },
  {
    test: (u) => u.hostname === 'static-map-tiles-api.arcgis.com' && /\/labels\/static$/.test(u.pathname),
    part: 'the Esri key check, checkEsriKey() in js/views/esri.js, asked by the 3D view\'s ground (js/launch/offline-globe.js) and the 2D map\'s background (js/launch/offline-leaflet.js, tryOnline). A check still out is shared, so one that fails at once is sent again by the other map. Each gives up after 8 s, and with no internet they only ask again when the online check says it is back, or when SATELLITE is pressed while the 2D map shows.',
  },
  {
    test: (u) => u.hostname === 'ibasemaps-api.arcgis.com' && /\/tile\//.test(u.pathname),
    part: 'Esri photo tiles (offline-globe.js or offline-leaflet.js), only after the key check said yes',
  },
  {
    test: (u) => u.hostname === 'ibasemaps-api.arcgis.com' && /\/tilemap\//.test(u.pathname),
    part: 'Esri tilemap (esri.js, which photos exist) for the 2D map\'s Esri layer',
  },
  {
    test: (u) => u.hostname === 'static-map-tiles-api.arcgis.com' && /\/labels\/static\/tile\//.test(u.pathname),
    part: 'Esri place names on the 2D map (offline-leaflet.js addLabels)',
  },
];
const sourceOf = (url) => {
  try {
    const u = new URL(url);
    return SOURCES.find((s) => s.test(u))?.part ?? null;
  } catch {
    return null;
  }
};
const shortPath = (url) => {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 70 ? `${u.pathname.slice(0, 40)}...${u.pathname.slice(-25)}` : u.pathname;
    return `${p}${u.search ? (u.search.includes('token=') ? '?token=(the Esri key)' : '?...') : ''}`;
  } catch {
    return short(url, 80);
  }
};
const outcome = (r) => {
  if (r.pending) return 'no answer by the time the page closed';
  if (r.failed) return `failed after ${r.ms ?? '?'} ms: ${r.errorText}`;
  return `answered ${r.status} in ${r.ms ?? '?'} ms`;
};

function requestReport() {
  heading('14. Every request that tried to reach the internet');
  const lines = [];
  let unknown = 0;
  let answered = 0;
  for (const run of internet) {
    console.log(`\n  ${run.run}: ${run.requests.length} requests`);
    const groups = new Map();
    for (const r of run.requests) {
      const u = new URL(r.url);
      const key = `${u.hostname} ${shortPath(r.url)}`;
      if (!groups.has(key)) groups.set(key, { host: u.hostname, path: shortPath(r.url), list: [], part: sourceOf(r.url), from: new Set() });
      groups.get(key).list.push(r);
      groups.get(key).from.add(r.target);
    }
    if (!groups.size) console.log('    none');
    for (const g of groups.values()) {
      const outcomes = new Map();
      for (const r of g.list) {
        const o = outcome(r).replace(/after \d+(\.\d+)? ms/, 'after N ms').replace(/in \d+(\.\d+)? ms/, 'in N ms');
        outcomes.set(o, [...(outcomes.get(o) ?? []), r.ms]);
      }
      const span = (ms) => {
        const known = ms.filter((x) => x !== null);
        if (!known.length) return '? ms';
        const lo = Math.min(...known).toFixed(0);
        const hi = Math.max(...known).toFixed(0);
        return lo === hi ? `${lo} ms` : `${lo} to ${hi} ms`;
      };
      const what = [...outcomes.entries()].map(([o, ms]) => `${ms.length} ${o.replace('N ms', span(ms))}`).join(', ');
      if (!g.part) unknown += g.list.length;
      answered += g.list.filter((r) => !r.failed && !r.pending && run.network === 'blocked').length;
      const line = `    ${g.host}  ${g.path}  x${g.list.length}  (from the ${[...g.from].join(', ')})\n      made by: ${g.part ?? 'NOT KNOWN. Nothing in the launch page\'s code accounts for it.'}\n      what happened: ${what}`;
      console.log(line);
      lines.push({ run: run.run, ...g, what });
    }
    if (run.tarpitHosts) {
      const counts = new Map();
      for (const h of run.tarpitHosts) counts.set(h, (counts.get(h) ?? 0) + 1);
      console.log(`    Connections the tarpit took (Chrome's own included): ${[...counts.entries()].map(([h, n]) => `${h} x${n}`).join(', ') || 'none'}`);
    }
  }
  const total = internet.reduce((n, run) => n + run.requests.length, 0);
  check('requests', 'every request that tried the internet is one the launch page is known to make', unknown === 0,
    `${total} requests in ${internet.length} runs, ${unknown} not accounted for`);
  check('requests', 'with the internet blocked, none of them got an answer', answered === 0, `${answered} answered`);
  return lines;
}

// ------------------------------------------------------------------
// 15 and 16. The internet open, on http://localhost:8000
// ------------------------------------------------------------------
async function onlineRun(server) {
  heading(`Internet open, http://localhost:8000 served from ${ARGS.onlineHost}`);
  const browser = await launchChrome({ network: 'open', windowSize: LAPTOP, args: [...GPU, ...server.chromeArgs] });
  try {
    const page = await browser.newPage();
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const t = await openLaunch(page, server);
    note(`started after ${seconds(t.startMs)}, 3D view ready after ${seconds(t.globeMs)}, at ${await page.evaluate(() => location.href)}`);
    await page.waitFor(() => window.fcLaunch.online.get() === true, { timeout: 20000, message: 'the online check never said yes' }).catch(() => {});
    await page.waitFor(() => window.fcLaunch.parts.globe.status().onlineLayerOn === true, { timeout: 30000, message: 'Esri\'s layer never went on in the 3D view' }).catch(() => {});
    // 3D from high up.
    const since3d = Date.now();
    await page.evaluate((f) => window.fcLaunch.parts.globe.lookAt({ lat: f.lat, lon: f.lon, heightM: 90000 }), FIELD);
    const g = await globeSettled(page, 60000);
    const cam = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.camera());
    const tex3 = textureWords(await textureShot(page, '15-3d-high-up-online', '3d', cam.range / cam.f));
    const esri3d = page.requests().filter((r) => r.startedAt >= since3d - 60000 && /ibasemaps-api\.arcgis\.com\/.*\/tile\//.test(r.url));
    const esri3dOk = esri3d.filter((r) => r.status === 200).length;
    const saved3d = tileSummary(page.requests());
    check('online', '3D view: Esri\'s photos load outside the saved box (tile requests answer 200)',
      g.status.onlineKey === 'yes' && g.status.onlineLayerOn && g.status.onlineLoaded > 0 && esri3dOk > 0,
      `online ${await page.evaluate(() => window.fcLaunch.online.get())}, Esri key ${g.status.onlineKey}, layer on ${g.status.onlineLayerOn}. The view's count ${g.status.onlineLoaded} loaded, ${g.status.onlineFailed} failed, ${g.status.onlineSkipped ?? 0} skipped inside the box. Esri tile requests: ${esri3d.length}, ${esri3dOk} answered 200 (settled ${g.settled} after ${seconds(g.ms)})`);
    check('online', '3D view from 90 km up: imagery inside and outside the saved box',
      tex3.inside?.n > 0 && tex3.inside.textured >= tex3.inside.n * 0.6 && tex3.outside?.n > 0 && tex3.outside.textured >= tex3.outside.n * 0.6,
      tex3.words);
    check('online', '3D view: the saved tiles are still used inside the box', g.status.savedLoaded > 0 && g.status.savedFailed === 0 && saved3d.total > 0 && saved3d.failed === 0,
      `saved ${g.status.savedLoaded} loaded, ${g.status.savedFailed} failed, ${saved3d.total} requests to ${TILES_PATH} (${saved3d.ok} ok)`);
    // The 2D map at zoom 10.
    await page.evaluate(() => window.fcLaunch.parts.globe.resetView());
    const since2d = Date.now();
    await page.click(SEL.satellite);
    await page.waitFor(() => window.fcLaunch.parts.map2d?.status().view === 'map', { timeout: 15000, message: 'the 2D map did not show' });
    await page.waitFor(() => window.fcLaunch.parts.map2d.status().onlineLayerOn === true, { timeout: 20000, message: 'Esri\'s layer never went on in the 2D map' }).catch(() => {});
    await page.evaluate((f) => window.fcLaunch.parts.map2d.setView(f.lat, f.lon, 10), FIELD);
    const m = await mapSettled(page, since2d, 45000);
    const mpp2 = (156543.03392 * Math.cos(rad(FIELD.lat))) / 2 ** 10;
    const tex2 = textureWords(await textureShot(page, '15-2d-zoom-10-online', '2d', mpp2));
    const esri2d = page.requests().filter((r) => r.startedAt >= since2d && /ibasemaps-api\.arcgis\.com\/.*\/tile\//.test(r.url));
    const esri2dOk = esri2d.filter((r) => r.status === 200).length;
    const saved2d = tileSummary(page.requests().filter((r) => r.startedAt >= since2d));
    check('online', '2D map: Esri\'s photos load outside the saved box (tile requests answer 200)',
      m.status.onlineLayerOn && m.status.onlineLoaded > 0 && esri2dOk > 0,
      `layer on ${m.status.onlineLayerOn}, place names on ${m.status.labelsOn}. The map's count ${m.status.onlineLoaded} loaded, ${m.status.onlineFailed} failed, ${m.status.onlineSkipped} not asked for because a saved photo covers them. Esri tile requests: ${esri2d.length}, ${esri2dOk} answered 200 (settled ${m.settled})`);
    check('online', '2D map at zoom 10: imagery inside and outside the saved box',
      tex2.inside?.n > 0 && tex2.inside.textured >= tex2.inside.n * 0.6 && tex2.outside?.n > 0 && tex2.outside.textured >= tex2.outside.n * 0.6,
      `${tex2.words}. Map note: "${m.status.note}"`);
    check('online', '2D map: the saved tiles are still used inside the box', m.status.savedLoaded > 0 && m.status.savedFailed === 0 && saved2d.total > 0 && saved2d.failed === 0 && m.status.onlineSkipped > 0,
      `saved ${m.status.savedLoaded} loaded, ${m.status.savedFailed} failed, ${saved2d.total} requests to ${TILES_PATH} in this part (${saved2d.ok} ok, ${saved2d.canceled} canceled by the map as it zoomed out, ${saved2d.pending} pending), Esri not asked for ${m.status.onlineSkipped} tiles inside the box`);
    check('online', 'no page exceptions with the internet open', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    await noteLogs(page);
  } finally {
    await browser.close();
  }
}

async function normalRun(server) {
  heading(`The normal page, internet open, http://localhost:8000 served from ${ARGS.onlineHost}`);
  const browser = await launchChrome({ network: 'open', windowSize: LAPTOP, args: [...GPU, ...server.chromeArgs] });
  try {
    const page = await browser.newPage();
    const began = Date.now();
    await page.goto(server.url('/flight-console/index.html?track'), { waitUntil: 'none' });
    await page.waitFor(() => window.fcStarted === true && document.body.dataset.fcScreen === 'console', { timeout: 60000, message: 'the normal page did not start' });
    const startMs = Date.now() - began;
    await page.waitFor(() => ['ready', 'failed'].includes(document.getElementById('fc-map')?.fcMapTest?.counts().three), { timeout: 60000, message: 'the 3D view neither loaded nor failed' }).catch(() => {});
    await sleep(4000);
    const state = await page.evaluate(() => ({
      panel: Boolean(document.getElementById('fc-launch-panel')),
      hub: 'fcLaunch' in window,
      flag: window.FC_LAUNCH === true,
      three: document.getElementById('fc-map')?.fcMapTest?.counts().three ?? null,
      leaflet: typeof window.L?.map === 'function',
      cesium: typeof window.Cesium?.Viewer === 'function',
    }));
    const all = page.requests();
    const local = (r) => !isExternalUrl(r.url);
    const pathOf = (r) => { try { return new URL(r.url).pathname; } catch { return ''; } };
    const launchy = all.filter((r) => local(r) && /^\/(offline-maps|launch-mode|flight-console\/vendor)\//.test(pathOf(r)));
    const cesium = all.filter((r) => /^https:\/\/cesium\.com\/downloads\/cesiumjs\/releases\/[\d.]+\/Build\/Cesium\/Cesium\.js/.test(r.url));
    const leaflet = all.filter((r) => /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/[\d.]+\/leaflet\.js/.test(r.url));
    await shot(page, '16-normal-page');
    check('normal', 'no launch panel and no window.fcLaunch', !state.panel && !state.hub && !state.flag,
      `launch panel ${state.panel}, window.fcLaunch ${state.hub}, FC_LAUNCH ${state.flag}, started after ${seconds(startMs)}`);
    check('normal', 'nothing asked of /offline-maps/, /launch-mode/ or /flight-console/vendor/', launchy.length === 0,
      `${launchy.length} such requests${launchy.length ? `: ${launchy.slice(0, 5).map((r) => pathOf(r)).join(', ')}` : ''} out of ${all.length}`);
    check('normal', 'Cesium and Leaflet come from their CDNs',
      cesium.some((r) => r.status === 200) && leaflet.some((r) => r.status === 200) && state.cesium && state.leaflet && state.three === 'ready',
      `Cesium.js: ${cesium.map((r) => `${r.url.replace(/^https:\/\//, '').slice(0, 70)} ${r.status ?? r.errorText}`).join(', ') || 'not asked for'}. leaflet.js: ${leaflet.map((r) => `${r.url.replace(/^https:\/\//, '').slice(0, 70)} ${r.status ?? r.errorText}`).join(', ') || 'not asked for'}. 3D view ${state.three}`);
    check('normal', 'no page exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// The other suites
// ------------------------------------------------------------------
// Runs a program, saves everything it printed to a file in --shots, and
// resolves with { code, out, ms }. It is ended after timeoutMs.
function runProgram(name, command, args, timeoutMs) {
  return new Promise((resolve) => {
    const began = Date.now();
    const file = path.join(ARGS.shots, `${name}.txt`);
    let out = '';
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      out += `\n(acceptance.mjs ended it after ${timeoutMs / 1000} s)\n`;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => { out += `\n${err.message}\n`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(file, out);
      resolve({ code, out, ms: Date.now() - began, file });
    });
  });
}

async function unitTests() {
  heading('The Node unit tests');
  const r = await runProgram('unit-tests', process.execPath, ['--test', '--test-reporter=tap', 'flight-console/test/*.test.mjs'], 10 * 60000);
  const num = (word) => Number(new RegExp(`^# ${word} (\\d+)`, 'm').exec(r.out)?.[1] ?? NaN);
  const fails = [...r.out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  check('unit', 'node --test "flight-console/test/*.test.mjs"', r.code === 0 && num('fail') === 0 && num('pass') > 0,
    `${num('tests')} tests, ${num('pass')} pass, ${num('fail')} fail, exit code ${r.code}, ${seconds(r.ms)}${fails.length ? `. Failed: ${fails.slice(0, 6).join(' | ')}` : ''}. Output: ${r.file}`);
}

async function browserSuites() {
  heading('The other browser checks');
  const suites = [
    ['launch-panel-browser.mjs', ['--shots', path.join(ARGS.shots, 'launch-panel')]],
    ['launch-log-browser.mjs', ['--out', path.join(ARGS.shots, 'launch-log')]],
    ['launch-restore-browser.mjs', ['--out', path.join(ARGS.shots, 'launch-restore')]],
    ['map-names-browser.mjs', ['--out', path.join(ARGS.shots, 'map-names')]],
  ];
  for (const [i, [file, extra]] of suites.entries()) {
    const port = ARGS.port + 1 + i;
    // The suite finds this server on its port and uses it, so the names of
    // the logs its pages write can be read from its request lines.
    // launch-panel-browser.mjs does not delete its logs, and a suite that is
    // stopped early cannot.
    const own = await startServer({ port, verbose: true });
    let r;
    try {
      r = await runProgram(file.replace(/\.mjs$/, ''), process.execPath, [path.join('flight-console', 'test', file), '--port', String(port), ...extra], 20 * 60000);
    } finally {
      noteServerLogs(own);
      await own.stop();
    }
    const lines = r.out.split(/\r?\n/);
    const summary = [...lines].reverse().find((l) => /\d+ (of \d+ checks )?passed/.test(l)) ?? '(no summary line)';
    const fails = lines.filter((l) => /^FAIL\b/.test(l.trim())).map((l) => short(l.trim(), 150));
    check('browser', `node flight-console/test/${file} --port ${port}`, r.code === 0 && fails.length === 0,
      `${summary.trim()}, exit code ${r.code}, ${seconds(r.ms)}${fails.length ? `\n        ${fails.join('\n        ')}` : ''}\n        Output: ${r.file}`);
  }
}

async function loggerChecks() {
  heading('The backup logger, and the receiver board');
  const r = await runProgram('backup-logger-test', 'python', [path.join('launch-mode', 'test', 'backup_logger_test.py'), '--quick'], 10 * 60000);
  const summary = /(\d+) of (\d+) checks passed/.exec(r.out);
  check('logger', 'python launch-mode/test/backup_logger_test.py --quick', r.code === 0 && summary && summary[1] === summary[2],
    `${summary ? summary[0] : 'no summary line'}, exit code ${r.code}, ${seconds(r.ms)}. Output: ${r.file}`);

  const ports = await runProgram('serial-ports', 'python', ['-m', 'serial.tools.list_ports', '-v'], 60000);
  const listing = await runProgram('serial-ports-json', 'python', ['-c',
    'import json; from serial.tools import list_ports; print(json.dumps([{"device": p.device, "vid": p.vid, "pid": p.pid, "description": p.description} for p in list_ports.comports()]))'], 60000);
  let found = [];
  try { found = JSON.parse(listing.out.trim().split(/\r?\n/).at(-1) || '[]'); } catch { found = []; }
  console.log(`  python -m serial.tools.list_ports -v said:\n${ports.out.trim().split(/\r?\n/).map((l) => `    ${l}`).join('\n') || '    (nothing)'}`);
  const usb = found.filter((p) => p.vid !== null);
  let port = ARGS.com;
  if (!port && usb.length === 1) port = usb[0].device;
  if (!port) {
    const why = usb.length > 1
      ? `${usb.length} USB serial ports (${usb.map((p) => p.device).join(', ')}), so the receiver's is not clear. Run again with --com and its name.`
      : `No receiver board found (${found.length ? `only ${found.map((p) => p.device).join(', ')}, none of them USB` : 'no serial port at all'}). The 10 second run on its COM port was skipped.`;
    check('logger', 'the receiver board', usb.length <= 1, why);
    return;
  }
  const out = path.join(ARGS.shots, `backup-logger-${port.replace(/[^\w.-]/g, '_')}.log`);
  try { fs.rmSync(out, { force: true }); } catch { /* not there */ }
  const run = await runProgram('backup-logger-run', 'python', [path.join('launch-mode', 'backup_logger.py'), '--port', port, '--seconds', '10', '--out', out], 60000);
  const saved = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const data = saved.filter((l) => PREFIX.test(l));
  check('logger', `the backup logger on ${port} for 10 s`, run.code === 0 && data.length > 0,
    `exit code ${run.code}, ${saved.length} lines saved in ${out}, ${data.length} of them from the receiver. The first lines:\n${saved.slice(0, 12).map((l) => `          ${short(l, 200)}`).join('\n')}`);
}

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------
async function main() {
  const beganAt = Date.now();
  await fsp.mkdir(ARGS.shots, { recursive: true });
  console.log('Launch mode acceptance test');
  console.log(`Website folder: ${ROOT}`);
  console.log(`Checks: ${NAMES.filter(want).join(', ') || 'none'}`);
  console.log(`Pictures and output: ${ARGS.shots}`);
  console.log(`The capture: ${CAPTURE_LINES.length} lines, ${CAPTURE_PKTS} of them PKT lines. The field: ${FIELD.lat}, ${FIELD.lon}. Saved tiles: ${MANIFEST.tiles} (zoom ${MANIFEST.minZoom} to ${MANIFEST.maxZoom}, complete ${MANIFEST.complete})`);

  let onlineServer = null;
  try {
    const blockedNeeded = ['start', 'maps', 'capture', 'log', 'panel', 'restore', 'replay', 'tarpit', 'requests'].some(want);
    const portNeeded = PORT_STEPS.some(want);
    if (blockedNeeded || portNeeded || want('ground')) {
      testServer = await startServer({ port: ARGS.port, verbose: true });
      console.log(`Test server: ${testServer.origin}${testServer.owned ? `, process ${testServer.pid}` : ' (already running, left running)'}`);
    }
    // testServer is read when each part runs: the stand-in port run puts a
    // new server in its place.
    const parts = [];
    if (blockedNeeded) parts.push(['the blocked run', () => blockedRun(testServer)]);
    if (want('restore')) parts.push(['the close and reopen runs', () => restoreRuns(testServer)]);
    if (portNeeded) parts.push(['the stand-in port run', () => portRun()]);
    if (want('ground')) parts.push(['the first heard in the air run', () => groundRun(testServer)]);
    if (want('tarpit') || want('requests')) parts.push(['the tarpit run', () => tarpitRun(testServer)]);
    for (const [name, part] of parts) {
      try {
        await part();
      } catch (err) {
        check('run', `${name} ran to its end`, false, err?.stack ?? String(err));
      }
    }
    if (want('requests')) requestReport();
    noteServerLogs(testServer);
    await testServer?.stop();
    testServer = null;

    if (want('online') || want('normal')) {
      try {
        onlineServer = await startServer({ port: 8000, host: ARGS.onlineHost, verbose: true });
        console.log(`\nOnline test server: ${onlineServer.direct}, which its Chrome calls ${onlineServer.origin}`);
        if (want('online')) await onlineRun(onlineServer).catch((err) => check('run', 'the online run ran to its end', false, err?.stack ?? String(err)));
        if (want('normal')) await normalRun(onlineServer).catch((err) => check('run', 'the normal page run ran to its end', false, err?.stack ?? String(err)));
      } finally {
        noteServerLogs(onlineServer);
        await onlineServer?.stop();
        onlineServer = null;
      }
    }

    if (want('unit')) await unitTests();
    if (want('browser')) await browserSuites();
    if (want('logger')) await loggerChecks();
  } finally {
    noteServerLogs(testServer);
    noteServerLogs(onlineServer);
    await testServer?.stop();
    await onlineServer?.stop();
    await cleanUp();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n== Summary ==');
  for (const name of NAMES.filter(want)) {
    const mine = results.filter((r) => r.group === name);
    if (!mine.length) continue;
    const bad = mine.filter((r) => !r.ok).length;
    console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${GROUPS[name]}: ${mine.length - bad} of ${mine.length} checks passed`);
  }
  const runProblems = results.filter((r) => r.group === 'run');
  if (runProblems.length) console.log(`  FAIL  ${runProblems.length} part(s) of the test stopped early`);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.${failed.length ? ` Failed: ${failed.map((r) => `[${r.group}] ${r.name}`).join(', ')}` : ''}`);
  const tookS = Math.round((Date.now() - beganAt) / 1000);
  console.log(`It took ${Math.floor(tookS / 60)} min ${tookS % 60} s.`);
  console.log(`Pictures: ${ARGS.shots}`);
  return failed.length ? 1 : 0;
}

async function cleanUp() {
  // The flight-logs/ files this run's pages wrote, and nothing else.
  let deleted = 0;
  for (const name of madeLogs) {
    if (logsBefore.has(name)) continue;
    const file = path.join(LOGS, name);
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      deleted += 1;
    } catch (err) {
      console.log(`Could not delete flight-logs/${name}: ${err.message}`);
    }
  }
  const others = (fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []).filter((n) => !logsBefore.has(n) && !madeLogs.has(n));
  console.log(`\nflight-logs/: deleted the ${deleted} files this run's pages wrote.${others.length ? ` New files from something else, left alone: ${others.join(', ')}` : ''}`);
  for (const p of profiles) {
    try { await fsp.rm(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (err) { console.log(`Could not remove the profile ${p}: ${err.message}`); }
  }
}

process.exitCode = await main().catch(async (err) => {
  console.error(`acceptance.mjs could not run: ${err?.stack ?? err}`);
  await cleanUp().catch(() => {});
  return 2;
});
