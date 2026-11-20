// launch-panel-browser.mjs: the launch panel checked in a real Chrome, the
// way it will be used at the field. It starts launch mode's local server
// on a test port, opens the launch page with the internet blocked, feeds
// the radio board receiver's capture (test/radio-board-rx-capture.log)
// through the live console's own serial handlers (with the test capture
// player, js/launch/capture.js, at 5 times real speed and its positions
// left where they were recorded, or by hand with --manual), and checks
// what the panel (js/launch/launch-panel.js) shows against the capture's
// own lines
// and an independent great-circle calculation. Then it checks COPY
// COORDINATES, the ground station setting, a reload, a landed flight's
// HUD, the map links with the internet blocked and open, the page with no
// field settings, a saved flight, and the normal page (index.html).
//
// The parts, in the order they run (--only picks some of them):
//   capture   the capture, the readout, COPY, the ground station, a reload
//   landed    a landed flight, with the internet blocked and then open
//   settings  the page with no field settings
//   crash     Chrome is killed one second after the last packet of a
//             real-style session (a stand-in for the serial port), and
//             opened again on the same profile. Before RECOVER is pressed
//             the panel shows the last packet's fix and time, read out of
//             the unfinished recording, and says to press RECOVER. Then
//             CONNECT before RECOVER, RECOVER itself, a killed test
//             capture, whose recording is never read, and an older
//             recording put back with RECOVER, which never takes a newer
//             saved fix's place.
//   packets   packets that must not take the readout (one 50 km away, one
//             at 0, 0), a weak fix under the good one, weak fixes after a
//             reload under the saved good fix, weak fixes only, a real
//             move, and a coordinate that rounds to zero
//   gaps      through the stand-in port, with real waits: good packets, 6 s
//             and 100 s with only the receiver's status line, then one
//             packet 3 km and 50 km away. It shows under the good fix as
//             not confirmed and is never the current or the saved fix, and
//             the first true packet after it is current again. Then the
//             same as the first packet heard after a reload, with weak
//             fixes after it, and a real move after a reload. The two
//             waits run side by side, so this part takes about 2 minutes.
//   rockets   two boards: after a reload another rocket is heard first,
//             and the first rocket's newer fixes still show and are saved.
//             When the other rocket gets a fix, the first one's stays in
//             storage and on the ALSO SAVED lines.
//   test      a test capture played over a real saved fix, and a packet
//             from another rocket under a saved fix
//   tabs      a second launch tab follows the first tab's fixes
//   layout    the page at the window sizes launch day can have
//   replay    a saved flight on the launch page, and the normal page
//
// It is not one of the Node tests (its name doesn't end in .test.mjs),
// because it needs Chrome. Run it from the repo:
//   node flight-console/test/launch-panel-browser.mjs
//   node flight-console/test/launch-panel-browser.mjs --port 8107 --shots C:/some/folder
//   node flight-console/test/launch-panel-browser.mjs --only crash,packets
// --shots saves screenshots there (look at them: a check that only reads
// numbers can pass on a broken picture). --fast plays the capture at 20
// times real speed. --manual feeds it through the handlers by hand.
//
// Its pages write log files in flight-logs/ (the flight log's server
// copy). It deletes the ones its own pages wrote when it ends, by the names
// in each page's log status and in its own server's request lines, and
// leaves every other file there alone.
//
// Exit code 0 when every check passed, 1 when one failed, 2 when the test
// itself couldn't run. Uses launch-mode/test/cdp.mjs, nothing to install.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchChrome, sleep } from '../../launch-mode/test/cdp.mjs';
import { destinationPoint } from '../js/geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ------------------------------------------------------------------
// Options
// ------------------------------------------------------------------
const PARTS = ['capture', 'landed', 'settings', 'crash', 'packets', 'gaps', 'rockets', 'test', 'tabs', 'layout', 'replay'];
const args = { port: 8107, shots: null, fast: false, manual: false, only: PARTS };
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--port') args.port = Number(process.argv[++i]);
  else if (name === '--shots') args.shots = process.argv[++i];
  else if (name === '--fast') args.fast = true;
  else if (name === '--manual') args.manual = true;
  else if (name === '--only') args.only = String(process.argv[++i] ?? '').split(',').filter(Boolean);
  else {
    console.error(`I don't know the option ${name}`);
    process.exit(2);
  }
}
if (!Number.isInteger(args.port) || args.port === 8000) {
  console.error('--port needs a test port. 8000 is the real one.');
  process.exit(2);
}
const unknown = args.only.filter((p) => !PARTS.includes(p));
if (unknown.length || !args.only.length) {
  console.error(`--only takes parts from this list, with commas between them: ${PARTS.join(', ')}`);
  process.exit(2);
}
if (args.shots) fs.mkdirSync(args.shots, { recursive: true });

// ------------------------------------------------------------------
// What the checks compare against
// ------------------------------------------------------------------
const FIELD = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch-mode', 'field.json'), 'utf8')).center;
const CAPTURE = fs.readFileSync(path.join(HERE, 'radio-board-rx-capture.log'), 'utf8').split(/\r?\n/).filter(Boolean);
const LAST_PKT = [...CAPTURE].reverse().find((l) => l.startsWith('PKT '));
const pktField = (line, name) => Number(new RegExp(`\\b${name}=(-?[\\d.]+)`).exec(line)[1]);
const WANT = { lat: pktField(LAST_PKT, 'lat'), lon: pktField(LAST_PKT, 'lon'), altM: pktField(LAST_PKT, 'alt_m') };
const WANT_COPY = `${WANT.lat.toFixed(6)}, ${WANT.lon.toFixed(6)}`;

// An independent great circle on the same sphere as js/geo.js: the
// spherical law of cosines for the distance, and the bearing from the
// tangent form. geo.js uses the haversine and a different atan2 form.
const R = 6371000;
const rad = (d) => d * Math.PI / 180;
function greatCircle(a, b) {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dl = rad(b.lon - a.lon);
  const c = Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl));
  const m = R * Math.acos(c);
  const deg = ((Math.atan2(Math.sin(dl), Math.cos(p1) * Math.tan(p2) - Math.sin(p1) * Math.cos(dl)) * 180 / Math.PI) + 360) % 360;
  return { m, deg };
}
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function expectWords({ m, deg }) {
  const dist = Math.round(m) < 10000
    ? `${Math.round(m).toLocaleString('en-US')} M`
    : `${(m / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM`;
  const shown = Math.round(deg) % 360;
  return `${dist} AT ${String(shown).padStart(3, '0')}° ${POINTS[Math.round(deg / 22.5) % 16]}`;
}

// ------------------------------------------------------------------
// Results
// ------------------------------------------------------------------
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function shot(page, name) {
  if (!args.shots) return;
  const file = path.join(args.shots, `${name}.png`);
  await page.screenshot(file);
  console.log(`      picture: ${file}`);
}

// ------------------------------------------------------------------
// The files this run's pages write in flight-logs/
// ------------------------------------------------------------------
// Every connection on the launch page makes the flight log write a server
// copy there. Their names come from two places: each page's own log status
// (noteLogs(), asked before a page reloads, or its Chrome closes or is
// killed), and this run's own server, which prints a line for every append
// it saved. (When the acceptance test runs this file, the server on the
// port is the acceptance test's, and it reads those lines itself.) Only
// those files are deleted at the end, and never one that was there before
// the run.
const LOGS = path.join(ROOT, 'flight-logs');
const logsBefore = new Set(fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []);
const madeLogs = new Set();
const openPages = new Set();

async function noteLogs(page) {
  try {
    const logs = await page.evaluate(() => window.fcLaunch?.parts?.log?.status?.().logs ?? []);
    for (const l of logs) if (l.server) madeLogs.add(l.server);
  } catch {
    // The page is gone (its Chrome was killed). The server's lines have its files.
  }
}

function noteServerLogs() {
  for (const m of String(server?.output?.() ?? '').matchAll(/\/launch-mode\/log\/append\?(?:[^\s#]*&)?name=([^&\s#]+)/g)) {
    madeLogs.add(decodeURIComponent(m[1]));
  }
}

function deleteMadeLogs() {
  noteServerLogs();
  let deleted = 0;
  for (const name of madeLogs) {
    // A plain file name of the flight log's own kind, and nothing that was there before.
    if (logsBefore.has(name) || name !== path.basename(name) || !/^(flight|test-capture)-[\w-]+\.log$/.test(name)) continue;
    const file = path.join(LOGS, name);
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      deleted += 1;
    } catch (err) {
      console.log(`could not delete flight-logs/${name}: ${err.message}`);
    }
  }
  console.log(`flight-logs/: deleted the ${deleted} files this run's pages wrote.`);
}

// ------------------------------------------------------------------
// Page helpers
// ------------------------------------------------------------------
const PAGE = '/flight-console/launch.html?track';
const status = (page) => page.evaluate(() => window.fcLaunch.parts.panel.status());
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

async function openLaunch(page, server, url = PAGE) {
  await page.goto(server.url(url));
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel), { timeout: 40000, message: 'the launch panel did not start' });
}

// The live console's own serial handlers, as a real port would call them.
const open = (page) => page.evaluate(() => window.fcLaunch.ctx.live.handlers.onOpen());
async function feed(page, lines, perSecond) {
  const batch = Math.max(1, Math.round(perSecond / 4));
  for (let i = 0; i < lines.length; i += batch) {
    await page.evaluate((part) => {
      for (const line of part) window.fcLaunch.ctx.live.handlers.onLine(line, Date.now());
    }, lines.slice(i, i + batch));
    await sleep(1000 * batch / perSecond);
  }
}

// A flight that lifts off from `pad`, reaches about 1,000 m and lands
// `distM` away on `bearing`, as receiver PKT lines.
function syntheticFlight(pad, bearing, distM) {
  const Q = destinationPoint(pad.lat, pad.lon, bearing, distM);
  const lines = ['# DEKEL_RX listening good=0 bad=0 last_good_s_ago=0.9 rx_up_s=1.0'];
  let seq = 0;
  const pkt = (t, lat, lon, agl, spd) => {
    const s = Math.floor(t);
    const utc = `12:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
    lines.push(`PKT node=1 seq=${seq++} up_s=${t.toFixed(1)} fix=yes sats=12 hdop=0.90 lat=${lat.toFixed(7)} lon=${lon.toFixed(7)} alt_m=${(100 + agl).toFixed(2)} spd_mps=${spd.toFixed(2)} crs_deg=62.00 utc=${utc} airborne=yes rssi_dbm=-80.0 snr_db=10.00 missed=0`);
  };
  // 30 s on the pad, 20 s climbing at 50 m/s (faster than the detector's
  // LIFTOFF_VSPEED_MPS), 40 s coming down and drifting to Q, 60 s landed.
  for (let t = 0; t < 30; t++) pkt(100 + t, pad.lat, pad.lon, 0, 0);
  for (let k = 1; k <= 20; k++) pkt(129 + k, pad.lat, pad.lon, 50 * k, 0.2);
  for (let k = 1; k <= 40; k++) {
    const f = k / 40;
    pkt(149 + k, pad.lat + (Q.lat - pad.lat) * f, pad.lon + (Q.lon - pad.lon) * f, 1000 - 25 * k, 12.5);
  }
  for (let k = 1; k <= 60; k++) pkt(189 + k, Q.lat, Q.lon, 0, 0);
  return { lines, Q };
}

const hudRecovery = (page) => page.evaluate(() => {
  const block = document.querySelector('.fc-hud-recovery');
  const values = [...(block?.querySelectorAll('.fc-hud-lead-value') ?? [])].map((d) => d.textContent);
  const link = [...(block?.querySelectorAll('a') ?? [])].find((a) => a.textContent.includes('OPEN IN MAPS'));
  return {
    state: document.getElementById('fc-console')?.dataset.state ?? null,
    lastFix: values[0] ?? null,
    distance: values[1] ?? null,
    bearing: values[2] ?? null,
    linkHidden: link ? link.hidden : null,
    linkShown: link ? !link.hidden && link.getClientRects().length > 0 : null,
    href: link?.getAttribute('href') ?? null,
  };
});

// ------------------------------------------------------------------
// The run
// ------------------------------------------------------------------
const CHROME_ARGS = ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
const LAPTOP = { width: 1366, height: 768 };
let server = null;
const browsers = [];

async function partCapture() {
  console.log('\n== The capture, internet blocked, 1366 by 768 ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  openPages.add(page);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await openLaunch(page, server);

  // a. The panel is up, with the field center as the ground station.
  let st = await status(page);
  check('the panel shows on the launch page', st.panelShown === true);
  check('the ground station starts at the field center from field.json',
    st.groundStation?.lat === FIELD.lat && st.groundStation?.lon === FIELD.lon && st.groundStation?.typed === false,
    JSON.stringify(st.groundStation));
  check('no fix before any packet', st.fix === null && st.copyText === '');
  check('the panel says FIELD CENTER', (await text(page, '#fcl-gs-state')) === 'FIELD CENTER');
  check('the boxes hold the field center', await page.evaluate((f) => document.getElementById('fcl-gs-lat').value === f.lat.toFixed(6) &&
    document.getElementById('fcl-gs-lon').value === f.lon.toFixed(6), FIELD));
  check('the flight store starts from the field center', await page.evaluate((f) => {
    const gs = window.fcLaunch.ctx.liveStore('flight').getGroundStation();
    return gs?.lat === f.lat && gs?.lon === f.lon && gs?.source === 'launch-mode';
  }, FIELD));
  // Where it sits: beside the 3D view, not over it, and the whole recovery
  // readout in view without scrolling.
  const layout = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const panel = r(document.getElementById('fc-launch-panel'));
    const globe = r(document.getElementById('fc-screens'));
    const copy = r(document.getElementById('fcl-copy'));
    return { panelLeft: panel.left, panelRight: panel.right, panelTop: panel.top, globeRight: globe.right, copyBottom: copy.bottom, h: innerHeight, w: innerWidth };
  });
  check('the panel sits beside the 3D view, not over it', layout.globeRight <= layout.panelLeft + 0.5 && layout.panelRight <= layout.w + 0.5, JSON.stringify(layout));
  check('the recovery readout fits without scrolling', layout.copyBottom <= layout.h, `COPY COORDINATES ends at ${Math.round(layout.copyBottom)} of ${layout.h}`);
  await sleep(2500);
  await shot(page, 'a-1366-start');

  // b. The capture through the live path, a few lines a second: the test
  // capture player (js/launch/capture.js) when it is there, with its
  // positions left where they were recorded, or the handlers by hand.
  const t0 = Date.now();
  const player = args.manual ? false : await page.evaluate(() => typeof window.fcLaunch.parts.capture?.play === 'function' &&
    typeof window.fcLaunch.parts.capture.status?.().state === 'string');
  if (player) {
    const played = await page.evaluate((speed) => {
      const done = window.fcLaunch.parts.capture.play({ speed, shift: 'none' });
      window.fcPlayed = done;
      return new Promise((r) => setTimeout(r, 400)).then(() => window.fcLaunch.parts.capture.status().playing);
    }, args.fast ? 20 : 5);
    check('the test capture plays', played === true);
    await page.waitFor(() => window.fcLaunch.parts.capture.status().playing === false, { timeout: 200000, interval: 500, message: 'the capture never ended' });
    const result = await page.evaluate(() => window.fcPlayed);
    check('the whole capture was sent', result?.ok === true && result.sent === result.total && result.total > 200, JSON.stringify(result).slice(0, 200));
    console.log(`      the capture player sent ${result?.sent} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    await open(page);
    await feed(page, CAPTURE, args.fast ? 60 : 8);
    console.log(`      fed ${CAPTURE.length} lines by hand in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  await sleep(400);
  st = await status(page);
  if (player) {
    check('a fix from the test capture is marked as a test on the panel', st.fix?.test === true &&
      (await text(page, '#fcl-fix-detail')).endsWith('This fix came from the test capture.'), await text(page, '#fcl-fix-detail'));
  }
  check('the latitude shown is the last PKT line\'s, to 6 decimals', (await text(page, '#fcl-lat')) === WANT.lat.toFixed(6), await text(page, '#fcl-lat'));
  check('the longitude shown is the last PKT line\'s, to 6 decimals', (await text(page, '#fcl-lon')) === WANT.lon.toFixed(6), await text(page, '#fcl-lon'));
  check('the fix is the last PKT line\'s exactly', st.fix?.lat === WANT.lat && st.fix?.lon === WANT.lon, `${st.fix?.lat}, ${st.fix?.lon}`);
  check('the altitude is the last PKT line\'s alt_m', st.fix?.altM === WANT.altM && (await text(page, '#fcl-alt')) === `${WANT.altM.toFixed(1)} M ABOVE SEA LEVEL`, await text(page, '#fcl-alt'));
  check('the fix is current while packets arrive', st.fix?.old === false && st.fix?.why === 'current', st.fix?.why);
  check('the rocket ID is 1', st.fix?.rocketId === '1');
  const far = greatCircle(FIELD, WANT);
  check('the range from the field center matches a great circle within 1 m', Math.abs(st.rangeM - far.m) < 1, `${st.rangeM.toFixed(2)} m against ${far.m.toFixed(2)} m`);
  check('the bearing matches within 0.1 degree', Math.abs(st.bearingDeg - far.deg) < 0.1, `${st.bearingDeg.toFixed(3)} against ${far.deg.toFixed(3)}`);
  check('the range reads as expected', (await text(page, '#fcl-range')) === expectWords(far), `${await text(page, '#fcl-range')} against ${expectWords(far)}`);
  check('the copy text is decimal degrees, 6 places', st.copyText === WANT_COPY, st.copyText);
  check('OPEN IN MAPS stays hidden with the internet blocked', st.mapsLinkShown === false &&
    await page.evaluate(() => document.getElementById('fcl-maps').hidden === true && window.fcLaunch.online.get() === false));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-last-fix')));
  check('the newest fix is in localStorage', saved?.lat === WANT.lat && saved?.lon === WANT.lon && saved?.altMsl === WANT.altM && saved?.rocketId === '1' &&
    saved?.groundStation?.lat === FIELD.lat && Number.isFinite(saved?.fixMs), JSON.stringify(saved));
  await shot(page, 'b-1366-fed');

  // The flight log and the test capture make the panel taller than the
  // window. Scrolled to the bottom, the last good fix stays in view. Also
  // in a 1366 by 625 window, about what a 768 high laptop screen leaves
  // under the browser's own bars.
  for (const size of [LAPTOP, { width: 1366, height: 625 }]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const pinned = await page.evaluate(() => {
      const panel = document.getElementById('fc-launch-panel');
      panel.scrollTop = panel.scrollHeight;
      const p = panel.getBoundingClientRect();
      const lat = document.getElementById('fcl-lat').getBoundingClientRect();
      const copy = document.getElementById('fcl-copy').getBoundingClientRect();
      return { scrolls: panel.scrollHeight > panel.clientHeight + 1, scrollTop: Math.round(panel.scrollTop), latTop: Math.round(lat.top), panelTop: Math.round(p.top), copyBottom: Math.round(copy.bottom), panelBottom: Math.round(p.bottom) };
    });
    check(`${size.width} by ${size.height}: the last good fix stays in view with the panel scrolled to the bottom`,
      pinned.latTop >= pinned.panelTop && pinned.copyBottom <= pinned.panelBottom, JSON.stringify(pinned));
    await sleep(300);
    await shot(page, `b-${size.width}x${size.height}-scrolled`);
    await page.evaluate(() => { document.getElementById('fc-launch-panel').scrollTop = 0; });
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: LAPTOP.width, height: LAPTOP.height, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // The age counts up once the lines stop, and nothing goes blank.
  const before = (await status(page)).fix.packetAgeS;
  await sleep(7000);
  st = await status(page);
  check('the packet age counts up after the lines stop', st.fix.packetAgeS - before > 6.5 && st.fix.packetAgeS - before < 8, `${before.toFixed(1)} s, then ${st.fix.packetAgeS.toFixed(1)} s`);
  check('the fix is marked old once packets stop', st.fix.old === true && st.fix.why === 'no-packets', st.fix.why);
  // "1:05" as seconds, to compare the words with status() (within a second,
  // since the two are read a moment apart).
  const clockS = (m) => (m ? Number(m[1]) * 60 + Number(m[2]) : NaN);
  const headline = await text(page, '#fcl-fix-state');
  check('the headline says OLD FIX, with the fix\'s age', Math.abs(clockS(/^OLD FIX, FROM (\d+):(\d\d) AGO$/.exec(headline)) - st.fix.ageS) <= 1, headline);
  check('the coordinates stay on screen', (await text(page, '#fcl-lat')) === WANT.lat.toFixed(6) && (await text(page, '#fcl-lon')) === WANT.lon.toFixed(6));
  const packetWords = await text(page, '#fcl-packet');
  check('LAST PACKET says how long ago and the time', Math.abs(clockS(/^(\d+):(\d\d) AGO, AT \d\d:\d\d:\d\d$/.exec(packetWords)) - st.fix.packetAgeS) <= 1, packetWords);
  // The cable is pulled.
  await page.evaluate(() => window.fcLaunch.ctx.live.handlers.onClose({ lost: true }));
  await sleep(1500);
  st = await status(page);
  check('the fix stays after the cable is pulled', st.fix?.lat === WANT.lat && (await text(page, '#fcl-lat')) === WANT.lat.toFixed(6));
  await shot(page, 'c-1366-stopped');
  // On the launch page the recording saves itself when the cable is pulled
  // (js/views/local-console.js), so no name box covers the panel. If one
  // is open anyway, SAVE closes it so the checks below can go on.
  const dialog = await page.evaluate(() => {
    const box = [...document.querySelectorAll('dialog')].find((d) => d.open);
    if (!box) return false;
    [...box.querySelectorAll('button')].find((b) => b.textContent.includes('SAVE'))?.click();
    return true;
  });
  check('no name box covers the panel after the cable is pulled', !dialog);
  if (dialog) {
    await page.waitFor(() => ![...document.querySelectorAll('dialog')].some((d) => d.open), { timeout: 5000, message: 'the name box stayed open' });
  }

  // c. COPY COORDINATES.
  await browser.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await page.click('#fcl-copy');
  await sleep(300);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check('COPY COORDINATES puts exactly the coordinates on the clipboard', copied === WANT_COPY, JSON.stringify(copied));
  check('it says it copied', (await text(page, '#fcl-copied')) === `COPIED ${WANT_COPY}`, await text(page, '#fcl-copied'));
  // The clipboard API refuses: the old way still copies.
  await page.evaluate(() => navigator.clipboard.writeText('something else'));
  await page.evaluate(() => {
    window.fcRealWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Blocked for the test', 'NotAllowedError'));
  });
  await page.click('#fcl-copy');
  await sleep(300);
  check('with the clipboard API refused, the older copy still works', (await page.evaluate(() => navigator.clipboard.readText())) === WANT_COPY &&
    (await text(page, '#fcl-copied')).startsWith('COPIED'));
  // Both refuse: the coordinates show in a box, selected, to copy by hand.
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.click('#fcl-copy');
  await sleep(300);
  const fallback = await page.evaluate(() => {
    const f = document.getElementById('fcl-copy-field');
    return { hidden: f.hidden, value: f.value, focused: document.activeElement === f, selected: f.selectionStart === 0 && f.selectionEnd === f.value.length };
  });
  check('with copying blocked, the coordinates show selected in a box', !fallback.hidden && fallback.value === WANT_COPY && fallback.focused && fallback.selected, JSON.stringify(fallback));
  check('and the panel says copying was blocked', (await text(page, '#fcl-copied')) === 'COPYING WAS BLOCKED. COPY THEM FROM HERE.');
  await shot(page, 'c-1366-copy-blocked');
  await page.evaluate(() => document.getElementById('fcl-gs-lat').focus());
  check('the box goes once focus leaves it', await page.evaluate(() => document.getElementById('fcl-copy-field').hidden &&
    document.getElementById('fcl-copied').textContent === ''));

  // d. A ground station typed in a few hundred meters from the fix.
  const near = destinationPoint(WANT.lat, WANT.lon, 250, 340);
  const typed = { lat: Number(near.lat.toFixed(6)), lon: Number(near.lon.toFixed(6)) };
  const stationBefore = await page.evaluate(() => {
    const el = document.querySelector('#fc-map .fc-gs');
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  await page.type('#fcl-gs-lat', typed.lat.toFixed(6), { clear: true });
  await page.type('#fcl-gs-lon', typed.lon.toFixed(6), { clear: true });
  check('typing says to press SET', (await text(page, '#fcl-gs-msg')) === 'Press SET to use this position.');
  await page.click('#fcl-gs-set');
  await sleep(200);
  st = await status(page);
  check('SET applies the typed position', st.groundStation?.lat === typed.lat && st.groundStation?.lon === typed.lon && st.groundStation?.typed === true, JSON.stringify(st.groundStation));
  check('the panel says TYPED IN', (await text(page, '#fcl-gs-state')) === 'TYPED IN');
  check('the coordinates are still in view after using the boxes', await page.evaluate(() => {
    const panel = document.getElementById('fc-launch-panel').getBoundingClientRect();
    const lat = document.getElementById('fcl-lat').getBoundingClientRect();
    return lat.top >= panel.top && lat.bottom <= panel.bottom;
  }));
  const stores = await page.evaluate(() => ({
    flight: window.fcLaunch.ctx.liveStore('flight').getGroundStation(),
    stage: window.fcLaunch.ctx.getStage()?.store.getGroundStation() ?? null,
  }));
  check('the flight store\'s ground station moved at once', stores.flight?.lat === typed.lat && stores.flight?.lon === typed.lon && stores.flight?.source === 'launch-mode', JSON.stringify(stores.flight));
  check('the views\' store switch has it too', stores.stage?.lat === typed.lat && stores.stage?.lon === typed.lon);
  const close = greatCircle(typed, WANT);
  check('the range from the typed position matches a great circle within 1 m', Math.abs(st.rangeM - close.m) < 1, `${st.rangeM.toFixed(2)} m against ${close.m.toFixed(2)} m`);
  check('the bearing matches within 0.1 degree', Math.abs(st.bearingDeg - close.deg) < 0.1, `${st.bearingDeg.toFixed(3)} against ${close.deg.toFixed(3)}`);
  check('the range reads in meters', (await text(page, '#fcl-range')) === expectWords(close), `${await text(page, '#fcl-range')} against ${expectWords(close)}`);
  const savedStation = await page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-last-fix'))?.groundStation);
  check('the saved fix records the ground station used', savedStation?.lat === typed.lat && savedStation?.typed === true, JSON.stringify(savedStation));
  // Both maps: the 3D view looks down between the fix and the dish.
  const mid = { lat: (typed.lat + WANT.lat) / 2, lon: (typed.lon + WANT.lon) / 2 };
  const looked = await page.evaluate((m) => window.fcLaunch.parts.globe?.lookAt({ lat: m.lat, lon: m.lon, heightM: 900 }) ?? 'no globe', mid);
  await sleep(2500);
  check('the 3D view could be pointed between them', looked === true, String(looked));
  await shot(page, 'd-1366-typed-3d');
  await page.evaluate(() => [...document.querySelectorAll('#fc-map-controls button')].find((b) => b.textContent.includes('SATELLITE'))?.click());
  await sleep(3000);
  const stationAfter = await page.evaluate(() => {
    const gs = document.querySelector('#fc-map .fc-gs');
    const board = document.querySelector('#fc-map .leaflet-marker-pane .fc-board, #fc-map .leaflet-marker-pane [class*="board"]');
    return { gs: gs ? gs.getBoundingClientRect().toJSON() : null, board: board ? board.getBoundingClientRect().toJSON() : null };
  });
  check('the 2D map has the dish marker', Boolean(stationAfter.gs), JSON.stringify(stationAfter.gs));
  if (stationBefore && stationAfter.gs) console.log(`      2D dish moved from x ${Math.round(stationBefore.x)} to x ${Math.round(stationAfter.gs.x)}`);
  await shot(page, 'd-1366-typed-2d');
  // Back to the 3D view for the rest.
  await page.evaluate(() => [...document.querySelectorAll('#fc-map-controls button')].find((b) => b.textContent.trim() === '3D')?.click());

  // Bad input is refused and changes nothing.
  for (const [lat, lon, words, box] of [
    ['abc', '-73.1', /can't be read/, 'lat'],
    ['44.8', '-190', /Longitude goes from -180 to 180/, 'lon'],
    ['44 49.517', '-73 10.304', /degrees and minutes/, 'lat'],
    ['', '', /Type a latitude/, 'lat'],
    // A space after the point: the message is about the latitude box it is in.
    ['44. 825278', '-73.171727', /^There is a space after the point. Type it as one number, like 44.825278.$/, 'lat'],
    ['44.825278, -190', '', /^This box was read as a pair, and the pair's longitude, -190, is out of range./, 'lat'],
  ]) {
    await page.type('#fcl-gs-lat', lat, { clear: true });
    await page.type('#fcl-gs-lon', lon, { clear: true });
    await page.click('#fcl-gs-set');
    await sleep(100);
    const after = await status(page);
    const msg = await text(page, '#fcl-gs-msg');
    const invalid = await page.evaluate((b) => document.getElementById(`fcl-gs-${b}`).getAttribute('aria-invalid'), box);
    check(`"${lat}" and "${lon}" are refused and change nothing`, words.test(msg) && invalid === 'true' &&
      after.groundStation.lat === typed.lat && after.groundStation.lon === typed.lon, msg);
  }
  // A pair pasted into one box fills both.
  await page.evaluate(() => {
    const box = document.getElementById('fcl-gs-lon');
    const data = new DataTransfer();
    data.setData('text/plain', '44.830100, -73.165200');
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  check('a pasted pair fills both boxes', await page.evaluate(() => document.getElementById('fcl-gs-lat').value === '44.830100' &&
    document.getElementById('fcl-gs-lon').value === '-73.165200'));
  // Put the typed position back in the boxes, unset, for the reload.
  await page.type('#fcl-gs-lat', typed.lat.toFixed(6), { clear: true });
  await page.type('#fcl-gs-lon', typed.lon.toFixed(6), { clear: true });
  await page.click('#fcl-gs-set');
  await sleep(200);
  const fixBefore = (await status(page)).fix;

  // e. A reload: the saved fix, marked as saved, with its real age.
  await noteLogs(page);
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel), { timeout: 40000, message: 'the panel did not come back after the reload' });
  await sleep(800);
  // The status and the page's clock in one go, so the fix's age is compared
  // with the real one at the same moment, however slow the laptop is.
  const reloaded = await page.evaluate(() => ({ st: window.fcLaunch.parts.panel.status(), now: Date.now() }));
  st = reloaded.st;
  check('the typed ground station is remembered after a reload', st.groundStation?.lat === typed.lat && st.groundStation?.lon === typed.lon && st.groundStation?.typed === true);
  check('the flight store starts from it after the reload', await page.evaluate((p) => {
    const gs = window.fcLaunch.ctx.liveStore('flight').getGroundStation();
    return gs?.lat === p.lat && gs?.lon === p.lon;
  }, typed));
  check('the saved fix shows after the reload', st.fix?.lat === WANT.lat && st.fix?.lon === WANT.lon && st.fix?.altM === WANT.altM, JSON.stringify(st.fix));
  check('it is marked as saved before the reload', st.fix?.restored === true && st.fix?.old === true && st.fix?.why === 'reload' &&
    /^SAVED FIX, FROM \d:\d\d AGO$/.test(await text(page, '#fcl-fix-state')), await text(page, '#fcl-fix-state'));
  const realAge = (reloaded.now - fixBefore.wallMs) / 1000;
  check('with its real age', st.fix?.wallMs === fixBefore.wallMs && Math.abs(st.fix.ageS - realAge) < 0.5 && st.fix.ageS > 9, `${st.fix?.ageS?.toFixed(1)} s, real ${realAge.toFixed(1)} s`);
  check('the coordinates and the range are still there', (await text(page, '#fcl-lat')) === WANT.lat.toFixed(6) && Math.abs(st.rangeM - close.m) < 1);
  check('CLEAR SAVED FIX is offered for a saved fix', await page.evaluate(() => !document.querySelector('.fcl-clear').hidden));
  await sleep(1500);
  await shot(page, 'e-1366-reloaded');

  // A new packet replaces it.
  const nextLine = LAST_PKT.replace(/seq=\d+/, 'seq=932').replace(/up_s=[\d.]+/, 'up_s=933.0')
    .replace(/lat=-?[\d.]+/, 'lat=35.1233001').replace(/lon=-?[\d.]+/, 'lon=-117.1234002').replace(/alt_m=[\d.]+/, 'alt_m=74.10');
  await open(page);
  await feed(page, [nextLine], 4);
  await sleep(300);
  st = await status(page);
  check('a new packet replaces the saved fix', st.fix?.lat === 35.1233001 && st.fix?.lon === -117.1234002 && st.fix?.source === 'live' && st.fix?.restored === false, JSON.stringify(st.fix));
  check('and goes into storage', await page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-last-fix'))?.lat === 35.1233001));
  check('CLEAR SAVED FIX is not offered for a live fix', await page.evaluate(() => document.querySelector('.fcl-clear').hidden));
  // A packet without a fix: the last good fix stays, marked old.
  const noFixLine = nextLine.replace(/seq=\d+/, 'seq=933').replace(/up_s=[\d.]+/, 'up_s=934.0').replace('fix=yes', 'fix=no').replace(/sats=\d+/, 'sats=3');
  await feed(page, [noFixLine], 4);
  await sleep(300);
  st = await status(page);
  check('a packet without a fix keeps the last good fix, marked old', st.fix?.lat === 35.1233001 && st.fix?.old === true && st.fix?.why === 'no-fix' &&
    /^OLD FIX, FROM 0:0\d AGO$/.test(await text(page, '#fcl-fix-state')) && (await text(page, '#fcl-fix-detail')) === 'Packets still arrive, but without a good GPS fix.',
  `${st.fix?.why}, ${await text(page, '#fcl-fix-state')}`);

  // USE FIELD CENTER puts the field center back, and that is remembered too.
  await page.click('#fcl-gs-reset');
  await sleep(200);
  st = await status(page);
  check('USE FIELD CENTER returns to the field center', st.groundStation?.lat === FIELD.lat && st.groundStation?.lon === FIELD.lon && st.groundStation?.typed === false &&
    (await text(page, '#fcl-gs-state')) === 'FIELD CENTER');
  check('and the flight store follows', await page.evaluate((f) => {
    const gs = window.fcLaunch.ctx.liveStore('flight').getGroundStation();
    return gs?.lat === f.lat && gs?.lon === f.lon;
  }, FIELD));
  await noteLogs(page);
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel), { timeout: 40000 });
  st = await status(page);
  check('the field center is still in use after a reload', st.groundStation?.typed === false && st.groundStation?.lat === FIELD.lat);
  // The connection was open at the reload, so its recording is offered a
  // moment later: a line appears above the map and the panel's words
  // change, and both move the buttons. The presses below wait for that.
  await page.waitFor(() => !document.getElementById('fc-recover').hidden && window.fcLaunch.parts.panel.status().fix?.unfinished === true,
    { timeout: 15000, message: 'the recording left by the reload was never offered' }).catch((err) => console.log(`      ${err.message}`));
  await sleep(500);
  check('a reload with the port open: the saved fix says to press RECOVER', (await text(page, '#fcl-fix-detail')) === RECOVER_WORDS, await text(page, '#fcl-fix-detail'));

  // CLEAR SAVED FIX asks first, and a quick second press can't answer.
  await page.click('#fcl-clear');
  check('CLEAR SAVED FIX asks first', await page.evaluate(() => !document.querySelector('.fcl-clear-ask').hidden));
  await page.click('#fcl-clear-yes');
  check('a press right away is ignored', (await status(page)).fix !== null);
  await sleep(700);
  await page.click('#fcl-clear-yes');
  await sleep(200);
  st = await status(page);
  check('YES, CLEAR IT clears the saved fix', st.fix === null && await page.evaluate(() => localStorage.getItem('fc-launch-last-fix') === null));

  // A fix heard while the test capture plays is marked, and goes when the
  // store is cleared. (js/launch/capture.js stands in here with a status()
  // that says playing: true, the contract the panel reads.)
  await page.evaluate(() => {
    window.fcRealCapture = window.fcLaunch.parts.capture;
    window.fcLaunch.parts.capture = { status: () => ({ playing: true }) };
  });
  await open(page);
  await feed(page, [nextLine], 4);
  await page.evaluate(() => { window.fcLaunch.parts.capture = window.fcRealCapture; });
  await sleep(300);
  st = await status(page);
  check('a fix from the test capture is marked as a test', st.fix?.test === true &&
    /This fix came from the test capture./.test(await text(page, '#fcl-fix-detail')) &&
    await page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-last-fix'))?.test === true), await text(page, '#fcl-fix-detail'));
  await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').clearAll());
  await sleep(200);
  st = await status(page);
  check('clearing the store drops a test fix, and its saved copy', st.fix === null && await page.evaluate(() => localStorage.getItem('fc-launch-last-fix') === null));
  // A real fix stays when the store is cleared, as one saved earlier.
  const realLine = nextLine.replace(/seq=\d+/, 'seq=940').replace(/up_s=[\d.]+/, 'up_s=941.0');
  await feed(page, [realLine], 4);
  await sleep(200);
  await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').clearAll());
  await sleep(300);
  st = await status(page);
  check('a real fix stays when the store is cleared, marked as saved earlier', st.fix?.lat === 35.1233001 && st.fix?.test === false &&
    st.fix?.source === 'earlier' && st.fix?.old === true && /^SAVED FIX/.test(await text(page, '#fcl-fix-state')), JSON.stringify(st.fix));

  // 1920 by 1080 with the capture again.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await open(page);
  await feed(page, CAPTURE.slice(-40), 40);
  await sleep(2500);
  await shot(page, 'f-1920-fed');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  await shot(page, 'f-1024-narrow');
  const exceptions = page.exceptions();
  check('no exceptions on the launch page', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

async function partLanded(network) {
  console.log(`\n== A landed flight, internet ${network} ==`);
  const browser = await launchChrome({ network, windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  openPages.add(page);
  await openLaunch(page, server);
  const flight = syntheticFlight(FIELD, 62, 840);
  await open(page);
  await feed(page, flight.lines, 60);
  await page.waitFor(() => document.getElementById('fc-console').dataset.state === 'recovery', { timeout: 15000, message: 'the flight did not land' });
  if (network === 'open') {
    await page.waitFor(() => window.fcLaunch.online.get() === true, { timeout: 15000, message: 'the online check never said yes' });
  }
  await sleep(500);
  let hud = await hudRecovery(page);
  let st = await status(page);
  const landing = await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getFocused().derived.landing);
  const fromField = greatCircle(FIELD, landing);
  const hudDist = (m) => (Math.round(m) < 1000 ? `${Math.round(m).toLocaleString('en-US')} M` : `${(m / 1000).toFixed(2)} KM`);
  check('the HUD measures from the ground station and calls it that', hud.distance === `${hudDist(fromField.m)} FROM GROUND STATION`, hud.distance);
  check('the panel\'s height above ground is the landed rocket\'s, about 0 M', Number.isFinite(st.fix?.aglM) && Math.abs(st.fix.aglM) < 2 &&
    (await text(page, '#fcl-agl')) === '0 M', `${st.fix?.aglM} m, ${await text(page, '#fcl-agl')}`);
  check('the panel\'s altitude is the GPS altitude above sea level', st.fix?.altM === 100 && (await text(page, '#fcl-alt')) === '100.0 M ABOVE SEA LEVEL', await text(page, '#fcl-alt'));
  if (network === 'open') {
    check('OPEN IN MAPS shows in the HUD with the internet up', hud.linkShown === true && /^https:\/\/www\.google\.com\/maps\//.test(hud.href), JSON.stringify(hud));
    check('the panel offers OPEN IN MAPS with the internet up', st.mapsLinkShown === true &&
      await page.evaluate((c) => document.getElementById('fcl-maps').getAttribute('href') === `https://www.google.com/maps/search/?api=1&query=${c.replace(' ', '')}`, st.copyText));
  } else {
    check('OPEN IN MAPS is hidden in the HUD with the internet blocked', hud.linkHidden === true, JSON.stringify(hud));
    check('the panel hides OPEN IN MAPS too', st.mapsLinkShown === false);
  }
  await shot(page, `g-1366-landed-${network}`);
  // A new ground station position reaches the HUD at once.
  const there = destinationPoint(landing.lat, landing.lon, 180, 300);
  await page.type('#fcl-gs-lat', there.lat.toFixed(6), { clear: true });
  await page.type('#fcl-gs-lon', there.lon.toFixed(6), { clear: true });
  await page.click('#fcl-gs-set');
  await sleep(300);
  hud = await hudRecovery(page);
  const fromThere = greatCircle({ lat: Number(there.lat.toFixed(6)), lon: Number(there.lon.toFixed(6)) }, landing);
  check('the HUD\'s distance follows the typed position at once', hud.distance === `${hudDist(fromThere.m)} FROM GROUND STATION`, `${hud.distance}, expected ${hudDist(fromThere.m)}`);
  check('and its bearing', hud.bearing === `${String(Math.round(fromThere.deg) % 360).padStart(3, '0')}° (${POINTS[Math.round(fromThere.deg / 22.5) % 16]})`, hud.bearing);
  st = await status(page);
  const lastFix = await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getFocused().lastGoodFix);
  const panelExpect = greatCircle({ lat: Number(there.lat.toFixed(6)), lon: Number(there.lon.toFixed(6)) }, lastFix);
  check('the panel\'s range follows it too', Math.abs(st.rangeM - panelExpect.m) < 1 && Math.abs(st.bearingDeg - panelExpect.deg) < 0.1, `${st.rangeM.toFixed(1)} m at ${st.bearingDeg.toFixed(2)}`);
  await sleep(1500);
  await shot(page, `g-1366-landed-${network}-typed`);
  if (network === 'blocked') {
    // The online answer changes while the page is up: the links follow.
    const toggled = await page.evaluate(async () => {
      const online = window.fcLaunch.online;
      // Pretend the internet answered, the way check() would.
      const realFetch = window.fetch;
      window.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
      await online.check();
      window.fetch = realFetch;
      await new Promise((r) => setTimeout(r, 300));
      const link = [...document.querySelectorAll('.fc-hud-recovery a')].find((a) => a.textContent.includes('OPEN IN MAPS'));
      return { online: online.get(), hud: !link.hidden, panel: window.fcLaunch.parts.panel.status().mapsLinkShown };
    });
    check('when the internet answers later, both links show without a reload', toggled.online && toggled.hud && toggled.panel, JSON.stringify(toggled));
  }
  const exceptions = page.exceptions();
  check(`no exceptions (internet ${network})`, exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// field.json didn't load: no field center. The panel says so, and a typed
// position still works.
async function partNoSettings() {
  console.log('\n== No field settings (field.json blocked) ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  openPages.add(page);
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['*launch-mode/field.json*'] });
  await openLaunch(page, server);
  let st = await status(page);
  check('with no field settings there is no ground station, and the panel says so', st.groundStation === null &&
    (await text(page, '#fcl-gs-state')) === 'NO POSITION SET' && await page.evaluate(() => document.getElementById('fcl-gs-reset').disabled), JSON.stringify(st.groundStation));
  check('the flight store has no ground station either', await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getGroundStation() === null));
  await page.type('#fcl-gs-lat', '44.830100', { clear: true });
  await page.type('#fcl-gs-lon', '-73.165200', { clear: true });
  await page.click('#fcl-gs-set');
  await sleep(200);
  st = await status(page);
  check('a typed position still works without them', st.groundStation?.lat === 44.8301 && st.groundStation?.typed === true &&
    await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getGroundStation()?.lon === -73.1652));
  await shot(page, 'j-1366-no-settings');
  const exceptions = page.exceptions();
  check('no exceptions without field settings', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// ------------------------------------------------------------------
// Helpers for the parts below
// ------------------------------------------------------------------

// The stand-in for navigator.serial and the save box, the same one
// launch-restore-browser.mjs and launch-log-browser.mjs use. The page's
// serial-link.js reads its stream as it reads a real port.
const FAKE = `(() => {
  const enc = new TextEncoder();
  const fake = window.__fake = { requestCalls: 0, pickerCalls: 0, granted: false, opens: 0 };
  const port = {
    readable: null,
    controller: null,
    async open() { fake.opens += 1; port.readable = new ReadableStream({ start(c) { port.controller = c; } }); },
    async setSignals() {},
    async close() { port.readable = null; },
    getInfo() { return {}; },
    send(text) { port.controller.enqueue(enc.encode(text)); },
  };
  fake.port = port;
  Object.defineProperty(navigator, 'serial', { value: {
    async requestPort() {
      fake.requestCalls += 1;
      if (!navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      fake.granted = true;
      return port;
    },
    async getPorts() { return fake.granted ? [port] : []; },
    addEventListener() {},
    removeEventListener() {},
  }, configurable: true });
  window.showSaveFilePicker = async (opts) => {
    fake.pickerCalls += 1;
    const dir = await navigator.storage.getDirectory();
    return dir.getFileHandle('picked-' + Math.random().toString(36).slice(2, 8) + '-' + opts.suggestedName, { create: true });
  };
})();`;

// Runs before the page's own code: what localStorage held for the saved fix
// when the page opened (before the panel could write a better one back),
// every sentence the readout's detail line shows from then on, and every
// position the readout shows with when it first showed (ms since the page
// began to load), so the time a stale fix was on screen can be printed.
const WATCH = `(() => {
  const seen = window.__seen = { saved: null, details: [], shown: [] };
  try { seen.saved = localStorage.getItem('fc-launch-last-fix'); } catch (err) { seen.saved = 'error: ' + err.message; }
  setInterval(() => {
    const lat = document.getElementById('fcl-lat');
    const lon = document.getElementById('fcl-lon');
    if (lat && lon) {
      const text = lat.textContent + ', ' + lon.textContent;
      if (seen.shown[seen.shown.length - 1]?.text !== text) seen.shown.push({ text, at: Math.round(performance.now()) });
    }
    const el = document.getElementById('fcl-fix-detail');
    if (!el || el.hidden) return;
    if (seen.details[seen.details.length - 1] !== el.textContent) seen.details.push(el.textContent);
  }, 20);
})();`;

async function openWith(browser, scripts, url = PAGE) {
  const page = await browser.newPage();
  openPages.add(page);
  openPages.add(page);
  for (const source of scripts) await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await page.goto(server.url(url));
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.log && window.fcLaunch?.parts?.capture), { timeout: 40000, message: 'launch mode did not start' });
  return page;
}

// One receiver packet line.
function pktLine({ seq, t, lat, lon, alt = 61.5, sats = 12, hdop = 0.9, fix = 'yes', node = 1 }) {
  return `PKT node=${node} seq=${seq} up_s=${t.toFixed(1)} fix=${fix} sats=${sats} hdop=${hdop.toFixed(2)} lat=${lat.toFixed(7)} lon=${lon.toFixed(7)} alt_m=${alt.toFixed(2)} spd_mps=0.10 crs_deg=90.00 utc=12:00:00.000 airborne=no rssi_dbm=-80.0 snr_db=10.00 missed=0`;
}
const statusLine = (n) => `# DEKEL_RX listening good=${n} bad=0 last_good_s_ago=0.9 rx_up_s=${(n + 1).toFixed(1)}`;

// A real-style session near the field: the receiver's status line and one
// packet at a time, the rocket drifting about 2 m east with each packet.
// Returns the lines and where the last packet says the rocket is.
function fieldSession(count, { from = 0 } = {}) {
  const start = destinationPoint(FIELD.lat, FIELD.lon, 40, 600);
  const lines = [];
  let last = null;
  for (let i = from; i < from + count; i++) {
    last = { lat: Number(start.lat.toFixed(7)), lon: Number((start.lon + i * 2.5e-5).toFixed(7)) };
    lines.push(statusLine(i), pktLine({ seq: i, t: 100 + i, lat: last.lat, lon: last.lon }));
  }
  return { lines, last };
}

// Sends lines through the stand-in port two at a time (the status line and
// its packet), a pair every pairMs. Returns the page's clock when each
// packet went in.
async function sendLines(page, lines, pairMs) {
  const pktMs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const pair = lines.slice(i, i + 2);
    const at = await page.evaluate((part) => {
      const t = Date.now();
      for (const l of part) window.__fake.port.send(`${l}\r\n`);
      return t;
    }, pair);
    if (pair.some((l) => l.startsWith('PKT '))) pktMs.push(at);
    await sleep(pairMs);
  }
  return pktMs;
}

async function connectFake(page) {
  await page.click('#bc-connect');
  await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open' });
}

// "1:05 AGO" at the start of some words, as seconds.
const agoS = (words) => {
  const m = /(?:(\d+):)?(\d+):(\d\d) AGO/.exec(words ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};
// A time of day in the page's words, like the panel's "AT 14:02:11".
const clockOf = (page, ms) => page.evaluate((t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}, ms);
const six = (p) => `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
const savedFix = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'));
const RECOVER_WORDS = 'The page closed suddenly. Press RECOVER to put the flight back on the live view.';

const profiles = [];
function newProfile(name) {
  const dir = path.join(os.tmpdir(), `fc-launch-panel-${process.pid}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  profiles.push(dir);
  return dir;
}

// ------------------------------------------------------------------
// crash: Chrome killed one second after the last packet
// ------------------------------------------------------------------

// The kill is meant to come one second after the last packet. A laptop that
// stalls (another test running, or a moment of standby) can make it much
// later. Past this many ms the session is run again on a new profile.
const KILL_LATEST_MS = 2500;
const KILL_TRIES = 3;

// One session through the stand-in port, then the kill. Returns what the
// session's last packet was, when it went in, and the profile it ran on.
async function crashedSession(name, packets, pairMs) {
  for (let attempt = 1; ; attempt++) {
    const profile = newProfile(`${name}-${attempt}`);
    const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS, userDataDir: profile });
    browsers.push(browser);
    const page = await openWith(browser, [FAKE]);
    await connectFake(page);
    // Its log file's name, while the page can still be asked.
    await noteLogs(page);
    const session = fieldSession(packets);
    const pktMs = await sendLines(page, session.lines, pairMs);
    const lastPktMs = pktMs.at(-1);
    const live = await status(page);
    // One second after the last packet, on the page's own clock.
    const sinceMs = await page.evaluate((t) => Date.now() - t, lastPktMs);
    await sleep(Math.max(0, 1000 - sinceMs - 20));
    const killedAfterMs = await page.evaluate((t) => Date.now() - t, lastPktMs);
    await browser.kill();
    browsers.splice(browsers.indexOf(browser), 1);
    if (killedAfterMs <= KILL_LATEST_MS || attempt >= KILL_TRIES) {
      return { ...session, profile, lastPktMs, killedAfterMs, live, ranS: (lastPktMs - pktMs[0]) / 1000 };
    }
    console.log(`      the laptop stalled: Chrome was killed ${killedAfterMs} ms after the last packet, not about 1,000. Running the session again.`);
  }
}

// Runs before the page's own code, after WATCH has read what Chrome kept:
// takes the saved fix out of localStorage, so the page starts with no saved
// copy at all whatever Chrome happened to put on the disk.
const DROP_SAVED = `(() => {
  try { localStorage.removeItem('fc-launch-last-fix'); } catch { /* storage is off */ }
  window.__seen.dropped = localStorage.getItem('fc-launch-last-fix') === null;
})();`;

// Starts Chrome again on a profile a killed Chrome just used. Its last
// processes can hold the profile for a few seconds after the kill (Chrome
// then ends at once with exit code 21), so it tries again for a while.
async function relaunch(options, tries = 10) {
  for (let i = 1; ; i += 1) {
    try {
      return await launchChrome(options);
    } catch (err) {
      if (i >= tries || !/exit code 21\b/.test(err?.message ?? '')) throw err;
      console.log(`      Chrome still had the profile after the kill (try ${i}), so the test waits a second and tries again`);
      await sleep(1000);
    }
  }
}

async function reopen(profile, { dropSaved = false } = {}) {
  const browser = await relaunch({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS, userDataDir: profile });
  browsers.push(browser);
  const began = Date.now();
  const page = await openWith(browser, dropSaved ? [FAKE, WATCH, DROP_SAVED] : [FAKE, WATCH]);
  return { browser, page, began };
}

// What the reopened page shows before RECOVER is pressed.
async function checkReopened(name, page, began, session) {
  const want = session.last;
  await page.waitFor((w) => {
    const f = window.fcLaunch.parts.panel.status().fix;
    return Boolean(f) && f.lat === w.lat && f.lon === w.lon;
  }, { timeout: 15000, interval: 25, args: [want], message: `${name}: the panel never showed the last packet's fix` }).catch((err) => console.log(`      ${err.message}`));
  const shownAfterMs = Date.now() - began;
  // RECOVER is offered a moment after the page starts (js/views/local-console.js).
  await page.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 15000, message: `${name}: RECOVER was never offered` }).catch((err) => console.log(`      ${err.message}`));
  await sleep(600);
  const seen = await page.evaluate(() => ({
    now: Date.now(),
    st: window.fcLaunch.parts.panel.status(),
    lat: document.getElementById('fcl-lat').textContent,
    lon: document.getElementById('fcl-lon').textContent,
    state: document.getElementById('fcl-fix-state').textContent,
    detail: document.getElementById('fcl-fix-detail').textContent,
    packet: document.getElementById('fcl-packet').textContent,
    recover: document.getElementById('fc-recover').hidden ? null : document.getElementById('fc-recover').textContent.replace(/\s+/g, ' ').trim(),
    atLoad: window.__seen.saved,
    dropped: window.__seen.dropped === true,
    details: window.__seen.details,
    shown: window.__seen.shown,
    restored: window.fcLaunch.parts.log.status().restored,
    saved: JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'),
  }));
  const fix = seen.st.fix;
  const realAge = (seen.now - session.lastPktMs) / 1000;
  const clock = await clockOf(page, session.lastPktMs);
  // What Chrome had kept of the saved fix: this is the stale copy the panel used to show.
  const atLoad = seen.atLoad ? JSON.parse(seen.atLoad) : null;
  const staleBy = atLoad ? (session.lastPktMs - atLoad.packetMs) / 1000 : null;
  console.log(`      ${name}: the session ran ${session.ranS.toFixed(1)} s and Chrome was killed ${session.killedAfterMs} ms after its last packet. On reopening, localStorage ${atLoad ? `held a fix ${staleBy.toFixed(1)} s older than the last packet (${six(atLoad)})` : 'had no saved fix at all'}${seen.dropped ? ', and the test took it out before the page\'s code ran' : ''}. The panel had the right fix ${shownAfterMs} ms after the page was asked for.`);
  check(`${name}: Chrome was killed about a second after the last packet`, session.killedAfterMs >= 900 && session.killedAfterMs <= KILL_LATEST_MS, `${session.killedAfterMs} ms`);
  // What the readout showed, and when, since the page began to load.
  console.log(`      ${name}: the readout showed ${seen.shown.map((s) => `${s.text} at ${s.at} ms`).join(', then ')}.`);
  const right = seen.shown.find((s) => s.text === `${want.lat.toFixed(6)}, ${want.lon.toFixed(6)}`);
  const firstFix = seen.shown.find((s) => /\d/.test(s.text));
  check(`${name}: the panel does not wait for the recording, and the right fix is up within 5 s of the panel`, Boolean(right) && seen.shown.length >= 1 && right.at - seen.shown[0].at < 5000,
    right ? `the panel was up at ${seen.shown[0].at} ms, the right fix at ${right.at} ms${firstFix && firstFix !== right ? `, after ${right.at - firstFix.at} ms of the older saved fix` : ''}` : 'the right fix never showed');
  check(`${name}: before RECOVER, the panel shows the last packet's fix`, fix?.lat === want.lat && fix?.lon === want.lon && seen.lat === want.lat.toFixed(6) && seen.lon === want.lon.toFixed(6) &&
    seen.st.copyText === six(want) && seen.restored === null,
  `shown ${seen.lat}, ${seen.lon}, the last packet said ${six(want)}, RECOVER not pressed (${seen.restored === null})`);
  check(`${name}: with the time its own line arrived`, Math.abs(fix?.wallMs - session.lastPktMs) < 250 && Math.abs(fix?.packetWallMs - session.lastPktMs) < 250 &&
    Math.abs(fix.ageS - realAge) < 1.5 && seen.packet.endsWith(`AT ${clock}`) && Math.abs(agoS(seen.packet) - realAge) <= 2,
  `fix time off by ${fix?.wallMs - session.lastPktMs} ms, LAST PACKET "${seen.packet}", the packet went in at ${clock}, real age ${realAge.toFixed(1)} s`);
  check(`${name}: it is a saved fix read out of the recording`, fix?.source === 'reload' && fix?.fromRecording === true && fix?.test === false && fix?.unfinished === true &&
    /^SAVED FIX, FROM \d+:\d\d AGO$/.test(seen.state) && Math.abs(agoS(seen.state) - realAge) <= 2, `"${seen.state}", source ${fix?.source}, from the recording ${fix?.fromRecording}`);
  check(`${name}: it says to press RECOVER, and never that no newer fix was heard`, seen.detail === RECOVER_WORDS && !seen.details.some((d) => /No newer fix/.test(d)),
    `the detail line showed: ${seen.details.map((d) => `"${d}"`).join(' then ')}`);
  check(`${name}: RECOVER is offered on the same screen`, /UNSAVED RECORDING FOUND/.test(seen.recover ?? '') && /RECOVER/.test(seen.recover ?? '') &&
    await page.evaluate(() => {
      const r = document.getElementById('fc-recover').getBoundingClientRect();
      return r.height > 0 && r.bottom <= innerHeight && r.top >= 0;
    }), (seen.recover ?? 'not offered').slice(0, 150));
  check(`${name}: the fix was written back to localStorage`, seen.saved?.lat === want.lat && seen.saved?.lon === want.lon && Math.abs(seen.saved.fixMs - session.lastPktMs) < 250 && seen.saved.test === false,
    `saved ${seen.saved ? six(seen.saved) : 'nothing'}, fixMs off by ${seen.saved ? seen.saved.fixMs - session.lastPktMs : '?'} ms`);
  return { seen, realAge, clock, atLoad, staleBy, dropped: seen.dropped };
}

async function partCrash() {
  console.log('\n== Chrome killed one second after the last packet ==');

  // A. A session long enough for Chrome to have put an old copy of the
  // saved fix on the disk. Then CONNECT before RECOVER. What Chrome kept is
  // Chrome's own timing, so it is printed, not checked: it is usually many
  // seconds old, and now and then Chrome writes it just before the kill.
  {
    const session = await crashedSession('crash-a', 56, 250);
    check('the live page showed the last packet before the kill', session.live.fix?.lat === session.last.lat && session.live.fix?.why === 'current', `${session.live.fix?.lat}, ${session.live.fix?.why}`);
    const { browser, page, began } = await reopen(session.profile);
    const a = await checkReopened('a long session', page, began, session);
    console.log(`      a long session: the copy Chrome kept was ${a.atLoad === null ? 'missing' : a.staleBy > 0.5 ? `${a.staleBy.toFixed(1)} s older than the last packet, the stale fix the panel used to show` : 'the last packet\'s this time, so this run did not see a stale copy'}.`);
    await shot(page, 'k-1366-crash-reopened');

    // CONNECT first: the port is open, nothing has come in yet.
    await connectFake(page);
    await sleep(900);
    let st = await status(page);
    check('CONNECT before RECOVER: the panel still shows the last packet\'s fix', st.fix?.lat === session.last.lat && st.fix?.lon === session.last.lon && st.fix?.source === 'reload' &&
      (await text(page, '#fcl-lat')) === session.last.lat.toFixed(6) && Math.abs(st.fix.wallMs - session.lastPktMs) < 250, JSON.stringify({ lat: st.fix?.lat, source: st.fix?.source }));
    check('and still says to press RECOVER', (await text(page, '#fcl-fix-detail')) === RECOVER_WORDS && await page.evaluate(() => !document.getElementById('fc-recover').hidden), await text(page, '#fcl-fix-detail'));
    // The rocket is heard again: the live fix takes over.
    const next = fieldSession(1, { from: 56 });
    await sendLines(page, next.lines, 300);
    st = await status(page);
    check('a packet after CONNECT is the current fix', st.fix?.lat === next.last.lat && st.fix?.source === 'live' && st.fix?.why === 'current' && (await text(page, '#fcl-fix-state')) === 'CURRENT FIX',
      `${st.fix?.lat}, ${st.fix?.source}, ${await text(page, '#fcl-fix-state')}`);
    // RECOVER now only saves the recording (the live view already has data).
    await page.click('#fc-recover-actions button');
    await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not open' });
    await page.click('dialog.fc-dialog button[type="submit"]');
    await page.waitFor(() => document.getElementById('fc-recover').hidden, { timeout: 10000, message: 'the recovered recording was still offered' });
    await sleep(400);
    st = await status(page);
    check('RECOVER after CONNECT leaves the live fix on the panel', st.fix?.lat === next.last.lat && st.fix?.source === 'live', `${st.fix?.lat}, ${st.fix?.source}`);
    const exceptions = page.exceptions();
    check('no exceptions after the crash and CONNECT', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
    await noteLogs(page);
    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);
  }

  // B. No saved copy at all. A session this short usually ends before
  // Chrome writes one. When it has written one anyway, the test takes it
  // out before the page's code runs, so this case is the same every run.
  // Then RECOVER.
  {
    const session = await crashedSession('crash-b', 8, 250);
    const { browser, page, began } = await reopen(session.profile, { dropSaved: true });
    const b = await checkReopened('a short session', page, began, session);
    check('a short session: the page started with no saved fix at all', b.dropped === true, b.atLoad ? `Chrome had kept one ${b.staleBy.toFixed(1)} s older, taken out before the page's code ran` : 'Chrome had kept none');
    await page.click('#fc-recover-actions button');
    await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not open' });
    await page.click('dialog.fc-dialog button[type="submit"]');
    await page.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 15000, message: 'the recording did not go back on the live view' });
    await sleep(500);
    // On a quick laptop all of this takes less than the 5 s a fix counts as
    // current for. The check is for after that, when a person would look.
    await page.waitFor((t) => Date.now() - t > 6500, { timeout: 15000, args: [session.lastPktMs], message: 'the page\'s clock did not move on' });
    const st = await status(page);
    check('RECOVER puts the same fix on the live view, with the same time', st.fix?.lat === session.last.lat && st.fix?.lon === session.last.lon && st.fix?.source === 'live' &&
      Math.abs(st.fix.wallMs - session.lastPktMs) < 250 && st.fix?.why === 'no-packets' && (await text(page, '#fcl-fix-detail')) === 'Packets from the rocket have stopped.',
    `${st.fix?.lat}, ${st.fix?.lon}, source ${st.fix?.source}, time off by ${st.fix?.wallMs - session.lastPktMs} ms, "${await text(page, '#fcl-fix-state')}" "${await text(page, '#fcl-fix-detail')}"`);
    const exceptions = page.exceptions();
    check('no exceptions after the crash and RECOVER', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
    await noteLogs(page);
    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);
  }

  // C. A test capture is playing when Chrome is killed. Its recording is
  // never read for a fix, and nothing says to press RECOVER for the rocket.
  {
    const profile = newProfile('crash-c');
    const first = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS, userDataDir: profile });
    browsers.push(first);
    const page = await openWith(first, []);
    await page.evaluate(() => { window.fcLaunch.parts.capture.play({ speed: 5, shift: 'field' }); });
    await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.test === true, { timeout: 30000, message: 'no test fix from the capture' });
    await noteLogs(page);
    // Long enough for Chrome to put the (test) saved fix on the disk.
    await sleep(8000);
    const lines = await page.evaluate(() => window.fcLaunch.parts.log.status().browser.lines);
    await first.kill();
    browsers.splice(browsers.indexOf(first), 1);
    const { browser, page: page2 } = await reopen(profile);
    await page2.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 15000, message: 'the test capture\'s recording was never offered' }).catch((err) => console.log(`      ${err.message}`));
    await sleep(2500);
    const seen = await page2.evaluate(() => ({
      st: window.fcLaunch.parts.panel.status(),
      detail: document.getElementById('fcl-fix-detail').textContent,
      details: window.__seen.details,
      recover: document.getElementById('fc-recover').textContent.replace(/\s+/g, ' ').trim(),
      saved: JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'),
    }));
    const fix = seen.st.fix;
    check('a killed test capture: its recording is never read for a fix', (fix === null || (fix.test === true && fix.fromRecording === false)) && (seen.saved === null || seen.saved.test === true),
      `${lines} lines of the capture were recorded. The panel shows ${fix ? `a fix marked as a test (${fix.test}), from the recording ${fix.fromRecording}` : 'no fix'}. Storage holds ${seen.saved ? `a record marked test ${seen.saved.test}` : 'nothing'}`);
    check('and nothing says to press RECOVER for the rocket', !seen.details.some((d) => /RECOVER/.test(d)) && (fix === null || fix.unfinished === false) && /The test capture started/.test(seen.recover),
      `detail lines: ${seen.details.map((d) => `"${d}"`).join(' then ') || 'none'}. The offer: "${seen.recover.slice(0, 110)}"`);
    await noteLogs(page2);
    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);
  }

  // D. A recording left over from earlier (a test the day before, never
  // recovered) is still offered after a newer fix was saved. RECOVER puts
  // the old recording on the live view, and the newer saved fix stays on
  // the panel and in storage.
  {
    const old = await crashedSession('crash-d', 6, 250);
    const { browser, page } = await reopen(old.profile);
    await page.waitFor((w) => window.fcLaunch.parts.panel.status().fix?.lat === w.lat && window.fcLaunch.parts.panel.status().fix?.lon === w.lon,
      { timeout: 15000, args: [old.last], message: 'the panel never showed the old recording\'s fix' }).catch((err) => console.log(`      ${err.message}`));
    // A new connection hears the rocket about 400 m further east, and is
    // closed the normal way, so its own recording is saved.
    await connectFake(page);
    const flight = fieldSession(5, { from: 200 });
    await sendLines(page, flight.lines, 300);
    await noteLogs(page);
    await page.click('#bc-connect');
    await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'DISCONNECT did not close the stand-in port' });
    await sleep(1500);
    const newer = await savedFix(page);
    check('an older recording: the newer fix is the saved one before the reload', newer?.lat === flight.last.lat && newer?.lon === flight.last.lon && newer?.test === false, newer ? six(newer) : 'nothing saved');
    await noteLogs(page);
    await page.reload();
    await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.log), { timeout: 40000, message: 'the panel did not come back' });
    await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.unfinished === true && !document.getElementById('fc-recover').hidden,
      { timeout: 15000, message: 'the old recording was not offered after the reload' }).catch((err) => console.log(`      ${err.message}`));
    await sleep(800);
    let st = await status(page);
    check('an older recording: after a reload the panel shows the newer saved fix, not the old recording\'s', st.fix?.lat === flight.last.lat && st.fix?.lon === flight.last.lon && st.fix?.source === 'reload' && st.fix?.fromRecording === false,
      `shown ${st.fix?.lat}, ${st.fix?.lon}. The old recording ends at ${six(old.last)}, the newer fix is ${six(flight.last)}`);
    await page.click('#fc-recover-actions button');
    await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not open' });
    await page.click('dialog.fc-dialog button[type="submit"]');
    await page.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 15000, message: 'the old recording did not go back on the live view' });
    await sleep(1200);
    st = await status(page);
    const after = await page.evaluate(() => {
      const rocket = window.fcLaunch.ctx.liveStore('flight').getFocused();
      const last = rocket?.crumbs?.[rocket.crumbs.length - 1] ?? null;
      return {
        saved: JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'),
        liveLat: last?.lat ?? null,
        liveLon: last?.lon ?? null,
        lat: document.getElementById('fcl-lat').textContent,
        lon: document.getElementById('fcl-lon').textContent,
        state: document.getElementById('fcl-fix-state').textContent,
        detail: document.getElementById('fcl-fix-detail').textContent,
      };
    });
    check('an older recording: RECOVER puts it on the live view', after.liveLat === old.last.lat && after.liveLon === old.last.lon, `the live view ends at ${after.liveLat}, ${after.liveLon}`);
    check('and the newer saved fix stays on the panel', st.fix?.lat === flight.last.lat && st.fix?.lon === flight.last.lon && st.fix?.source === 'reload' && after.lat === flight.last.lat.toFixed(6) &&
      after.lon === flight.last.lon.toFixed(6) && st.copyText === six(flight.last) && /^SAVED FIX, FROM \d+:\d\d AGO$/.test(after.state) && Math.abs(st.fix.wallMs - newer.fixMs) < 1,
    `shown ${after.lat}, ${after.lon} "${after.state}" "${after.detail}", source ${st.fix?.source}`);
    check('and in storage', after.saved?.lat === flight.last.lat && after.saved?.lon === flight.last.lon && after.saved?.fixMs === newer.fixMs, after.saved ? six(after.saved) : 'nothing saved');
    await shot(page, 'k-1366-older-recording-recovered');
    const exceptions = page.exceptions();
    check('no exceptions with the older recording', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
    await noteLogs(page);
    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);
  }
}

// ------------------------------------------------------------------
// packets: what must not take the readout, weak fixes, a real move
// ------------------------------------------------------------------

async function partPackets() {
  console.log('\n== Bad packets, weak fixes and a real move ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, []);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await browser.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const spot = destinationPoint(FIELD.lat, FIELD.lon, 40, 600);
  const good = { lat: Number(spot.lat.toFixed(7)), lon: Number(spot.lon.toFixed(7)) };
  let seq = 0;
  let t = 100;
  const send = async (fields) => {
    await feed(page, [pktLine({ seq: seq++, t: t++, ...fields })], 20);
    await sleep(150);
  };
  // Starts the store over, as the flight log does between a test and a flight.
  const startOver = async () => {
    await page.evaluate(() => {
      window.fcLaunch.parts.panel.clearSavedFix();
      window.fcLaunch.ctx.live.flightFeed.reset();
      window.fcLaunch.ctx.liveStore('flight').clearAll();
    });
    await sleep(200);
  };
  const words = () => page.evaluate(() => ({
    title: document.getElementById('fcl-rec-words').textContent,
    lat: document.getElementById('fcl-lat').textContent,
    lon: document.getElementById('fcl-lon').textContent,
    state: document.getElementById('fcl-fix-state').textContent,
    detail: document.getElementById('fcl-fix-detail').hidden ? '' : document.getElementById('fcl-fix-detail').textContent,
    weakShown: !document.getElementById('fcl-weak').hidden,
    weakState: document.getElementById('fcl-weak-state').textContent,
    weakCoords: document.getElementById('fcl-weak-coords').textContent,
    weakNote: document.getElementById('fcl-weak-note').textContent,
    quality: document.getElementById('fcl-quality').closest('.fcl-row').hidden ? null : document.getElementById('fcl-quality').textContent,
  }));

  await open(page);
  for (let i = 0; i < 6; i++) await send(good);
  let st = await status(page);
  let w = await words();
  check('six good packets: the current fix', st.fix?.lat === good.lat && w.state === 'CURRENT FIX' && w.title === 'LAST GOOD FIX' && !w.weakShown, `${w.lat}, ${w.lon}, ${w.state}`);

  // One packet 50 km away, with fix=yes and plenty of satellites.
  const far = destinationPoint(good.lat, good.lon, 80, 50000);
  await send({ lat: far.lat, lon: far.lon });
  st = await status(page);
  w = await words();
  let saved = await savedFix(page);
  check('one packet 50 km away does not take the readout', st.fix?.lat === good.lat && st.fix?.lon === good.lon && w.lat === good.lat.toFixed(6) && st.copyText === six(good),
    `shown ${w.lat}, ${w.lon} (the far packet said ${six(far)}), the store's own lastGoodFix is ${await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').getFocused().lastGoodFix.lat.toFixed(6))}`);
  check('it is not called current, and the line says why', st.fix?.old === true && st.fix?.why === 'jump' && /^OLD FIX, FROM 0:0\d AGO$/.test(w.state) &&
    w.detail === 'The newest position is too far from this one to be real, so it is left out.', `"${w.state}" "${w.detail}"`);
  check('and it is not saved', saved?.lat === good.lat && saved?.lon === good.lon && saved?.weak === null, saved ? six(saved) : 'nothing saved');

  // A packet at 0, 0.
  await send({ lat: 0, lon: 0, alt: 0 });
  st = await status(page);
  saved = await savedFix(page);
  check('a packet at 0, 0 does not take the readout or the saved fix', st.fix?.lat === good.lat && (await text(page, '#fcl-lat')) === good.lat.toFixed(6) && saved?.lat === good.lat && st.fix?.why === 'jump',
    `shown ${await text(page, '#fcl-lat')}, ${await text(page, '#fcl-lon')}, saved ${saved ? six(saved) : 'nothing'}`);
  await send(good);
  w = await words();
  check('the next good packet is current again', w.state === 'CURRENT FIX' && w.detail === '', `"${w.state}"`);

  // A weak fix (4 satellites, HDOP 5.2) about 35 m away.
  const near = destinationPoint(good.lat, good.lon, 120, 35);
  const weak = { lat: Number(near.lat.toFixed(7)), lon: Number(near.lon.toFixed(7)) };
  await send({ ...weak, sats: 4, hdop: 5.2 });
  await send({ ...weak, sats: 4, hdop: 5.2 });
  st = await status(page);
  w = await words();
  saved = await savedFix(page);
  check('a newer weak fix: the big readout stays on the good fix, no longer current', st.fix?.lat === good.lat && w.lat === good.lat.toFixed(6) && st.fix?.quality === 'good' &&
    st.fix?.why === 'no-fix' && /^OLD FIX, FROM 0:0\d AGO$/.test(w.state), `${w.lat}, ${w.lon}, "${w.state}" "${w.detail}"`);
  check('the weak fix shows under it with its satellites, HDOP and distance', w.weakShown && /^NEWER WEAK FIX, FROM 0:0\d AGO$/.test(w.weakState) && w.weakCoords === six(weak) &&
    w.weakNote === '4 SATS, HDOP 5.20, 35 M FROM THE GOOD FIX' && st.fix?.weak?.lat === weak.lat && Math.abs(st.fix.weak.fromGoodM - 35) < 0.6 && st.weakCopyText === six(weak),
  `"${w.weakState}" "${w.weakCoords}" "${w.weakNote}"`);
  check('the saved record keeps the weak fix too', saved?.v === 2 && saved?.lat === good.lat && saved?.weak?.lat === weak.lat && saved?.weak?.sats === 4 && saved?.weak?.hdop === 5.2 &&
    saved.weak.fixMs >= saved.fixMs, JSON.stringify(saved?.weak));
  await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
  await page.click('#fcl-weak-copy');
  await sleep(300);
  check('COPY WEAK FIX copies the weak fix', (await page.evaluate(() => navigator.clipboard.readText())) === six(weak) && (await text(page, '#fcl-weak-copied')) === `COPIED ${six(weak)}`,
    await text(page, '#fcl-weak-copied'));
  await page.click('#fcl-copy');
  await sleep(300);
  check('COPY COORDINATES still copies the good fix', (await page.evaluate(() => navigator.clipboard.readText())) === six(good), await text(page, '#fcl-copied'));
  const fits = await page.evaluate(() => {
    const b = document.getElementById('fcl-weak-copy').getBoundingClientRect();
    const p = document.getElementById('fc-launch-panel').getBoundingClientRect();
    return { bottom: Math.round(b.bottom), panelBottom: Math.round(p.bottom), h: innerHeight };
  });
  check('the weak fix and its button are in view at 1366 by 768', fits.bottom <= fits.panelBottom && fits.bottom <= fits.h, JSON.stringify(fits));
  await sleep(1200);
  await shot(page, 'l-1366-weak-under-good');
  // It survives a reload, in the saved record (the connection is closed
  // first, so no recording is left unfinished).
  await page.evaluate(() => window.fcLaunch.ctx.live.handlers.onClose({ lost: false }));
  await sleep(1200);
  await noteLogs(page);
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.log), { timeout: 40000, message: 'the panel did not come back' });
  await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.unfinished === false, { timeout: 10000, message: 'storage never answered about unfinished recordings' }).catch((err) => console.log(`      ${err.message}`));
  await sleep(300);
  st = await status(page);
  w = await words();
  check('after a reload the saved fix still has its weak fix', st.fix?.lat === good.lat && st.fix?.source === 'reload' && st.fix?.weak?.lat === weak.lat && w.weakShown && w.weakCoords === six(weak) &&
    /^SAVED FIX, FROM \d:\d\d AGO$/.test(w.state) && w.detail === 'Saved before the page was reloaded. No newer fix has been heard.', `"${w.state}" "${w.detail}" weak "${w.weakCoords}"`);

  // The rocket lies in the grass: after the reload a new connection only
  // hears weak fixes. The saved good fix stays in the big readout and in
  // storage, and the weak fix heard now goes under it.
  const grass = destinationPoint(good.lat, good.lon, 200, 18);
  const inGrass = { lat: Number(grass.lat.toFixed(7)), lon: Number(grass.lon.toFixed(7)) };
  const goodSaved = await savedFix(page);
  await open(page);
  for (let i = 0; i < 3; i++) await send({ ...inGrass, sats: 3, hdop: 6.4 });
  st = await status(page);
  w = await words();
  saved = await savedFix(page);
  check('after a reload, weak fixes only: the saved good fix stays in the big readout', st.fix?.lat === good.lat && st.fix?.lon === good.lon && st.fix?.quality === 'good' &&
    st.fix?.source === 'reload' && st.fix?.weakSince === true && w.title === 'LAST GOOD FIX' && w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) && st.copyText === six(good) &&
    /^SAVED FIX, FROM \d:\d\d AGO$/.test(w.state), `${w.lat}, ${w.lon} "${w.state}" (the weak packets said ${six(inGrass)}), source ${st.fix?.source}`);
  check('the weak fix heard now shows under it, and the line says only weak fixes were heard since', w.weakShown && w.weakCoords === six(inGrass) && /^NEWER WEAK FIX, FROM 0:0\d AGO$/.test(w.weakState) &&
    w.weakNote === '3 SATS, HDOP 6.40, 18 M FROM THE GOOD FIX' && w.detail === 'Saved before the page was reloaded. Only weak fixes have been heard since.' && st.weakCopyText === six(inGrass) && st.fix.packetAgeS < 2,
  `"${w.weakState}" "${w.weakCoords}" "${w.weakNote}" "${w.detail}", LAST PACKET ${st.fix?.packetAgeS?.toFixed(1)} s ago`);
  check('the saved record keeps the good fix, with the new weak fix under it', saved?.lat === good.lat && saved?.lon === good.lon && saved?.quality === 'good' && saved?.fixMs === goodSaved.fixMs &&
    saved?.weak?.lat === inGrass.lat && saved?.weak?.sats === 3 && saved?.weak?.hdop === 6.4 && saved.packetMs > goodSaved.packetMs,
  saved ? `main ${six(saved)} (${saved.quality}), weak ${saved.weak ? six(saved.weak) : 'none'}` : 'nothing saved');
  await sleep(600);
  await shot(page, 'l-1366-weak-after-reload');
  // The first good fix heard takes the readout back.
  const goodAgain = { lat: good.lat, lon: Number((good.lon + 1e-5).toFixed(7)) };
  await send(goodAgain);
  st = await status(page);
  w = await words();
  saved = await savedFix(page);
  check('the first good fix heard after that takes the readout back', st.fix?.lat === goodAgain.lat && st.fix?.lon === goodAgain.lon && st.fix?.source === 'live' && w.state === 'CURRENT FIX' && !w.weakShown &&
    saved?.lon === goodAgain.lon && saved?.weak === null, `${w.lat}, ${w.lon} "${w.state}", saved ${saved ? six(saved) : 'nothing'}`);
  await page.evaluate(() => window.fcLaunch.ctx.live.handlers.onClose({ lost: false }));
  await sleep(1200);
  await noteLogs(page);

  // Weak fixes only: the newest takes the main readout, named a weak fix.
  await startOver();
  seq = 0;
  await open(page);
  for (let i = 0; i < 3; i++) await send({ lat: weak.lat, lon: weak.lon + i * 1e-5, sats: 4, hdop: 5.2 });
  const lastWeak = { lat: weak.lat, lon: Number((weak.lon + 2e-5).toFixed(7)) };
  st = await status(page);
  w = await words();
  saved = await savedFix(page);
  check('weak fixes only: the newest one takes the main readout', st.fix?.lat === lastWeak.lat && st.fix?.lon === lastWeak.lon && st.fix?.quality === 'weak' && w.lat === lastWeak.lat.toFixed(6) && !w.weakShown,
    `${w.lat}, ${w.lon}`);
  check('it is named a weak fix, with its satellites and HDOP', w.title === 'LAST FIX' && w.state === 'CURRENT WEAK FIX' && w.detail === 'No good fix was heard, only this weak one. It may be off.' &&
    w.quality === '4 SATS, HDOP 5.20' && await page.evaluate(() => getComputedStyle(document.getElementById('fcl-fix-state')).color !== getComputedStyle(document.getElementById('fcl-lat')).color),
  `"${w.title}" "${w.state}" "${w.detail}" quality "${w.quality}"`);
  await page.click('#fcl-copy');
  await sleep(300);
  check('COPY COORDINATES copies it, and it is saved as a weak fix', (await page.evaluate(() => navigator.clipboard.readText())) === six(lastWeak) && saved?.quality === 'weak' && saved?.lat === lastWeak.lat && saved?.sats === 4,
    `clipboard "${await page.evaluate(() => navigator.clipboard.readText())}", saved quality ${saved?.quality}`);
  await sleep(800);
  await shot(page, 'l-1366-weak-only');
  await send(good);
  w = await words();
  check('the first good fix takes the readout over', w.state === 'CURRENT FIX' && w.title === 'LAST GOOD FIX' && w.lat === good.lat.toFixed(6) && w.quality === null, `"${w.state}" ${w.lat}`);

  // A real move: a few far fixes that agree take over.
  await startOver();
  seq = 0;
  for (let i = 0; i < 5; i++) await send(good);
  const there = destinationPoint(good.lat, good.lon, 200, 50000);
  const moved = { lat: Number(there.lat.toFixed(7)), lon: Number(there.lon.toFixed(7)) };
  await send(moved);
  const afterOne = (await status(page)).fix?.lat;
  await send(moved);
  const afterTwo = (await status(page)).fix?.lat;
  await send(moved);
  st = await status(page);
  w = await words();
  saved = await savedFix(page);
  check('a real move takes over after three fixes that agree', afterOne === good.lat && afterTwo === good.lat && st.fix?.lat === moved.lat && st.fix?.lon === moved.lon && w.state === 'CURRENT FIX' && saved?.lat === moved.lat,
    `after one ${afterOne}, after two ${afterTwo}, after three ${st.fix?.lat} (${w.state}), saved ${saved?.lat}`);

  // A coordinate that rounds to zero has no minus sign anywhere.
  await startOver();
  seq = 0;
  for (let i = 0; i < 2; i++) await send({ lat: -0.0000001, lon: FIELD.lon });
  st = await status(page);
  const zero = await page.evaluate(async () => {
    // Pretend the internet answered, so OPEN IN MAPS shows.
    const realFetch = window.fetch;
    window.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
    await window.fcLaunch.online.check();
    window.fetch = realFetch;
    await new Promise((r) => setTimeout(r, 300));
    return { lat: document.getElementById('fcl-lat').textContent, href: document.getElementById('fcl-maps').getAttribute('href') };
  });
  await page.click('#fcl-copy');
  await sleep(300);
  const zeroCopied = await page.evaluate(() => navigator.clipboard.readText());
  check('a latitude that rounds to zero has no minus sign in the readout, the copy or the maps link', zero.lat === '0.000000' && st.copyText === `0.000000, ${FIELD.lon.toFixed(6)}` &&
    zeroCopied === `0.000000, ${FIELD.lon.toFixed(6)}` && zero.href === `https://www.google.com/maps/search/?api=1&query=0.000000,${FIELD.lon.toFixed(6)}`,
  `readout "${zero.lat}", copied "${zeroCopied}", link ${zero.href}`);

  const exceptions = page.exceptions();
  check('no exceptions with the bad packets', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// ------------------------------------------------------------------
// gaps: a far packet after a stretch without packets, and as the first
// packet after a reload
// ------------------------------------------------------------------

const FAR_WORDS = 'The newest position is far from this one. It shows below until the next fixes agree with it.';
const JUMP_WORDS = 'The newest position is too far from this one to be real, so it is left out.';

// What the readout, the lines under it and the ALSO SAVED lines say.
const panelWords = (page) => page.evaluate(() => {
  const g = (id) => document.getElementById(id);
  return {
    title: g('fcl-rec-words').textContent,
    rocket: document.querySelector('.fcl-rocket').textContent,
    lat: g('fcl-lat').textContent,
    lon: g('fcl-lon').textContent,
    state: g('fcl-fix-state').textContent,
    detail: g('fcl-fix-detail').hidden ? '' : g('fcl-fix-detail').textContent,
    range: g('fcl-range').textContent,
    underShown: !g('fcl-weak').hidden,
    underKind: g('fcl-weak').hidden ? null : g('fcl-weak').dataset.kind,
    underState: g('fcl-weak-state').textContent,
    underCoords: g('fcl-weak-coords').textContent,
    underNote: g('fcl-weak-note').textContent,
    underButton: g('fcl-weak-copy').textContent,
    // One entry for each other rocket: which and how old, then its coordinates.
    others: g('fcl-others').hidden ? [] : [...g('fcl-others-list').children].map((d) => [...d.children].map((p) => p.textContent).join(' / ')),
  };
});
const otherFixes = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('fc-launch-other-fixes') ?? 'null'));
const lastGrade = (page, id = '1') => page.evaluate((rocketId) => window.fcLaunch.ctx.liveStore('flight').getRocket(rocketId)?.crumbs.at(-1)?.quality ?? null, id);
const round7 = (p) => ({ lat: Number(p.lat.toFixed(7)), lon: Number(p.lon.toFixed(7)) });

// Lines through the stand-in port, all at once.
const sendNow = (page, lines) => page.evaluate((part) => {
  for (const l of part) window.__fake.port.send(`${l}\r\n`);
}, lines);

// DISCONNECT, and the moment the recording needs to be saved, so none is
// left unfinished for RECOVER.
async function disconnectFake(page) {
  await page.click('#bc-connect');
  await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'DISCONNECT did not close the stand-in port' });
  await sleep(1200);
  await noteLogs(page);
}

async function reloadLaunch(page) {
  await noteLogs(page);
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.log && window.fcLaunch?.parts?.capture), { timeout: 40000, message: 'the panel did not come back' });
  await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.unfinished === false, { timeout: 10000, message: 'storage never answered about unfinished recordings' }).catch((err) => console.log(`      ${err.message}`));
  await sleep(300);
}

// Good packets a second apart, quietS seconds with only the receiver's
// status line, then one packet km away with fix=yes and 12 satellites.
async function gapCase(quietS, km) {
  const name = `${quietS} s without packets, then one packet ${km} km away`;
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, [FAKE, WATCH]);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await browser.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const good = round7(destinationPoint(FIELD.lat, FIELD.lon, 40, 600));
  const far = round7(destinationPoint(good.lat, good.lon, 80, km * 1000));
  const apart = km < 10 ? `${(km * 1000).toLocaleString('en-US')} M` : `${km.toFixed(2)} KM`;
  await connectFake(page);
  let n = 0;
  let seq = 0;
  const packet = async (fields) => {
    await sendNow(page, [statusLine(n), pktLine({ seq: seq++, t: 100 + n, ...fields })]);
    n += 1;
  };
  const quiet = async (seconds) => {
    for (let i = 0; i < seconds; i++) {
      await sendNow(page, [statusLine(n)]);
      n += 1;
      seq += 1;
      await sleep(1000);
    }
  };
  for (let i = 0; i < 6; i++) {
    await packet(good);
    await sleep(1000);
  }
  const before = await panelWords(page);
  await quiet(quietS);
  await packet(far);
  await sleep(400);
  let st = await status(page);
  let w = await panelWords(page);
  let saved = await savedFix(page);
  const grade = await lastGrade(page);
  check(`${name}: the readout stays on the good fix`, grade === 'good' && st.fix?.lat === good.lat && st.fix?.lon === good.lon && w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) &&
    st.copyText === six(good) && w.range === before.range && /^600 M AT /.test(w.range),
  `the trail graded the far packet "${grade}", readout ${w.lat}, ${w.lon}, range "${w.range}" (the far packet said ${six(far)})`);
  check(`${name}: it is not called current, and the line says why`, st.fix?.old === true && st.fix?.why === 'far' && st.fix?.source === 'live' && /^OLD FIX, FROM \d:\d\d AGO$/.test(w.state) && w.detail === FAR_WORDS,
    `"${w.state}" "${w.detail}"`);
  check(`${name}: the far position shows under it as not confirmed, with how far it is`, w.underShown && w.underKind === 'held' && /^NEWER FIX, NOT CONFIRMED, FROM 0:0\d AGO$/.test(w.underState) &&
    w.underCoords === six(far) && w.underNote === `12 SATS, HDOP 0.90, ${apart} FROM THE GOOD FIX` && w.underButton === 'COPY NEWER FIX' && st.fix?.under === 'held' && st.fix?.held?.lat === far.lat &&
    st.fix?.weak === null && st.weakCopyText === six(far), `"${w.underState}" "${w.underCoords}" "${w.underNote}" [${w.underButton}]`);
  check(`${name}: storage keeps the good fix as the main one, the far one only under it`, saved?.lat === good.lat && saved?.lon === good.lon && saved?.quality === 'good' &&
    saved?.held?.lat === far.lat && saved?.held?.lon === far.lon && saved.held.fixMs > saved.fixMs && saved?.weak === null,
  saved ? `main ${six(saved)}, held ${saved.held ? six(saved.held) : 'none'}` : 'nothing saved');
  await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
  await page.click('#fcl-weak-copy');
  await sleep(300);
  const copiedFar = await page.evaluate(() => navigator.clipboard.readText());
  await page.click('#fcl-copy');
  await sleep(300);
  const copiedGood = await page.evaluate(() => navigator.clipboard.readText());
  check(`${name}: COPY NEWER FIX copies the far one, COPY COORDINATES the good one`, copiedFar === six(far) && copiedGood === six(good), `"${copiedFar}" and "${copiedGood}"`);
  await shot(page, `q-1366-far-after-${quietS}s`);

  // Packets stop again. The good fix is still the one to walk to.
  await quiet(8);
  w = await panelWords(page);
  saved = await savedFix(page);
  check(`${name}: 8 s later, with no more packets, it is still the good fix`, w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) && /^OLD FIX, FROM \d:\d\d AGO$/.test(w.state) &&
    w.detail === 'Packets from the rocket have stopped.' && w.underKind === 'held' && w.underCoords === six(far) && saved?.lat === good.lat && saved?.lon === good.lon,
  `${w.lat}, ${w.lon} "${w.state}" "${w.detail}", under it "${w.underCoords}", saved ${saved ? six(saved) : 'nothing'}`);

  // True packets again, a meter further east each time.
  const after = [];
  for (let i = 1; i <= 3; i++) {
    const at = { lat: good.lat, lon: Number((good.lon + i * 1e-5).toFixed(7)) };
    await packet(at);
    await sleep(400);
    after.push({ at, w: await panelWords(page), saved: await savedFix(page), grade: await lastGrade(page) });
    await sleep(600);
  }
  const first = after[0];
  check(`${name}: the first true packet after it is the current fix again`, first.w.lat === first.at.lat.toFixed(6) && first.w.lon === first.at.lon.toFixed(6) && first.w.state === 'CURRENT FIX' && first.w.detail === '' &&
    !first.w.underShown && first.saved?.lon === first.at.lon && first.saved?.held === null,
  `the trail graded it "${first.grade}", readout ${first.w.lat}, ${first.w.lon} "${first.w.state}", saved ${first.saved ? six(first.saved) : 'nothing'}`);
  const seen = await page.evaluate(() => window.__seen.details);
  check(`${name}: so are the next two, and the panel never said the true position was too far to be real`,
    after.every((a) => a.w.lon === a.at.lon.toFixed(6) && a.w.state === 'CURRENT FIX' && a.saved?.lon === a.at.lon) && seen.includes(FAR_WORDS) && !seen.includes(JUMP_WORDS),
    `${after.map((a) => `${a.grade}: ${a.w.lon} "${a.w.state}"`).join(', ')}. Lines shown: ${JSON.stringify(seen)}`);
  const exceptions = page.exceptions();
  check(`${name}: no exceptions`, exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
  await disconnectFake(page);
}

// The first packet heard after a reload is 50 km from the saved fix.
async function reloadFarCase() {
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, [FAKE]);
  const good = round7(destinationPoint(FIELD.lat, FIELD.lon, 40, 600));
  const far = round7(destinationPoint(good.lat, good.lon, 80, 50000));
  let n = 0;
  const packet = async (fields, wait = 400) => {
    await sendNow(page, [statusLine(n), pktLine({ seq: n, t: 100 + n, ...fields })]);
    n += 1;
    await sleep(wait);
  };
  await connectFake(page);
  for (let i = 0; i < 5; i++) await packet(good);
  await disconnectFake(page);
  const saved0 = await savedFix(page);
  await reloadLaunch(page);
  let st = await status(page);
  check('after a reload: the saved fix shows', saved0?.lat === good.lat && st.fix?.lat === good.lat && st.fix?.lon === good.lon && st.fix?.source === 'reload', `${st.fix?.lat}, ${st.fix?.lon}, ${st.fix?.source}`);

  await connectFake(page);
  await packet(far, 500);
  st = await status(page);
  let w = await panelWords(page);
  let saved = await savedFix(page);
  check('after a reload, the first packet is 50 km away: the saved fix stays in the big readout', (await lastGrade(page)) === 'good' && st.fix?.lat === good.lat && st.fix?.lon === good.lon && st.fix?.source === 'reload' &&
    st.fix?.quality === 'good' && st.fix?.farSince === true && w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) && st.copyText === six(good) && /^SAVED FIX, FROM \d:\d\d AGO$/.test(w.state) &&
    w.detail === `Saved before the page was reloaded. ${FAR_WORDS}`, `${w.lat}, ${w.lon} "${w.state}" "${w.detail}" (the packet said ${six(far)})`);
  check('the far position shows under it as not confirmed', w.underKind === 'held' && /^NEWER FIX, NOT CONFIRMED, FROM 0:0\d AGO$/.test(w.underState) && w.underCoords === six(far) &&
    w.underNote === '12 SATS, HDOP 0.90, 50.00 KM FROM THE GOOD FIX' && w.underButton === 'COPY NEWER FIX' && st.fix.packetAgeS < 2, `"${w.underState}" "${w.underCoords}" "${w.underNote}"`);
  check('storage keeps the saved fix as the main one', saved?.lat === good.lat && saved?.lon === good.lon && saved?.fixMs === saved0.fixMs && saved?.held?.lat === far.lat && saved.packetMs > saved0.packetMs,
    saved ? `main ${six(saved)} (was ${six(saved0)}), held ${saved.held ? six(saved.held) : 'none'}` : 'nothing saved');
  await sleep(600);
  await shot(page, 'q-1366-far-first-after-reload');

  // The rocket lies in the grass: only weak fixes, at the true spot.
  for (let i = 0; i < 5; i++) await packet({ ...good, sats: 4, hdop: 5.2 });
  st = await status(page);
  w = await panelWords(page);
  saved = await savedFix(page);
  check('weak fixes at the true spot after it: still the saved fix, with the weak fix under it', st.fix?.lat === good.lat && st.fix?.source === 'reload' && st.fix?.weakSince === true && st.fix?.farSince === true &&
    w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) && w.underKind === 'weak' && w.underCoords === six(good) && w.underNote === '4 SATS, HDOP 5.20, 0 M FROM THE GOOD FIX' &&
    w.underButton === 'COPY WEAK FIX' && w.detail === 'Saved before the page was reloaded. Only weak fixes, and positions far from this one, have been heard since.',
  `${w.lat}, ${w.lon} "${w.state}" "${w.detail}", under it "${w.underState}" "${w.underCoords}" "${w.underNote}"`);
  check('storage still has the saved fix as the main one', saved?.lat === good.lat && saved?.lon === good.lon && saved?.fixMs === saved0.fixMs && saved?.weak?.lat === good.lat && saved?.held?.lat === far.lat,
    saved ? `main ${six(saved)}, weak ${saved.weak ? six(saved.weak) : 'none'}, held ${saved.held ? six(saved.held) : 'none'}` : 'nothing saved');
  await shot(page, 'q-1366-far-first-then-weak');
  // Packets stop.
  for (let i = 0; i < 7; i++) {
    await sendNow(page, [statusLine(n)]);
    n += 1;
    await sleep(1000);
  }
  w = await panelWords(page);
  saved = await savedFix(page);
  check('packets stop: still the saved good fix on the panel and in storage', w.lat === good.lat.toFixed(6) && w.lon === good.lon.toFixed(6) && /^SAVED FIX, FROM \d:\d\d AGO$/.test(w.state) && saved?.lat === good.lat && saved?.lon === good.lon,
    `${w.lat}, ${w.lon} "${w.state}", saved ${saved ? six(saved) : 'nothing'}`);
  // Good packets at the true spot. The readout is on the true spot all the
  // while, and the third one is the current fix.
  const steps = [];
  for (let i = 1; i <= 3; i++) {
    await packet({ lat: good.lat, lon: Number((good.lon + i * 1e-5).toFixed(7)) });
    const now = await panelWords(page);
    steps.push({ lat: now.lat, lon: now.lon, state: now.state.replace(/FROM .* AGO/, 'FROM x AGO') });
  }
  const third = Number((good.lon + 3e-5).toFixed(7));
  saved = await savedFix(page);
  check('good packets at the true spot: the readout never leaves it, and the third is the current fix', steps[0].lon === good.lon.toFixed(6) && steps[1].lon === good.lon.toFixed(6) &&
    steps.every((s) => s.lat === good.lat.toFixed(6)) && steps[2].lon === third.toFixed(6) && steps[2].state === 'CURRENT FIX' && saved?.lon === third && saved?.held === null && saved?.weak === null,
  `${steps.map((s) => `${s.lat}, ${s.lon} "${s.state}"`).join(' then ')}, saved ${saved ? six(saved) : 'nothing'}`);

  // A reload now shows the true spot, never the far packet.
  await disconnectFake(page);
  await reloadLaunch(page);
  st = await status(page);
  check('after another reload the saved fix is the true spot', st.fix?.lat === good.lat && st.fix?.lon === third && st.fix?.source === 'reload' && st.fix?.held === null, `${st.fix?.lat}, ${st.fix?.lon}, ${st.fix?.source}`);

  // A real move after a reload: the rocket was carried 5 km while the page
  // was away. Three fixes that agree take over.
  await connectFake(page);
  const moved = round7(destinationPoint(good.lat, good.lon, 200, 5000));
  const movedSteps = [];
  for (let i = 0; i < 3; i++) {
    await packet({ lat: moved.lat, lon: Number((moved.lon + i * 1e-5).toFixed(7)) });
    const s = await status(page);
    movedSteps.push({ lat: s.fix?.lat, source: s.fix?.source, held: s.fix?.held?.lat ?? null, why: s.fix?.why });
  }
  saved = await savedFix(page);
  const movedLast = Number((moved.lon + 2e-5).toFixed(7));
  w = await panelWords(page);
  check('a real move after a reload takes over after three fixes that agree', movedSteps[0].lat === good.lat && movedSteps[0].held === moved.lat && movedSteps[0].source === 'reload' && movedSteps[1].lat === good.lat &&
    movedSteps[1].held === moved.lat && movedSteps[2].lat === moved.lat && movedSteps[2].source === 'live' && movedSteps[2].why === 'current' && w.state === 'CURRENT FIX' && !w.underShown &&
    saved?.lat === moved.lat && saved?.lon === movedLast && saved?.held === null,
  `${movedSteps.map((s) => `${s.lat} (${s.source}${s.held ? `, held ${s.held}` : ''})`).join(' then ')}, "${w.state}", saved ${saved ? six(saved) : 'nothing'}`);

  // A far packet is the last thing heard before a reload (8 s later on the
  // board's clock, 3 km away). Afterwards it is still under the saved fix
  // as not confirmed, and the line above it doesn't say nothing newer was heard.
  const lone = round7(destinationPoint(moved.lat, movedLast, 80, 3000));
  await sendNow(page, [statusLine(n), pktLine({ seq: n + 8, t: 100 + n + 8, ...lone })]);
  await sleep(500);
  await disconnectFake(page);
  await reloadLaunch(page);
  st = await status(page);
  w = await panelWords(page);
  check('a far packet just before a reload is still under the saved fix afterwards, as not confirmed', st.fix?.lat === moved.lat && st.fix?.lon === movedLast && st.fix?.source === 'reload' &&
    st.fix?.under === 'held' && w.underCoords === six(lone) && /^NEWER FIX, NOT CONFIRMED, FROM \d:\d\d AGO$/.test(w.underState) && w.underNote === '12 SATS, HDOP 0.90, 3,000 M FROM THE GOOD FIX' &&
    w.detail === `Saved before the page was reloaded. ${FAR_WORDS}`, `${w.lat}, ${w.lon} "${w.state}" "${w.detail}", under it "${w.underState}" "${w.underCoords}" "${w.underNote}"`);
  await shot(page, 'q-1366-held-after-reload');
  const exceptions = page.exceptions();
  check('no exceptions with a far packet first after a reload', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

async function partGaps() {
  console.log('\n== A far packet after a stretch without packets, and first after a reload ==');
  // The 100 s wait runs beside the other two cases, each in its own Chrome.
  await Promise.all([
    gapCase(100, 50),
    (async () => {
      await gapCase(6, 3);
      await reloadFarCase();
    })(),
  ]);
}

// ------------------------------------------------------------------
// rockets: two boards on the air
// ------------------------------------------------------------------

async function partRockets() {
  console.log('\n== Two boards ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, [FAKE, WATCH]);
  const good = round7(destinationPoint(FIELD.lat, FIELD.lon, 40, 600));
  const other = round7(destinationPoint(FIELD.lat, FIELD.lon, 200, 900));
  const focusedId = () => page.evaluate(() => String(window.fcLaunch.ctx.liveStore('flight').getFocused()?.id));
  let n = 0;
  const packet = async (fields, wait = 400) => {
    await sendNow(page, [statusLine(n), pktLine({ seq: n, t: 100 + n, ...fields })]);
    n += 1;
    await sleep(wait);
  };
  // Rocket 1 is heard and its fix saved. Then the page is reloaded.
  await connectFake(page);
  for (let i = 0; i < 4; i++) await packet(good, 300);
  await disconnectFake(page);
  await reloadLaunch(page);
  await connectFake(page);
  // Rocket 2 is heard first, with no fix, so the store's focus is rocket 2.
  await packet({ node: 2, t: 500, lat: 0, lon: 0, fix: 'no', sats: 0, hdop: 99.9 }, 500);
  let st = await status(page);
  let w = await panelWords(page);
  check('rocket 2 is heard first with no fix: rocket 1\'s saved fix stays', (await focusedId()) === '2' && st.fix?.rocketId === '1' && st.fix?.lat === good.lat && st.fix?.lon === good.lon && st.fix?.source === 'reload',
    `focus on rocket ${await focusedId()}, readout rocket ${st.fix?.rocketId} ${w.lat}, ${w.lon} "${w.state}"`);
  // Rocket 1 is heard again, 30 m east.
  const newer = { lat: good.lat, lon: Number((good.lon + 4e-4).toFixed(7)) };
  for (let i = 0; i < 3; i++) await packet({ node: 1, t: 200 + i, ...newer });
  st = await status(page);
  w = await panelWords(page);
  let saved = await savedFix(page);
  check('rocket 1\'s newer fixes show while rocket 2 is in focus', (await focusedId()) === '2' && st.fix?.rocketId === '1' && st.fix?.lat === newer.lat && st.fix?.lon === newer.lon && st.fix?.source === 'live' &&
    w.lat === newer.lat.toFixed(6) && w.lon === newer.lon.toFixed(6) && w.state === 'CURRENT FIX' && w.detail === '' && st.fix.packetAgeS < 2,
  `focus on rocket ${await focusedId()}, readout rocket ${st.fix?.rocketId} ${w.lat}, ${w.lon} "${w.state}" "${w.detail}" (the saved fix was ${six(good)})`);
  check('and they are saved', saved?.rocketId === '1' && saved?.lat === newer.lat && saved?.lon === newer.lon, saved ? `rocket ${saved.rocketId} ${six(saved)}` : 'nothing saved');
  // Rocket 2 gets a fix. The readout follows the rocket in focus, and
  // rocket 1's fix must not be lost.
  for (let i = 0; i < 2; i++) await packet({ node: 2, t: 501 + i, ...other });
  st = await status(page);
  w = await panelWords(page);
  saved = await savedFix(page);
  let others = await otherFixes(page);
  check('rocket 2 gets a fix: the readout follows the rocket in focus', st.fix?.rocketId === '2' && st.fix?.lat === other.lat && st.fix?.lon === other.lon && w.state === 'CURRENT FIX' && w.rocket === 'ROCKET 2' &&
    saved?.rocketId === '2' && saved?.lat === other.lat, `readout "${w.rocket}" ${w.lat}, ${w.lon} "${w.state}", saved rocket ${saved?.rocketId}`);
  check('rocket 1\'s fix stays in storage and shows on the ALSO SAVED lines', Array.isArray(others) && others.length === 1 && others[0].rocketId === '1' && others[0].lat === newer.lat && others[0].lon === newer.lon &&
    st.others.length === 1 && st.others[0].rocketId === '1' && w.others.length === 1 && /^GPS AND RADIO BOARD, FROM 0:0\d AGO \/ /.test(w.others[0]) && w.others[0].endsWith(` / ${six(newer)}`),
  `storage ${JSON.stringify((others ?? []).map((o) => `rocket ${o.rocketId} ${six(o)}`))}, lines ${JSON.stringify(w.others)}`);
  // Rocket 1 moves on while rocket 2 is on show.
  const newest = { lat: good.lat, lon: Number((good.lon + 8e-4).toFixed(7)) };
  await packet({ node: 1, t: 203, ...newest });
  st = await status(page);
  w = await panelWords(page);
  others = await otherFixes(page);
  check('a newer fix of rocket 1 is saved while rocket 2 is on show', st.fix?.rocketId === '2' && others?.[0]?.rocketId === '1' && others[0].lon === newest.lon && w.others[0]?.endsWith(` / ${six(newest)}`),
    `readout rocket ${st.fix?.rocketId}, storage ${JSON.stringify((others ?? []).map((o) => `rocket ${o.rocketId} ${six(o)}`))}, lines ${JSON.stringify(w.others)}`);
  const fits = await page.evaluate(() => {
    const b = document.getElementById('fcl-others').getBoundingClientRect();
    const p = document.getElementById('fc-launch-panel').getBoundingClientRect();
    const r = document.querySelector('.fcl-recovery').getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right), panelBottom: Math.round(p.bottom), panelRight: Math.round(p.right), readoutBottom: Math.round(r.bottom), h: innerHeight };
  });
  check('the ALSO SAVED lines are in view at 1366 by 768, right under the readout', fits.bottom <= fits.panelBottom && fits.bottom <= fits.h && fits.right <= fits.panelRight && fits.top >= fits.readoutBottom - 1 &&
    fits.top <= fits.readoutBottom + 2, JSON.stringify(fits));
  await sleep(600);
  await shot(page, 'r-1366-two-rockets');
  // Rocket 1 in focus: the readout is rocket 1's, and rocket 2 is on the lines.
  await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').focus('1'));
  await sleep(500);
  st = await status(page);
  w = await panelWords(page);
  saved = await savedFix(page);
  others = await otherFixes(page);
  check('with rocket 1 in focus the readout is rocket 1\'s, and rocket 2 is on the lines', st.fix?.rocketId === '1' && st.fix?.lat === newest.lat && st.fix?.lon === newest.lon && st.fix?.source === 'live' &&
    saved?.rocketId === '1' && saved?.lon === newest.lon && others?.length === 1 && others[0].rocketId === '2' && others[0].lat === other.lat && w.others.length === 1 && /^ROCKET 2, FROM \d:\d\d AGO \/ /.test(w.others[0]) && w.others[0].endsWith(` / ${six(other)}`),
  `readout rocket ${st.fix?.rocketId} ${w.lat}, ${w.lon}, saved rocket ${saved?.rocketId}, lines ${JSON.stringify(w.others)}`);
  // Both are still there after a reload.
  await disconnectFake(page);
  await reloadLaunch(page);
  st = await status(page);
  w = await panelWords(page);
  check('after a reload both saved fixes are still there', st.fix?.rocketId === '1' && st.fix?.lon === newest.lon && st.fix?.source === 'reload' && w.others.length === 1 && /^ROCKET 2, FROM \d:\d\d AGO \/ /.test(w.others[0]) && w.others[0].endsWith(` / ${six(other)}`),
    `readout rocket ${st.fix?.rocketId} ${w.lat}, ${w.lon} (${st.fix?.source}), lines ${JSON.stringify(w.others)}`);
  await shot(page, 'r-1366-two-rockets-reloaded');
  // CLEAR SAVED FIX clears the one on show. The other rocket's then shows.
  await page.evaluate(() => window.fcLaunch.parts.panel.clearSavedFix());
  await sleep(400);
  st = await status(page);
  w = await panelWords(page);
  saved = await savedFix(page);
  others = await otherFixes(page);
  check('CLEAR SAVED FIX clears the one on show, and the other rocket\'s fix shows', st.fix?.rocketId === '2' && st.fix?.lat === other.lat && st.fix?.source === 'reload' && w.rocket === 'ROCKET 2' &&
    saved?.rocketId === '2' && others === null && w.others.length === 0, `readout "${w.rocket}" ${w.lat}, ${w.lon}, saved rocket ${saved?.rocketId}, other fixes in storage: ${JSON.stringify(others)}`);
  await page.evaluate(() => window.fcLaunch.parts.panel.clearSavedFix());
  await sleep(400);
  st = await status(page);
  check('clearing that one too leaves nothing', st.fix === null && (await savedFix(page)) === null && (await otherFixes(page)) === null, JSON.stringify(st.fix));
  const exceptions = page.exceptions();
  check('no exceptions with two boards', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// ------------------------------------------------------------------
// test: a test capture over a real saved fix, and another rocket's packet
// ------------------------------------------------------------------

async function partTest() {
  console.log('\n== A test capture over a real saved fix ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, []);
  const spot = destinationPoint(FIELD.lat, FIELD.lon, 300, 900);
  const real = { lat: Number(spot.lat.toFixed(7)), lon: Number(spot.lon.toFixed(7)) };
  // A real connection hears the rocket, and closes.
  await open(page);
  await feed(page, [0, 1, 2, 3].map((i) => pktLine({ seq: i, t: 100 + i, ...real })), 20);
  await sleep(300);
  await page.evaluate(() => window.fcLaunch.ctx.live.handlers.onClose({ lost: false }));
  await sleep(1200);
  const before = await savedFix(page);
  check('a real fix is saved', before?.lat === real.lat && before?.test === false, JSON.stringify(before && { lat: before.lat, test: before.test }));
  await noteLogs(page);
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.capture), { timeout: 40000, message: 'the panel did not come back' });
  await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.unfinished === false, { timeout: 10000, message: 'storage never answered about unfinished recordings' }).catch((err) => console.log(`      ${err.message}`));
  // The panel draws a moment after its status changes.
  await sleep(300);
  let st = await status(page);
  check('after a reload it is the saved fix, and nothing waits for RECOVER', st.fix?.lat === real.lat && st.fix?.source === 'reload' && st.fix?.test === false &&
    (await text(page, '#fcl-fix-detail')) === 'Saved before the page was reloaded. No newer fix has been heard.', `${st.fix?.lat}, "${await text(page, '#fcl-fix-detail')}"`);

  // The test capture plays (20 times real speed, moved to the field).
  await page.evaluate(() => { window.fcPlayed = window.fcLaunch.parts.capture.play({ speed: 20, shift: 'field' }); });
  await page.waitFor(() => window.fcLaunch.parts.panel.status().fix?.test === true, { timeout: 30000, message: 'the test capture never reached the panel' });
  await sleep(1500);
  st = await status(page);
  let saved = await savedFix(page);
  check('while the capture plays, the readout shows the test fix with its note', st.fix?.test === true && st.fix?.source === 'live' && st.fix?.lat !== real.lat &&
    (await text(page, '#fcl-fix-detail')).endsWith('This fix came from the test capture.'), `${st.fix?.lat}, "${await text(page, '#fcl-fix-detail')}"`);
  check('but the real saved fix stays in storage', saved?.lat === real.lat && saved?.lon === real.lon && saved?.test === false && saved?.fixMs === before.fixMs, JSON.stringify(saved && { lat: saved.lat, test: saved.test }));
  await page.waitFor(() => window.fcLaunch.parts.capture.status().playing === false, { timeout: 60000, interval: 250, message: 'the capture never ended' });
  await sleep(1200);
  saved = await savedFix(page);
  check('after the capture ends it is still the real one in storage', saved?.lat === real.lat && saved?.test === false, JSON.stringify(saved && { lat: saved.lat, test: saved.test }));
  await shot(page, 'm-1366-test-over-real');

  // A real connection: the flight log clears the test's data, and the real
  // saved fix is back on the panel.
  await open(page);
  await sleep(400);
  st = await status(page);
  saved = await savedFix(page);
  check('a real connection after the capture brings the real saved fix back', st.fix?.lat === real.lat && st.fix?.lon === real.lon && st.fix?.test === false && st.fix?.source === 'reload' &&
    (await text(page, '#fcl-lat')) === real.lat.toFixed(6) && saved?.lat === real.lat && saved?.test === false,
  `${st.fix?.lat}, ${st.fix?.lon}, test ${st.fix?.test}, source ${st.fix?.source}, storage ${saved ? `${saved.lat} test ${saved.test}` : 'empty'}`);
  await shot(page, 'm-1366-real-back');

  // Another rocket's packet (no fix in it) doesn't put its time under
  // rocket 1's saved fix.
  const packetBefore = st.fix.packetWallMs;
  await feed(page, [pktLine({ node: 2, seq: 0, t: 500, lat: 0, lon: 0, fix: 'no', sats: 0, hdop: 99.9 })], 20);
  await sleep(400);
  st = await status(page);
  check('a packet from rocket 2 leaves LAST PACKET under rocket 1\'s saved fix alone', st.fix?.rocketId === '1' && st.fix?.packetWallMs === packetBefore && st.fix.packetWallMs === before.packetMs &&
    Math.abs(st.fix.packetAgeS - st.fix.ageS) < 0.01, `rocket ${st.fix?.rocketId}, LAST PACKET "${await text(page, '#fcl-packet')}", the saved packet time is ${before.packetMs}, shown ${st.fix?.packetWallMs}`);
  // Rocket 1's own packet (still no fix) does move it.
  const sentAt = await page.evaluate(() => Date.now());
  await feed(page, [pktLine({ node: 1, seq: 10, t: 700, ...real, fix: 'no', sats: 0, hdop: 99.9 })], 20);
  await page.evaluate(() => window.fcLaunch.ctx.liveStore('flight').focus('1'));
  await sleep(400);
  st = await status(page);
  check('rocket 1\'s own packet does move LAST PACKET', st.fix?.lat === real.lat && st.fix?.source === 'reload' && Math.abs(st.fix.packetWallMs - sentAt) < 300 && st.fix.packetAgeS < 2,
    `LAST PACKET "${await text(page, '#fcl-packet')}", ${st.fix?.packetWallMs - sentAt} ms from when it was sent`);
  const exceptions = page.exceptions();
  check('no exceptions with the test capture over a real fix', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// ------------------------------------------------------------------
// tabs: a second launch tab
// ------------------------------------------------------------------

async function partTabs() {
  console.log('\n== A second launch tab ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const first = await openWith(browser, []);
  const spot = destinationPoint(FIELD.lat, FIELD.lon, 150, 700);
  const at = (i) => ({ lat: Number(spot.lat.toFixed(7)), lon: Number((spot.lon + i * 2e-5).toFixed(7)) });
  await open(first);
  for (let i = 0; i < 3; i++) {
    await feed(first, [pktLine({ seq: i, t: 100 + i, ...at(i) })], 20);
    await sleep(250);
  }
  // The second tab opens while the first is connected.
  const COUNT_WRITES = `(() => {
    window.__writes = 0;
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'fc-launch-last-fix') window.__writes += 1;
      return real.call(this, key, value);
    };
  })();`;
  const second = await openWith(browser, [COUNT_WRITES]);
  await sleep(600);
  let st = await status(second);
  check('the second tab starts with the fix the first tab saved', st.fix?.lat === at(2).lat && st.fix?.lon === at(2).lon && st.fix?.source === 'reload', `${st.fix?.lat}, ${st.fix?.lon}, ${st.fix?.source}`);
  // The first tab keeps hearing the rocket.
  for (let i = 3; i < 9; i++) {
    await feed(first, [pktLine({ seq: i, t: 100 + i, ...at(i) })], 20);
    await sleep(300);
  }
  await sleep(300);
  st = await status(second);
  const firstSt = await status(first);
  const shown = await second.evaluate(() => ({
    lat: document.getElementById('fcl-lat').textContent,
    lon: document.getElementById('fcl-lon').textContent,
    state: document.getElementById('fcl-fix-state').textContent,
    detail: document.getElementById('fcl-fix-detail').textContent,
    writes: window.__writes,
  }));
  check('the second tab follows the first tab\'s newest fix', st.fix?.lat === at(8).lat && st.fix?.lon === at(8).lon && shown.lat === at(8).lat.toFixed(6) && shown.lon === at(8).lon.toFixed(6) &&
    st.fix.wallMs === firstSt.fix.wallMs, `second tab ${shown.lat}, ${shown.lon}, first tab ${firstSt.fix?.lat}, ${firstSt.fix?.lon}`);
  check('and says where it came from, never that no newer fix was heard', st.fix?.source === 'tab' && st.fix?.why === 'tab' && shown.detail === 'Heard in another launch tab on this laptop.' &&
    /^SAVED FIX, FROM 0:0\d AGO$/.test(shown.state), `"${shown.state}" "${shown.detail}"`);
  check('the second tab never wrote the saved fix itself', shown.writes === 0, `${shown.writes} writes`);
  await shot(second, 'n-1366-second-tab');
  // A test record written by some tab never takes the real one's place here.
  await first.evaluate(() => {
    const record = JSON.parse(localStorage.getItem('fc-launch-last-fix'));
    window.fcRealRecord = JSON.stringify(record);
    localStorage.setItem('fc-launch-last-fix', JSON.stringify({ ...record, lat: 10, lon: 20, test: true, fixMs: record.fixMs + 60000, packetMs: record.packetMs + 60000 }));
  });
  await sleep(400);
  st = await status(second);
  check('a test record from another tab never takes the real one\'s place', st.fix?.lat === at(8).lat && st.fix?.test === false, `${st.fix?.lat}, test ${st.fix?.test}`);
  await first.evaluate(() => localStorage.setItem('fc-launch-last-fix', window.fcRealRecord));
  // The first tab hears the rocket again: both tabs move on.
  await feed(first, [pktLine({ seq: 9, t: 109, ...at(9) })], 20);
  await sleep(500);
  st = await status(second);
  check('the second tab moves on with the first', st.fix?.lat === at(9).lat && st.fix?.lon === at(9).lon && st.fix?.source === 'tab' && st.fix?.test === false,
    `${st.fix?.lat}, ${st.fix?.lon} (the first tab's newest packet said ${six(at(9))}), ${st.fix?.source}`);
  const exceptions = [...first.exceptions(), ...second.exceptions()];
  check('no exceptions in either tab', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// ------------------------------------------------------------------
// layout: the window sizes launch day can have
// ------------------------------------------------------------------

async function partLayout() {
  console.log('\n== The window sizes launch day can have ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await openWith(browser, []);
  const flight = syntheticFlight(FIELD, 62, 840);
  await open(page);
  await feed(page, flight.lines, 60);
  await page.waitFor(() => document.getElementById('fc-console').dataset.state === 'recovery', { timeout: 15000, message: 'the flight did not land' });
  // launch-mode.bat opens Chrome maximized: 1440 by 765 on this laptop, about
  // 1366 by 633 on a 1366 by 768 one. A window that isn't maximized opens
  // about 1037 wide. Under 1000 wide the panel goes under the map.
  const sizes = [[1440, 765], [1366, 633], [1037, 739], [1037, 615], [1093, 480], [900, 700], [820, 560]];
  for (const [width, height] of sizes) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const m = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const inside = (a, b) => a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
      const view = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
      const panel = r(document.getElementById('fc-launch-panel'));
      const map = r(document.getElementById('fc-screens'));
      const controls = [...document.querySelectorAll('#fc-map-controls button, #fc-map-controls label')].filter((b) => b.getClientRects().length);
      const tops = new Set(controls.map((b) => Math.round(r(b).top / 4)));
      const names = [...document.querySelectorAll('.fc-phase-name')].filter((n) => n.getClientRects().length);
      const need = ['fcl-lat', 'fcl-lon', 'fcl-range', 'fcl-copy'].map((id) => r(document.getElementById(id)));
      return {
        w: innerWidth,
        h: innerHeight,
        nav: getComputedStyle(document.getElementById('nav')).display,
        consoleTop: Math.round(r(document.getElementById('fc-console')).top),
        side: panel.left >= map.right - 1,
        under: panel.top >= map.bottom - 1,
        panelW: Math.round(panel.width),
        mapW: Math.round(map.width),
        mapH: Math.round(map.height),
        controlsIn: controls.length > 0 && controls.every((b) => inside(r(b), map)),
        controlRows: tops.size,
        namesCut: names.filter((n) => n.scrollWidth > n.clientWidth + 1).length,
        names: names.length,
        inView: need.every((b) => b.height > 0 && inside(b, view) && inside(b, panel)),
        copyBottom: Math.round(need[3].bottom),
        scrollsSideways: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    const where = width >= 1000 ? m.side : m.under;
    check(`${width} by ${height}: the coordinates, the range and COPY COORDINATES are in view, the map's buttons are inside the map`,
      where && m.inView && m.controlsIn && m.controlRows === 1 && m.namesCut === 0 && m.mapH >= 180 && m.nav === 'none' && m.consoleTop === 0 && !m.scrollsSideways,
      `panel ${width >= 1000 ? 'beside' : 'under'} the map (${where}), map ${m.mapW} by ${m.mapH}, panel ${m.panelW} wide, COPY COORDINATES ends at ${m.copyBottom} of ${m.h} (all in view: ${m.inView}), ` +
      `${m.controlRows} row of map buttons (inside the map: ${m.controlsIn}), ${m.namesCut} of ${m.names} phase names cut, nav ${m.nav}`);
    await sleep(700);
    await shot(page, `p-${width}x${height}-landed`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: LAPTOP.width, height: LAPTOP.height, deviceScaleFactor: 1, mobile: false });
  // FLIGHT CONSOLE in the bar goes back to the landing, where the nav shows.
  await page.evaluate(() => window.fcLaunch.ctx.live.handlers.onClose({ lost: false }));
  await sleep(800);
  await noteLogs(page);
  await page.goto(server.url('/flight-console/launch.html'));
  await page.waitFor(() => document.body.dataset.fcScreen === 'landing', { timeout: 30000, message: 'the launch page\'s landing did not show' });
  check('the launch page\'s landing still has the site nav', await page.evaluate(() => getComputedStyle(document.getElementById('nav')).display !== 'none' && document.getElementById('nav').getBoundingClientRect().height > 40));
  const exceptions = page.exceptions();
  check('no exceptions at any size', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

async function partReplayAndNormal() {
  console.log('\n== A saved flight, and the normal page ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  openPages.add(page);

  const toEnd = async () => {
    await page.waitFor(() => Boolean(document.querySelector('#fc-timeline [role="slider"]')), { timeout: 30000, message: 'no timeline' });
    // End on the timeline seeks to the end of the flight (cdp.mjs's press()
    // has no End key, so the key event is sent from the page).
    await page.evaluate(() => {
      const slider = document.querySelector('#fc-timeline [role="slider"]');
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', code: 'End', bubbles: true, cancelable: true }));
    });
    await page.waitFor(() => document.getElementById('fc-console').dataset.state === 'recovery', { timeout: 15000, message: 'the replay did not reach the landing' });
    await sleep(500);
  };

  // A saved flight on the launch page: the panel stays and says it shows
  // the live flight. The HUD's OPEN IN MAPS follows the internet there too.
  await openLaunch(page, server, '/flight-console/launch.html?flight=komodo-sim-01');
  await toEnd();
  let hud = await hudRecovery(page);
  check('a saved flight on the launch page keeps Manta\'s name (it is the flight\'s own Manta)', /FROM MANTA$/.test(hud.distance ?? ''), hud.distance);
  check('the HUD hides OPEN IN MAPS there with the internet blocked', hud.linkHidden === true);
  const replay = await page.evaluate(() => ({
    shown: window.fcLaunch.parts.panel.status().panelShown,
    replay: window.fcLaunch.parts.panel.status().replay,
    note: getComputedStyle(document.querySelector('.fcl-replay-note')).display !== 'none',
  }));
  check('the panel stays during a saved flight and says it shows the live flight', replay.shown && replay.replay && replay.note, JSON.stringify(replay));
  await shot(page, 'h-1366-replay-launch');

  // The normal page: no panel, no launch mode, and the HUD as before.
  await page.goto(server.url('/flight-console/index.html?track'));
  await page.waitFor(() => window.fcStarted === true && document.body.dataset.fcScreen === 'console', { timeout: 30000, message: 'the normal page did not start' });
  await sleep(800);
  const normal = await page.evaluate(() => ({
    panel: Boolean(document.getElementById('fc-launch-panel')),
    hub: 'fcLaunch' in window,
    css: [...document.styleSheets].some((s) => (s.href ?? '').includes('flight-console-launch.css')),
    display: getComputedStyle(document.getElementById('fc-console')).display,
  }));
  check('the normal page has no launch panel and no launch mode', !normal.panel && !normal.hub && !normal.css && normal.display === 'flex', JSON.stringify(normal));
  // The launch page hides the site nav while its console is up. The normal page never does.
  const nav = await page.evaluate(() => {
    const el = document.getElementById('nav');
    return { display: getComputedStyle(el).display, height: Math.round(el.getBoundingClientRect().height), consoleTop: Math.round(document.getElementById('fc-console').getBoundingClientRect().top) };
  });
  check('the normal page keeps the site nav above its console', nav.display !== 'none' && nav.height === 64 && nav.consoleTop === 64, JSON.stringify(nav));
  await shot(page, 'i-1366-normal-track');
  await page.goto(server.url('/flight-console/index.html?flight=komodo-sim-01'));
  await toEnd();
  hud = await hudRecovery(page);
  check('the normal page\'s HUD still says FROM MANTA', /^[\d,.]+ (M|KM) FROM MANTA$/.test(hud.distance ?? ''), hud.distance);
  check('the normal page\'s OPEN IN MAPS shows as before, internet or not', hud.linkShown === true && /^https:\/\/www\.google\.com\/maps\//.test(hud.href), JSON.stringify(hud));
  await shot(page, 'i-1366-normal-replay');
  const exceptions = page.exceptions();
  check('no exceptions on the normal page', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
}

// Each part has its own Chrome (a fresh profile), closed when it ends. The
// log files its pages wrote are noted first.
async function run(name, part) {
  if (!args.only.includes(name)) return;
  try {
    await part();
  } finally {
    for (const page of openPages) await noteLogs(page);
    openPages.clear();
    while (browsers.length) {
      try { await browsers.pop().close(); } catch { /* already gone */ }
    }
  }
}

try {
  // A verbose server prints a line for every request, which is how the log
  // files of a killed page are found afterwards (noteServerLogs).
  server = await startServer({ port: args.port, verbose: true });
  await run('capture', partCapture);
  await run('landed', () => partLanded('blocked'));
  await run('landed', () => partLanded('open'));
  await run('settings', partNoSettings);
  await run('crash', partCrash);
  await run('packets', partPackets);
  await run('gaps', partGaps);
  await run('rockets', partRockets);
  await run('test', partTest);
  await run('tabs', partTabs);
  await run('layout', partLayout);
  await run('replay', partReplayAndNormal);
} catch (err) {
  console.error('\nThe test stopped early:', err?.stack ?? err);
  failed += 1;
} finally {
  for (const b of browsers) {
    try { await b.close(); } catch { /* already gone */ }
  }
  // The server first, so its last request lines are in, then the files.
  try { await server?.stop(); } catch { /* already gone */ }
  deleteMadeLogs();
  for (const dir of profiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held */ }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
