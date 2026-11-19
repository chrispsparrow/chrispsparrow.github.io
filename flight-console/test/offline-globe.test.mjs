// Tests for js/launch/offline-globe.js: the launch page's 3D ground. Which
// saved layers get made (a download that hasn't finished included), the
// Esri layer's address and which of its tiles it skips, the opening view,
// the guard that counts tiles and keeps missing ones quiet, and when the
// Esri layer goes on (with a stand-in for Cesium, so no page is needed).
// The manifest here is built the way launch-mode/download_tiles.py builds
// it, for the CRMRC field's box.
// Run with: node --test "flight-console/test/*.test.mjs"

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  savedLayerPlan, onlineLayerPlan, openingView, guardRequests, tileInside, createGlobeGround,
  ONLINE_MAX_LEVEL, OPENING_RANGE_M, OPENING_PITCH_DEG, OPENING_HEADING_DEG,
} from '../js/launch/offline-globe.js';

const CENTER = { lat: 44.825278, lon: -73.171727 };

// The downloader's tile math, in JavaScript.
function boxDegrees(center, halfKm) {
  const dlat = halfKm / 111.32;
  const dlon = halfKm / (111.32 * Math.cos(center.lat * Math.PI / 180));
  return { south: center.lat - dlat, west: center.lon - dlon, north: center.lat + dlat, east: center.lon + dlon };
}
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return [x, y];
}
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

// One level of the manifest. saved is how many of its tiles are on disk
// (all of them unless given).
function level(z, halfKm, { missing = [], saved } = {}) {
  const box = boxDegrees(CENTER, halfKm);
  const [x0, y0] = tileXY(box.north, box.west, z);
  const [x1, y1] = tileXY(box.south, box.east, z);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  return {
    z, x0, x1, y0, y1, halfKm, missing, box, count,
    saved: saved ?? count - missing.length,
    covered: { south: tileLat(y1 + 1, z), west: tileLon(x0, z), north: tileLat(y0, z), east: tileLon(x1 + 1, z) },
  };
}

// The whole field: zooms 0 to 16 for the 15 km box, 17 for 5 km, 18 for 2 km.
// `per` gives a zoom its own options, like { 16: { saved: 0 } }.
function manifest(per = {}) {
  const levels = [];
  for (let z = 0; z <= 16; z++) levels.push(level(z, 15, per[z]));
  levels.push(level(17, 5, per[17]));
  levels.push(level(18, 2, per[18]));
  return { version: 1, tileUrl: '{z}/{x}/{y}.jpg', credit: 'USGS', complete: true, center: CENTER, levels };
}

const settings = (m = manifest()) => ({ field: { center: CENTER }, manifest: m, tilesUrl: 'http://localhost:8000/offline-maps/crmrc/' });

// A stand-in for a Cesium imagery provider: requestImage answers from
// `answers` (a function of x, y and level), and errorEvent counts its
// listeners.
function fakeProvider(answer) {
  const listeners = [];
  return {
    asked: [],
    listeners,
    errorEvent: { addEventListener: (fn) => listeners.push(fn) },
    requestImage(x, y, lv, request) {
      this.asked.push(`${lv}/${x}/${y}`);
      return answer(x, y, lv, request);
    },
  };
}

// Lets every promise handler that is ready to run, run.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('nothing saved: no saved layers, and no tile is worth asking for', () => {
  for (const s of [null, { manifest: null, tilesUrl: 'x/' }, { manifest: { levels: [] }, tilesUrl: 'x/' }]) {
    const plan = savedLayerPlan(s);
    assert.deepEqual(plan.layers, []);
    assert.equal(plan.offline, null);
    assert.equal(plan.allow(0, 0, 0), false);
  }
});

test('a finished download: three layers, far to near, each inside the one before', () => {
  const plan = savedLayerPlan(settings());
  assert.deepEqual(plan.layers.map((l) => l.maxLevel), [16, 17, 18]);
  for (const layer of plan.layers) {
    assert.equal(layer.url, 'http://localhost:8000/offline-maps/crmrc/{z}/{x}/{y}.jpg');
    assert.equal(layer.credit, 'USGS');
    assert.ok(layer.rect.south < CENTER.lat && layer.rect.north > CENTER.lat);
    assert.ok(layer.rect.west < CENTER.lon && layer.rect.east > CENTER.lon);
  }
  for (let i = 1; i < plan.layers.length; i++) {
    const outer = plan.layers[i - 1].rect;
    const inner = plan.layers[i].rect;
    assert.ok(inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east);
  }
  // The field's own tile is worth asking for at every zoom.
  for (let z = 0; z <= 18; z++) {
    const [x, y] = tileXY(CENTER.lat, CENTER.lon, z);
    assert.ok(plan.allow(z, x, y), `zoom ${z}`);
  }
  // A tile outside the box isn't, nor one closer than anything saved.
  assert.equal(plan.allow(16, 0, 0), false);
  const [x19, y19] = tileXY(CENTER.lat, CENTER.lon, 19);
  assert.equal(plan.allow(19, x19, y19), false);
});

test('a zoom with nothing saved yet is never asked for, and its layer stops at the zoom before', () => {
  // The download as it stood while this was written: 16 not started.
  const plan = savedLayerPlan(settings(manifest({ 16: { saved: 0 } })));
  assert.deepEqual(plan.layers.map((l) => l.maxLevel), [15, 17, 18]);
  const [x16, y16] = tileXY(CENTER.lat, CENTER.lon, 16);
  assert.equal(plan.allow(16, x16, y16), false);
  const [x15, y15] = tileXY(CENTER.lat, CENTER.lon, 15);
  assert.ok(plan.allow(15, x15, y15));
  const [x17, y17] = tileXY(CENTER.lat, CENTER.lon, 17);
  assert.ok(plan.allow(17, x17, y17));
});

test('a group whose own zoom has nothing saved adds no layer', () => {
  // 16 and 17 not started: the 5 km group has nothing the 15 km one lacks.
  const plan = savedLayerPlan(settings(manifest({ 16: { saved: 0 }, 17: { saved: 0 } })));
  assert.deepEqual(plan.layers.map((l) => l.maxLevel), [15, 18]);
  // The 18 layer covers the inner 2 km only.
  const inner = plan.layers[1].rect;
  assert.ok((inner.north - inner.south) * 111.32 < 5);
  // Only the far zooms saved: one layer.
  const far = savedLayerPlan(settings(manifest({ 16: { saved: 0 }, 17: { saved: 0 }, 18: { saved: 0 } })));
  assert.deepEqual(far.layers.map((l) => l.maxLevel), [15]);
});

test('a tile the manifest lists as missing is never asked for', () => {
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 17);
  const plan = savedLayerPlan(settings(manifest({ 17: { missing: [[x, y]] } })));
  assert.deepEqual(plan.layers.map((l) => l.maxLevel), [16, 17, 18]);
  assert.equal(plan.allow(17, x, y), false);
  assert.ok(plan.allow(17, x + 1, y));
});

test('the Esri layer: the key goes into the address, and Cesium fills in the rest', () => {
  const config = {
    ESRI_API_KEY: 'a key/with+signs',
    SATELLITE_URL: 'https://example.test/tile/{z}/{y}/{x}?token={key}',
    SATELLITE_ATTRIBUTION: 'Source: Esri',
    ESRI_POWERED_BY: 'Powered by Esri',
  };
  const plan = onlineLayerPlan(config);
  assert.equal(plan.url, 'https://example.test/tile/{z}/{y}/{x}?token=a%20key%2Fwith%2Bsigns');
  assert.equal(plan.maxLevel, ONLINE_MAX_LEVEL);
  assert.equal(plan.credit, 'Source: Esri');
  assert.equal(plan.poweredBy, 'Powered by Esri');
  assert.equal(onlineLayerPlan({ ...config, ESRI_API_KEY: '' }), null);
  assert.equal(onlineLayerPlan(null), null);
});

test('Esri is only asked for tiles that reach outside the saved box', () => {
  // The Esri layer turns down every tile tileInside() says is wholly
  // inside the saved map's outer edge, the first saved layer's rectangle.
  const box = savedLayerPlan(settings()).layers[0].rect;
  for (const z of [12, 14, 16, 17, 18]) {
    const [x, y] = tileXY(CENTER.lat, CENTER.lon, z);
    assert.ok(tileInside(z, x, y, box), `the field's own tile at zoom ${z} is hidden under the saved map`);
  }
  // A far zoom's tile is bigger than the box, so part of it shows Esri.
  for (const z of [0, 5, 9]) {
    const [x, y] = tileXY(CENTER.lat, CENTER.lon, z);
    assert.equal(tileInside(z, x, y, box), false, `zoom ${z}`);
  }
  // The box's own edge tiles reach a hair past its edge, and tiles 20 km
  // out are outside it.
  const z16 = manifest().levels.find((lv) => lv.z === 16);
  assert.equal(tileInside(16, z16.x0, z16.y0, box), false);
  assert.equal(tileInside(16, z16.x0 + 1, z16.y0 + 1, box), true);
  const [fx, fy] = tileXY(CENTER.lat + 0.2, CENTER.lon, 16);
  assert.equal(tileInside(16, fx, fy, box), false);
  // Nothing saved: no box, so every tile is asked for.
  assert.equal(tileInside(16, 1, 1, null), false);
});

test('the opening view is the field, or the ground station when the field is unknown', () => {
  const view = openingView(settings(), { lat: 1, lon: 2 });
  assert.deepEqual(view, { lat: CENTER.lat, lon: CENTER.lon, rangeM: OPENING_RANGE_M, pitchDeg: OPENING_PITCH_DEG, headingDeg: OPENING_HEADING_DEG });
  assert.ok(OPENING_PITCH_DEG < 0, 'the camera looks down');
  // field.json didn't load: the typed-in ground station.
  assert.deepEqual(openingView(null, { lat: 44.8, lon: -73.2 }).lat, 44.8);
  assert.equal(openingView(null, null), null);
  assert.equal(openingView({ field: { center: { lat: 200, lon: 0 } } }, null), null);
});

test('the guard counts tiles that load and tiles that fail', async () => {
  const counts = { loaded: 0, failed: 0, skipped: 0, pending: 0 };
  let settled = 0;
  const provider = fakeProvider((x) => (x === 1 ? Promise.resolve('image') : Promise.reject(new Error('404'))));
  guardRequests(provider, { counts, onSettle: () => { settled += 1; } });
  // Listening to errorEvent is what keeps Cesium from logging each failure.
  assert.equal(provider.listeners.length, 1);
  const ok = provider.requestImage(1, 0, 3);
  const bad = provider.requestImage(2, 0, 3);
  assert.equal(counts.pending, 2);
  assert.equal(await ok, 'image');
  await assert.rejects(bad, /404/);
  await settle();
  assert.deepEqual(counts, { loaded: 1, failed: 1, skipped: 0, pending: 0 });
  assert.equal(settled, 2);
});

test('the guard turns a missing tile down without asking, and nothing is left unhandled', async () => {
  const counts = { loaded: 0, failed: 0, skipped: 0, pending: 0 };
  let settled = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const provider = fakeProvider(() => Promise.resolve('image'));
    guardRequests(provider, { counts, allow: (lv) => lv !== 16, onSettle: () => { settled += 1; } });
    const turnedDown = provider.requestImage(5, 6, 16);
    // Cesium attaches its own handlers to what comes back. Here nothing
    // does, to prove the guard's own handling is enough.
    await settle();
    await settle();
    assert.deepEqual(provider.asked, [], 'the provider was never asked');
    assert.deepEqual(counts, { loaded: 0, failed: 0, skipped: 1, pending: 0 });
    assert.equal(settled, 1);
    await assert.rejects(turnedDown, /not asked for/);
    assert.equal(await provider.requestImage(5, 6, 15), 'image');
    assert.deepEqual(provider.asked, ['15/5/6']);
  } finally {
    await settle();
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('the guard passes on "ask again later", and a request Cesium dropped is not a failure', async () => {
  const counts = { loaded: 0, failed: 0, skipped: 0, pending: 0 };
  const CANCELLED = 5;
  const provider = fakeProvider((x, y, lv, request) => {
    if (x === 0) return undefined; // too many requests on their way
    request.state = CANCELLED;
    return Promise.reject(new Error('cancelled'));
  });
  guardRequests(provider, { counts, isCancelled: (request) => request?.state === CANCELLED });
  assert.equal(provider.requestImage(0, 0, 2, {}), undefined);
  assert.equal(counts.pending, 0);
  await assert.rejects(provider.requestImage(1, 0, 2, {}), /cancelled/);
  await settle();
  assert.deepEqual(counts, { loaded: 0, failed: 0, skipped: 0, pending: 0 });
});

// ------------------------------------------------------------------
// createGlobeGround, on a stand-in for Cesium and its viewer
// ------------------------------------------------------------------

// Just enough of Cesium for createGlobeGround: providers keep their
// options, and the viewer's layer list is a plain array.
// net.down makes every tile fail, like a connection that dropped.
function fakeCesium(net = { down: false }) {
  class Provider {
    constructor(options) {
      Object.assign(this, options);
      this.errorEvent = { addEventListener() {} };
    }

    requestImage() { return net.down ? Promise.reject(new Error('offline')) : Promise.resolve('image'); }
  }
  return {
    RequestState: { CANCELLED: 5 },
    SingleTileImageryProvider: class extends Provider { get plain() { return true; } },
    UrlTemplateImageryProvider: Provider,
    WebMercatorTilingScheme: class {},
    Rectangle: { fromDegrees: (west, south, east, north) => ({ west, south, east, north }) },
    Credit: class { constructor(html) { this.html = html; } },
  };
}

function fakeViewer() {
  const list = [];
  const credits = new Set();
  return {
    list,
    credits,
    imageryLayers: {
      addImageryProvider(provider, index = list.length) {
        const layer = { provider };
        list.splice(index, 0, layer);
        return layer;
      },
      remove(layer) {
        const at = list.indexOf(layer);
        if (at >= 0) list.splice(at, 1);
      },
    },
    creditDisplay: {
      addStaticCredit: (credit) => credits.add(credit),
      removeStaticCredit: (credit) => credits.delete(credit),
    },
  };
}

// A stand-in for hub.online: get(), onChange(fn), and set() for the test.
function fakeOnline(start) {
  let state = start;
  const fns = new Set();
  return {
    get: () => state,
    onChange: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    set(next) { state = next; for (const fn of fns) fn(next); },
  };
}

const ESRI = {
  ESRI_API_KEY: 'key',
  SATELLITE_URL: 'https://esri.test/tile/{z}/{y}/{x}?token={key}',
  SATELLITE_ATTRIBUTION: 'Source: Esri',
  ESRI_POWERED_BY: 'Powered by Esri',
};

// A canvas good enough for the plain ground layer.
function withDocument(run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const before = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ fillRect() {} }), toDataURL: () => 'data:image/png;base64,' }),
  };
  return Promise.resolve().then(run).finally(() => {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  });
}

const names = (viewer) => viewer.list.map((layer) => (layer.provider.plain ? 'plain'
  : String(layer.provider.url).startsWith('https://esri') ? 'esri' : `saved${layer.provider.maximumLevel}`));

test('the ground is plain ground, then the saved layers far to near, with no internet', () => withDocument(async () => {
  const viewer = fakeViewer();
  const asked = [];
  const ground = createGlobeGround({
    C: fakeCesium(), viewer, settings: settings(), online: fakeOnline(false), config: ESRI,
    checkEsriKey: () => { asked.push('check'); return Promise.resolve(false); }, groundColor: '#3d3e45',
  });
  ground.allowOnline();
  await settle();
  assert.deepEqual(names(viewer), ['plain', 'saved16', 'saved17', 'saved18']);
  assert.equal(ground.savedLayers, 3);
  const s = ground.status();
  assert.equal(s.plainGround, true);
  assert.equal(s.onlineKey, 'no');
  assert.equal(s.onlineLayerOn, false);
  assert.deepEqual(asked, ['check']);
  ground.destroy();
}));

test('Esri goes on under the saved layers only once the view allows it and Esri says yes', () => withDocument(async () => {
  const viewer = fakeViewer();
  let changes = 0;
  const ground = createGlobeGround({
    C: fakeCesium(), viewer, settings: settings(), online: fakeOnline(true), config: ESRI,
    checkEsriKey: () => Promise.resolve(true), groundColor: '#3d3e45', onChange: () => { changes += 1; },
  });
  await settle();
  // Esri said yes, but the first picture isn't in yet.
  assert.equal(ground.status().onlineKey, 'yes');
  assert.deepEqual(names(viewer), ['plain', 'saved16', 'saved17', 'saved18']);
  ground.allowOnline();
  assert.deepEqual(names(viewer), ['plain', 'esri', 'saved16', 'saved17', 'saved18']);
  assert.equal(ground.status().onlineLayerOn, true);
  assert.ok(changes > 0);
  assert.deepEqual([...viewer.credits].map((c) => c.html), ['Powered by Esri']);
  // Esri's tile over the field is never asked for, one far away is.
  const esri = viewer.list[1].provider;
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 16);
  await assert.rejects(esri.requestImage(x, y, 16, {}), /not asked for/);
  assert.equal(await esri.requestImage(0, 0, 3, {}), 'image');
  await settle();
  assert.equal(ground.status().onlineSkipped, 1);
  assert.equal(ground.status().onlineLoaded, 1);
  ground.destroy();
}));

test('no internet at the start: Esri is asked again when the internet comes back', () => withDocument(async () => {
  const viewer = fakeViewer();
  const online = fakeOnline(false);
  let answer = false;
  let checks = 0;
  const ground = createGlobeGround({
    C: fakeCesium(), viewer, settings: settings(), online, config: ESRI,
    checkEsriKey: () => { checks += 1; return Promise.resolve(answer); }, groundColor: '#3d3e45',
  });
  ground.allowOnline();
  await settle();
  assert.equal(ground.status().onlineKey, 'no');
  answer = true;
  online.set(true);
  await settle();
  assert.equal(checks, 2);
  assert.equal(ground.status().onlineLayerOn, true);
  // Going offline and back with no tile failed leaves the layer as it is.
  const layer = viewer.list[1];
  online.set(false);
  online.set(true);
  assert.equal(viewer.list[1], layer);
  ground.destroy();
  online.set(false);
  online.set(true);
  assert.equal(checks, 2, 'nothing is asked after destroy()');
}));

test('Esri tiles that failed while the internet was away are asked for again', () => withDocument(async () => {
  const viewer = fakeViewer();
  const online = fakeOnline(true);
  const net = { down: false };
  const ground = createGlobeGround({
    C: fakeCesium(net), viewer, settings: settings(), online, config: ESRI,
    checkEsriKey: () => Promise.resolve(true), groundColor: '#3d3e45',
  });
  ground.allowOnline();
  await settle();
  const first = viewer.list[1];
  // The connection drops and a tile far from the field fails. Cesium never
  // asks for a failed tile again, so the layer is made afresh when the
  // internet is back.
  net.down = true;
  await assert.rejects(first.provider.requestImage(0, 0, 3, {}), /offline/);
  await settle();
  assert.equal(ground.status().onlineFailed, 1);
  online.set(false);
  net.down = false;
  online.set(true);
  assert.notEqual(viewer.list[1], first);
  assert.deepEqual(names(viewer), ['plain', 'esri', 'saved16', 'saved17', 'saved18']);
  assert.deepEqual([...viewer.credits].map((c) => c.html), ['Powered by Esri']);
  // With nothing new failed, the next comeback leaves it alone.
  const second = viewer.list[1];
  online.set(false);
  online.set(true);
  assert.equal(viewer.list[1], second);
  ground.destroy();
}));

test('a no while the internet is up is asked again a minute later, and never after destroy()', () => withDocument(async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const viewer = fakeViewer();
    let checks = 0;
    const ground = createGlobeGround({
      C: fakeCesium(), viewer, settings: settings(), online: fakeOnline(true), config: ESRI,
      checkEsriKey: () => { checks += 1; return Promise.resolve(checks >= 2); }, groundColor: '#3d3e45',
    });
    ground.allowOnline();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ground.status().onlineKey, 'no');
    mock.timers.tick(59000);
    assert.equal(checks, 1);
    mock.timers.tick(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(checks, 2);
    assert.equal(ground.status().onlineLayerOn, true);
    ground.destroy();
    mock.timers.tick(120000);
    assert.equal(checks, 2);
  } finally {
    mock.timers.reset();
  }
}));

test('nothing saved: plain ground only, and Esri may ask for any tile', () => withDocument(async () => {
  const viewer = fakeViewer();
  const ground = createGlobeGround({
    C: fakeCesium(), viewer, settings: { field: { center: CENTER }, manifest: null, tilesUrl: null }, online: fakeOnline(true), config: ESRI,
    checkEsriKey: () => Promise.resolve(true), groundColor: '#3d3e45',
  });
  ground.allowOnline();
  await settle();
  assert.deepEqual(names(viewer), ['plain', 'esri']);
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 16);
  assert.equal(await viewer.list[1].provider.requestImage(x, y, 16, {}), 'image');
  ground.destroy();
}));
