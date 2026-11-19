// map-names-browser.mjs: the browser checks for two things on the maps
// (js/views/map-view.js, map-labels.js and globe-view.js), in a real
// headless Chrome:
//   - RESET VIEW on the launch page's live screen. It shows there, and it
//     takes the 3D view back to the field's opening view and the 2D map
//     back to the ground station after the camera was moved far away,
//     first with nothing on the map, then with the test capture's board on
//     it. WHOLE FLIGHT stays hidden until there is a path, then frames it.
//     After WHOLE FLIGHT on the map and a trip to the 3D view, a drag of
//     the map is kept (the first view used to pull the map back).
//   - The ground station's name. On the launch page the dish label (3D and
//     2D) and the KEY say GROUND STATION. A saved flight with its own Manta
//     still says MANTA there, and the normal page says MANTA as before,
//     with the camera buttons only in a replay.
// It is not a node --test file (it needs Chrome), so run it by hand from
// the website folder:
//
//   node flight-console/test/map-names-browser.mjs
//   node flight-console/test/map-names-browser.mjs --port 8121 --out C:/some/folder
//
// The launch page parts run with the internet blocked. The normal page is
// checked with the internet blocked (the NO MAP panel) and open (the real
// maps). It prints one line per check, saves pictures in --out (look at
// them), deletes the flight logs its capture wrote, and ends with exit
// code 1 if any check failed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchChrome, sleep, ROOT } from '../../launch-mode/test/cdp.mjs';
import { distanceM } from '../js/geo.js';

const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i < 0 ? fallback : ARGS[i + 1];
};
const PORT = Number(opt('--port', '8121'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'fc-map-names')));
if (PORT === 8000) throw new Error('Port 8000 is the real server. Use a test port.');
fs.mkdirSync(OUT, { recursive: true });

const LOGS = path.join(ROOT, 'flight-logs');
const FIELD = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch-mode/field.json'), 'utf8')).center;
const WINDOW = { width: 1366, height: 768 };
const GPU = ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
// Far from the field: about 80 km north east.
const FAR = { lat: FIELD.lat + 0.5, lon: FIELD.lon + 0.7 };

const results = [];
const madeLogs = new Set();
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot(file);
  console.log(`      picture: ${file}`);
}

// ------------------------------------------------------------------
// Page helpers
// ------------------------------------------------------------------
const SEL = {
  satellite: '#fc-map-controls [aria-label="Map view"] button:nth-child(1)',
  three: '#fc-map-controls [aria-label="Map view"] button:nth-child(3)',
  whole: '#fc-map-controls [aria-label="Camera"] button:nth-child(1)',
  reset: '#fc-map-controls [aria-label="Camera"] button:nth-child(2)',
  key: '#fc-map-controls .fc-map-key-toggle',
};

// The map's controls and names as they are on screen right now.
const mapState = (page) => page.evaluate(() => {
  const seen = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const camera = document.querySelector('#fc-map-controls [aria-label="Camera"]');
  const [whole, reset] = camera ? [...camera.querySelectorAll('button')] : [];
  const counts = document.getElementById('fc-map')?.fcMapTest?.counts() ?? null;
  const legend = document.querySelector('.fc-map-legend');
  return {
    cameraShown: seen(camera),
    wholeShown: seen(whole),
    wholeHiddenAttr: whole ? whole.hidden : null,
    resetShown: seen(reset),
    wholeText: whole?.textContent ?? null,
    resetText: reset?.textContent ?? null,
    view: counts?.view ?? null,
    three: counts?.three ?? null,
    labels: counts?.labelsShown ?? [],
    keyOpen: Boolean(document.querySelector('#fc-map-controls .fc-map-key')?.open),
    legend: legend ? [...legend.querySelectorAll('.fc-legend-row')].filter((r) => !r.hidden).map((r) => r.textContent.trim()) : [],
    nomap: document.querySelector('.fc-nomap')?.innerText ?? null,
  };
});

const globeStatus = (page) => page.evaluate(() => window.fcLaunch.parts.globe?.status() ?? null);
const mapStatus = (page) => page.evaluate(() => window.fcLaunch.parts.map2d?.status() ?? null);
const stationOf = (page) => page.evaluate(() => window.fcLaunch.ctx.getStage()?.store.getGroundStation() ?? null);

async function globeStill(page, message) {
  await page.waitFor(() => {
    const s = window.fcLaunch.parts.globe?.status();
    return s && s.ready && !s.moving;
  }, { timeout: 20000, message });
  await sleep(400);
}
async function mapStill(page, message) {
  await page.waitFor(() => {
    const t = document.getElementById('fc-map')?.fcMapTest?.camera();
    return t && t.view === 'map' && !t.moving;
  }, { timeout: 20000, message });
  await sleep(400);
}
async function waitLabel(page, text, message) {
  try {
    await page.waitFor((want) => (document.getElementById('fc-map')?.fcMapTest?.counts().labelsShown ?? []).some((l) => l.includes(want)),
      { timeout: 10000, args: [text], message });
    return true;
  } catch {
    return false;
  }
}
async function toThree(page) {
  await page.click(SEL.three);
  await page.waitFor(() => document.getElementById('fc-map')?.fcMapTest?.counts().view === '3d', { timeout: 10000, message: 'the 3D view did not come back' });
  await globeStill(page, 'the 3D view did not settle');
}
async function toMap(page) {
  await page.click(SEL.satellite);
  await page.waitFor(() => window.fcLaunch.parts.map2d?.status().view === 'map', { timeout: 10000, message: 'the 2D map did not show' });
  await mapStill(page, 'the 2D map did not settle');
}
async function openKey(page, name) {
  if (!(await mapState(page)).keyOpen) await page.click(SEL.key);
  await sleep(500);
  const state = await mapState(page);
  await shot(page, name);
  await page.click(SEL.key);
  await sleep(200);
  return state.legend;
}
const near = (a, b) => (a && b ? distanceM(a.lat, a.lon, b.lat, b.lon) : Infinity);
// A real mouse drag across the middle of the map's free part.
async function drag(page, dx, dy) {
  const from = await page.evaluate(() => {
    const box = document.querySelector('#fc-map .fc-map-canvas').getBoundingClientRect();
    const free = document.getElementById('fc-map').fcMapTest.camera().free;
    return { x: box.left + (free.x0 + free.x1) / 2, y: box.top + (free.y0 + free.y1) / 2 };
  });
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  await mouse('mouseMoved', from.x, from.y, { button: 'none' });
  await mouse('mousePressed', from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 12; i++) {
    await mouse('mouseMoved', from.x + (dx * i) / 12, from.y + (dy * i) / 12, { buttons: 1 });
    await sleep(20);
  }
  await sleep(150);
  await mouse('mouseReleased', from.x + dx, from.y + dy, { clickCount: 1, buttons: 0 });
  await sleep(300);
}
const noteLogs = async (page) => {
  const s = await page.evaluate(() => window.fcLaunch?.parts?.log?.status() ?? null).catch(() => null);
  for (const l of s?.logs ?? []) if (l.server) madeLogs.add(l.server);
};

// RESET VIEW in each view after the camera was sent far away. want3d and
// want2d say where it should come back to: { lat, lon, withinM }.
async function resetBoth(page, tag, want3d, want2d) {
  await toThree(page);
  const moved = await page.evaluate((p) => window.fcLaunch.parts.globe.lookAt({ lat: p.lat, lon: p.lon, heightM: 20000 }), FAR);
  await globeStill(page, 'the 3D view did not stop after lookAt');
  const away = (await globeStatus(page)).lookingAt;
  check(`${tag}: the 3D view went far away`, moved === true && near(away, FIELD) > 50000, `looking at ${away.lat.toFixed(4)}, ${away.lon.toFixed(4)}, ${(near(away, FIELD) / 1000).toFixed(1)} km from the field`);
  const before = await mapState(page);
  check(`${tag}: RESET VIEW is on screen in 3D`, before.cameraShown && before.resetShown && before.resetText === 'RESET VIEW', JSON.stringify({ camera: before.cameraShown, reset: before.resetShown }));
  await page.click(SEL.reset);
  await sleep(300);
  await globeStill(page, 'the 3D view did not stop after RESET VIEW');
  const back = (await globeStatus(page)).lookingAt;
  const off3d = near(back, want3d);
  check(`${tag}: RESET VIEW took the 3D view back`, off3d <= want3d.withinM,
    `looking at ${back.lat.toFixed(5)}, ${back.lon.toFixed(5)} from ${Math.round(back.rangeM)} m, pitch ${back.pitchDeg.toFixed(1)}, heading ${back.headingDeg.toFixed(1)}; ${off3d.toFixed(1)} m from where it should be (${want3d.label})`);
  await shot(page, `${tag}-3d-after-reset`);

  await toMap(page);
  const ok = await page.evaluate((p) => window.fcLaunch.parts.map2d.setView(p.lat, p.lon, 9), FAR);
  await mapStill(page, 'the map did not stop after setView');
  const away2 = (await mapStatus(page)).center;
  check(`${tag}: the 2D map went far away`, ok === true && near(away2, FIELD) > 50000, `center ${away2.lat.toFixed(4)}, ${away2.lon.toFixed(4)}`);
  await page.click(SEL.reset);
  await sleep(400);
  await mapStill(page, 'the map did not stop after RESET VIEW');
  const s2 = await mapStatus(page);
  const off2d = near(s2.center, want2d);
  check(`${tag}: RESET VIEW took the 2D map back`, off2d <= want2d.withinM,
    `center ${s2.center.lat.toFixed(5)}, ${s2.center.lon.toFixed(5)} at zoom ${s2.zoom}; ${off2d.toFixed(1)} m from where it should be (${want2d.label})`);
  await shot(page, `${tag}-2d-after-reset`);
  return { back, map: s2 };
}

// ------------------------------------------------------------------
// The launch page
// ------------------------------------------------------------------
async function launchPage(server) {
  console.log('\n== The launch page, live, internet blocked ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: WINDOW, args: GPU });
  try {
    const page = await browser.newPage();
    await page.goto(server.url('/flight-console/launch.html?track'));
    await page.waitFor(() => window.fcStarted === true && window.fcLaunch?.parts?.capture && window.fcLaunch?.parts?.log, { timeout: 40000, message: 'the launch page did not start' });
    await page.waitFor(() => window.fcLaunch.parts.globe?.status().ready, { timeout: 40000, message: 'the 3D view never got its first picture' });
    await globeStill(page, 'the 3D view did not settle at the start');
    await noteLogs(page);
    const gs = await stationOf(page);
    check('the ground station is the launch page\'s own (typed or the field center)', gs?.source === 'launch-mode', JSON.stringify(gs));
    const home = (await globeStatus(page)).lookingAt;
    console.log(`      the opening view looks at ${home.lat.toFixed(5)}, ${home.lon.toFixed(5)} from ${Math.round(home.rangeM)} m`);

    // Nothing on the map yet.
    let st = await mapState(page);
    check('live, nothing on the map: RESET VIEW shows, WHOLE FLIGHT waits', st.cameraShown && st.resetShown && !st.wholeShown && st.wholeHiddenAttr === true, JSON.stringify({ camera: st.cameraShown, reset: st.resetShown, whole: st.wholeShown }));
    const label3d = await waitLabel(page, 'GROUND STATION', '');
    st = await mapState(page);
    check('3D: the dish label reads GROUND STATION', label3d && !st.labels.some((l) => l.includes('MANTA')), JSON.stringify(st.labels));
    await shot(page, 'a-launch-live-3d');
    await resetBoth(page, 'a-empty',
      { ...home, withinM: 5, label: 'the field opening view' },
      { lat: gs.lat, lon: gs.lon, withinM: 5, label: 'the ground station' });
    const label2d = await waitLabel(page, 'GROUND STATION', '');
    st = await mapState(page);
    check('2D: the dish label reads GROUND STATION', label2d && !st.labels.some((l) => l.includes('MANTA')), JSON.stringify(st.labels));
    const legend = await openKey(page, 'a-launch-live-2d-key');
    check('2D: the KEY says GROUND STATION and RADIO LINK TO GROUND STATION', legend.includes('GROUND STATION') && legend.includes('RADIO LINK TO GROUND STATION') && !legend.some((r) => r.includes('MANTA')), JSON.stringify(legend));

    // The capture through the live path.
    console.log('      playing the capture at 20x, moved to the field...');
    const played = await page.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 20, shift: 'field' }));
    await noteLogs(page);
    check('the capture played to its end', played?.ok !== false && played?.sent === played?.total, JSON.stringify(played));
    await sleep(1500);
    // A recording that stops can open the name box. It is saved, so it
    // goes away.
    if (await page.evaluate(() => Boolean(document.querySelector('dialog.fc-dialog')?.open))) {
      await page.click('dialog.fc-dialog button[type="submit"]');
      await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
      console.log('      (the name box opened at the end and was saved)');
    }
    await noteLogs(page);
    const rocket = await page.evaluate(() => {
      const r = window.fcLaunch.ctx.getStage().store.getFocused();
      return r ? { samples: r.samples.length, pad: r.padPosition ?? null, fix: r.lastGoodFix ? { lat: r.lastGoodFix.lat, lon: r.lastGoodFix.lon } : null } : null;
    });
    check('the board is on the map at the field', rocket?.fix && near(rocket.fix, FIELD) < 200, JSON.stringify(rocket));
    await toMap(page);
    st = await mapState(page);
    check('2D, board on the map: WHOLE FLIGHT and RESET VIEW both show', st.cameraShown && st.wholeShown && st.resetShown, JSON.stringify({ whole: st.wholeShown, reset: st.resetShown }));
    await waitLabel(page, 'GROUND STATION', '');
    st = await mapState(page);
    check('2D after the capture: the dish label reads GROUND STATION', st.labels.some((l) => l.includes('GROUND STATION')) && !st.labels.some((l) => l.includes('MANTA')), JSON.stringify(st.labels));
    await shot(page, 'b-launch-capture-2d');
    const legend2 = await openKey(page, 'b-launch-capture-2d-key');
    check('2D after the capture: the KEY still says GROUND STATION', legend2.includes('GROUND STATION') && legend2.includes('RADIO LINK TO GROUND STATION'), JSON.stringify(legend2));
    // WHOLE FLIGHT live, in the 2D map.
    await page.click(SEL.whole);
    await sleep(400);
    await mapStill(page, 'the map did not stop after WHOLE FLIGHT');
    const fit2 = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.fit());
    const inside2 = fit2.points.every((p) => p.x >= fit2.insets.left - 2 && p.x <= fit2.width - fit2.insets.right + 2 && p.y >= fit2.insets.top - 2 && p.y <= fit2.height - fit2.insets.bottom + 2);
    check('2D live: WHOLE FLIGHT frames every point in the free part of the view', inside2 && fit2.points.length > 2, `${fit2.points.length} points`);
    await shot(page, 'b-launch-capture-2d-whole');

    await toThree(page);
    await waitLabel(page, 'GROUND STATION', '');
    st = await mapState(page);
    check('3D after the capture: the dish label reads GROUND STATION', st.labels.some((l) => l.includes('GROUND STATION')) && !st.labels.some((l) => l.includes('MANTA')), JSON.stringify(st.labels));
    await shot(page, 'b-launch-capture-3d');
    await page.click(SEL.whole);
    await sleep(400);
    await globeStill(page, 'the 3D view did not stop after WHOLE FLIGHT');
    const fit3 = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.fit());
    const pts = fit3.points.filter(Boolean);
    const inside3 = pts.every((p) => p.x >= fit3.insets.left - 4 && p.x <= fit3.width - fit3.insets.right + 4 && p.y >= fit3.insets.top - 4 && p.y <= fit3.height - fit3.insets.bottom + 4);
    check('3D live: WHOLE FLIGHT frames every point in the free part of the view', inside3 && pts.length > 2, `${pts.length} points, camera ${(await globeStatus(page)).cameraMode}`);
    await shot(page, 'b-launch-capture-3d-whole');

    // RESET VIEW with the board on the map: what a replay does, which here
    // is the launch point at the field.
    const pad = rocket?.pad ?? rocket?.fix;
    await resetBoth(page, 'b-board',
      { lat: pad.lat, lon: pad.lon, withinM: 300, label: 'above the launch point' },
      { lat: FIELD.lat, lon: FIELD.lon, withinM: 1500, label: 'the first view of the pad, the board and the dish' });

    // WHOLE FLIGHT on the map, a trip to the 3D view and back, then a drag:
    // the map stays where the drag left it.
    await page.click(SEL.whole);
    await sleep(400);
    await mapStill(page, 'the map did not stop after WHOLE FLIGHT');
    await toThree(page);
    await toMap(page);
    const cam0 = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.camera());
    await drag(page, -300, 0);
    await mapStill(page, 'the map did not stop after the drag');
    const cam1 = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.camera());
    await sleep(1500);
    const cam2 = await page.evaluate(() => document.getElementById('fc-map').fcMapTest.camera());
    const dragged = cam1.centerPx[0] - cam0.centerPx[0];
    const after = cam2.centerPx[0] - cam1.centerPx[0];
    check('2D after WHOLE FLIGHT and a trip to 3D: a drag is kept', dragged > 200 && Math.abs(after) < 2 && cam2.zoom === cam1.zoom,
      `the drag moved the map ${Math.round(dragged)} px, then it moved ${Math.round(after)} px more by itself`);
    await toThree(page);

    // The ground station typed in somewhere else: the dish moves, and the
    // name stays GROUND STATION.
    const typed = { lat: FIELD.lat + 0.004, lon: FIELD.lon + 0.004 };
    await page.type('#fcl-gs-lat', String(typed.lat), { clear: true });
    await page.type('#fcl-gs-lon', String(typed.lon), { clear: true });
    await page.click('#fcl-gs-set');
    await sleep(800);
    const gs2 = await stationOf(page);
    await waitLabel(page, 'GROUND STATION', '');
    st = await mapState(page);
    check('a typed ground station is still named GROUND STATION', gs2?.source === 'launch-mode' && Math.abs(gs2.lat - typed.lat) < 1e-9 && st.labels.some((l) => l.includes('GROUND STATION')), `${JSON.stringify(gs2)} labels ${JSON.stringify(st.labels)}`);
    const exceptions = page.exceptions();
    check('launch page: no exceptions', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 400));
    // Launch mode asks the internet only through its own online check, and
    // for the online imagery when SATELLITE is pressed on the map. With the
    // internet blocked both fail at once.
    const external = page.externalRequests();
    const known = external.every((r) => r.url === 'https://www.google.com/generate_204' || /^https:\/\/[a-z-]+\.arcgis\.com\//.test(r.url));
    check('launch page: only the online check and the online imagery were tried', known, `${external.length} tried: ${[...new Set(external.map((r) => new URL(r.url).host))].join(', ') || 'none'}`);
    await noteLogs(page);
  } finally {
    await browser.close();
  }
}

// A saved flight with its own Manta, on the launch page.
async function launchSaved(server) {
  console.log('\n== A saved flight with its own Manta, on the launch page ==');
  const browser = await launchChrome({ network: 'blocked', windowSize: WINDOW, args: GPU });
  try {
    const page = await browser.newPage();
    await page.goto(server.url('/flight-console/launch.html?flight=komodo-sim-01'));
    await page.waitFor(() => window.fcStarted === true && window.fcLaunch?.parts?.globe?.status().ready, { timeout: 40000, message: 'the saved flight did not open' });
    await page.waitFor(() => document.getElementById('fc-map')?.fcMapTest?.counts().globe?.rockets > 0, { timeout: 30000, message: 'the flight was not drawn' });
    await globeStill(page, 'the 3D view did not settle');
    await noteLogs(page);
    const gs = await stationOf(page);
    await waitLabel(page, 'MANTA', '');
    let st = await mapState(page);
    check('saved flight, 3D: the dish label reads MANTA', gs?.source !== 'launch-mode' && st.labels.some((l) => l.includes('MANTA')) && !st.labels.some((l) => l.includes('GROUND STATION')), `${JSON.stringify(gs)} ${JSON.stringify(st.labels)}`);
    check('saved flight: both camera buttons show', st.cameraShown && st.wholeShown && st.resetShown);
    await shot(page, 'c-launch-saved-3d');
    await toMap(page);
    await waitLabel(page, 'MANTA', '');
    st = await mapState(page);
    check('saved flight, 2D: the dish label reads MANTA', st.labels.some((l) => l.includes('MANTA')) && !st.labels.some((l) => l.includes('GROUND STATION')), JSON.stringify(st.labels));
    const legend = await openKey(page, 'c-launch-saved-2d-key');
    check('saved flight: the KEY says MANTA and RADIO LINK TO MANTA', legend.includes('MANTA') && legend.includes('RADIO LINK TO MANTA'), JSON.stringify(legend));
    check('saved flight on the launch page: no exceptions', page.exceptions().length === 0, JSON.stringify(page.exceptions()).slice(0, 400));
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// The normal page
// ------------------------------------------------------------------
async function normalPage(server, network) {
  console.log(`\n== The normal page, internet ${network} ==`);
  const browser = await launchChrome({ network, windowSize: WINDOW, args: GPU });
  try {
    const page = await browser.newPage();
    await page.goto(server.url('/flight-console/index.html?track&flight=gps-board-sim-01'));
    await page.waitFor(() => window.fcStarted === true && document.getElementById('fc-map')?.fcMapTest, { timeout: 40000, message: 'the normal page did not start' });
    await page.waitFor(() => Boolean(document.querySelector('#fc-timeline [role="slider"]')), { timeout: 30000, message: 'the saved flight did not open' });
    let st = await mapState(page);
    const launchHub = await page.evaluate(() => 'fcLaunch' in window);
    check(`normal (${network}), replay: both camera buttons show, and no launch mode`, st.cameraShown && st.wholeShown && st.resetShown && !launchHub, JSON.stringify({ camera: st.cameraShown, whole: st.wholeShown, reset: st.resetShown, launchHub }));
    if (network === 'blocked') {
      // No Leaflet and no Cesium: the NO MAP panel.
      await page.waitFor(() => Boolean(document.querySelector('.fc-nomap')), { timeout: 20000, message: 'no NO MAP panel' }).catch(() => {});
      await page.click(SEL.satellite).catch(() => {});
      await sleep(1500);
      st = await mapState(page);
      check('normal, NO MAP panel: "from Manta" and "Manta at ... (demo position)" as before',
        /from Manta/.test(st.nomap ?? '') && /Manta at -?[\d.]+, -?[\d.]+ \(demo position\)/.test(st.nomap ?? '') && !/ground station/i.test(st.nomap ?? ''), JSON.stringify(st.nomap));
      await shot(page, `d-normal-${network}-nomap`);
      const legend = await openKey(page, `d-normal-${network}-key`);
      check('normal, NO MAP panel: the KEY says MANTA as before', legend.some((r) => r.startsWith('MANTA')) && legend.includes('RADIO LINK TO MANTA'), JSON.stringify(legend));
    } else {
      await page.waitFor(() => document.getElementById('fc-map').fcMapTest.counts().three === 'ready' || document.getElementById('fc-map').fcMapTest.counts().three === 'failed', { timeout: 40000, message: 'the 3D view neither loaded nor failed' }).catch(() => {});
      await sleep(3000);
      st = await mapState(page);
      if (st.three === 'ready') {
        await waitLabel(page, 'MANTA', '');
        st = await mapState(page);
        check('normal, 3D: the dish label reads MANTA', st.labels.some((l) => l.includes('MANTA')) && !st.labels.some((l) => l.includes('GROUND STATION')), JSON.stringify(st.labels));
      } else {
        console.log(`      (the 3D view is ${st.three} on this origin, so its label was not checked)`);
      }
      await shot(page, `d-normal-${network}-3d`);
      await page.click(SEL.satellite);
      await page.waitFor(() => document.getElementById('fc-map').fcMapTest.counts().view === 'map', { timeout: 10000, message: 'the 2D map did not show' });
      await sleep(2500);
      const label = await waitLabel(page, 'MANTA', '');
      st = await mapState(page);
      if (st.nomap) console.log('      (the 2D map fell back to the NO MAP panel)');
      else check('normal, 2D: the dish label reads MANTA', label && !st.labels.some((l) => l.includes('GROUND STATION')), JSON.stringify(st.labels));
      const legend = await openKey(page, `d-normal-${network}-2d-key`);
      check('normal, 2D: the KEY says MANTA, DEMO POSITION and RADIO LINK TO MANTA', legend.includes('MANTA, DEMO POSITION') && legend.includes('RADIO LINK TO MANTA'), JSON.stringify(legend));
      await shot(page, `d-normal-${network}-2d`);
    }
    // Live on the normal page: no camera buttons, as before.
    await page.goto(server.url('/flight-console/index.html?track'));
    await page.waitFor(() => window.fcStarted === true && document.body.dataset.fcScreen === 'console' && document.getElementById('fc-map')?.fcMapTest, { timeout: 30000, message: 'the normal live page did not start' });
    await sleep(1500);
    st = await mapState(page);
    check(`normal (${network}), live: no camera buttons, WHOLE FLIGHT itself not hidden (as before)`, !st.cameraShown && !st.resetShown && st.wholeHiddenAttr === false, JSON.stringify({ camera: st.cameraShown, reset: st.resetShown, wholeHiddenAttr: st.wholeHiddenAttr }));
    await shot(page, `d-normal-${network}-live`);
    check(`normal (${network}): no exceptions`, page.exceptions().length === 0, JSON.stringify(page.exceptions()).slice(0, 400));
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------
const server = await startServer({ port: PORT });
let crashed = null;
try {
  for (const part of [() => launchPage(server), () => launchSaved(server), () => normalPage(server, 'blocked'), () => normalPage(server, 'open')]) {
    try {
      await part();
    } catch (err) {
      crashed = crashed ?? err;
      check('the part ran to its end', false, err?.message ?? String(err));
    }
  }
} finally {
  await server.stop();
  for (const name of madeLogs) {
    try {
      fs.rmSync(path.join(LOGS, name));
      console.log(`      deleted flight-logs/${name}`);
    } catch { /* already gone */ }
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
