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
// It is not one of the Node tests (its name doesn't end in .test.mjs),
// because it needs Chrome. Run it from the repo:
//   node flight-console/test/launch-panel-browser.mjs
//   node flight-console/test/launch-panel-browser.mjs --port 8107 --shots C:/some/folder
// --shots saves screenshots there (look at them: a check that only reads
// numbers can pass on a broken picture). --fast plays the capture at 20
// times real speed. --manual feeds it through the handlers by hand.
//
// Exit code 0 when every check passed, 1 when one failed, 2 when the test
// itself couldn't run. Uses launch-mode/test/cdp.mjs, nothing to install.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchChrome, sleep } from '../../launch-mode/test/cdp.mjs';
import { destinationPoint } from '../js/geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ------------------------------------------------------------------
// Options
// ------------------------------------------------------------------
const args = { port: 8107, shots: null, fast: false, manual: false };
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--port') args.port = Number(process.argv[++i]);
  else if (name === '--shots') args.shots = process.argv[++i];
  else if (name === '--fast') args.fast = true;
  else if (name === '--manual') args.manual = true;
  else {
    console.error(`I don't know the option ${name}`);
    process.exit(2);
  }
}
if (!Number.isInteger(args.port) || args.port === 8000) {
  console.error('--port needs a test port. 8000 is the real one.');
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
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel), { timeout: 40000, message: 'the panel did not come back after the reload' });
  await sleep(800);
  st = await status(page);
  check('the typed ground station is remembered after a reload', st.groundStation?.lat === typed.lat && st.groundStation?.lon === typed.lon && st.groundStation?.typed === true);
  check('the flight store starts from it after the reload', await page.evaluate((p) => {
    const gs = window.fcLaunch.ctx.liveStore('flight').getGroundStation();
    return gs?.lat === p.lat && gs?.lon === p.lon;
  }, typed));
  check('the saved fix shows after the reload', st.fix?.lat === WANT.lat && st.fix?.lon === WANT.lon && st.fix?.altM === WANT.altM, JSON.stringify(st.fix));
  check('it is marked as saved before the reload', st.fix?.restored === true && st.fix?.old === true && st.fix?.why === 'reload' &&
    /^SAVED FIX, FROM \d:\d\d AGO$/.test(await text(page, '#fcl-fix-state')), await text(page, '#fcl-fix-state'));
  const realAge = await page.evaluate((ms) => (Date.now() - ms) / 1000, fixBefore.wallMs);
  check('with its real age', st.fix?.wallMs === fixBefore.wallMs && Math.abs(st.fix.ageS - realAge) < 1.5 && st.fix.ageS > 9, `${st.fix?.ageS?.toFixed(1)} s, real ${realAge.toFixed(1)} s`);
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
  await page.reload();
  await page.waitFor(() => Boolean(window.fcLaunch?.parts?.panel), { timeout: 40000 });
  st = await status(page);
  check('the field center is still in use after a reload', st.groundStation?.typed === false && st.groundStation?.lat === FIELD.lat);

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

async function partReplayAndNormal() {
  console.log('\n== A saved flight, and the normal page ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: LAPTOP, args: CHROME_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();

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

// Each part has its own Chrome (a fresh profile), closed when it ends.
async function run(part) {
  try {
    await part();
  } finally {
    while (browsers.length) {
      try { await browsers.pop().close(); } catch { /* already gone */ }
    }
  }
}

try {
  server = await startServer({ port: args.port });
  await run(partCapture);
  await run(() => partLanded('blocked'));
  await run(() => partLanded('open'));
  await run(partNoSettings);
  await run(partReplayAndNormal);
} catch (err) {
  console.error('\nThe test stopped early:', err?.stack ?? err);
  failed += 1;
} finally {
  for (const b of browsers) {
    try { await b.close(); } catch { /* already gone */ }
  }
  try { await server?.stop(); } catch { /* already gone */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
