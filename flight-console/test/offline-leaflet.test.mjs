// Tests for js/launch/offline-leaflet.js: the launch page's 2D map
// background. Leaflet isn't loaded here. A small stand-in gives the layers
// what they need, the page's elements are plain objects, and an img that is
// given an address is written down as a request, so the checks are about
// which files get asked for, what a tile ends up showing, and when the
// online layers go on and off.
// The saved map is built the way launch-mode/download_tiles.py builds its
// manifest for the CRMRC field (as in offline-tiles.test.mjs).
// Run with: node --test "flight-console/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../js/config.js';
import { clipToBox, pickPhoto, createSavedLayer, createLaunchBackground } from '../js/launch/offline-leaflet.js';
import { createOfflineTiles } from '../js/launch/offline-tiles.js';

const CENTER = { lat: 44.825278, lon: -73.171727 };
const BASE = 'http://localhost:8000/offline-maps/crmrc/';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------
// A saved map, with the downloader's tile math
// ------------------------------------------------------------------
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

function level(z, halfKm) {
  const box = boxDegrees(CENTER, halfKm);
  const [x0, y0] = tileXY(box.north, box.west, z);
  const [x1, y1] = tileXY(box.south, box.east, z);
  return {
    z, x0, x1, y0, y1, halfKm, missing: [], box,
    covered: { south: tileLat(y1 + 1, z), west: tileLon(x0, z), north: tileLat(y0, z), east: tileLon(x1 + 1, z) },
  };
}

// The real plan: zooms 0 to 16 for the 30 km box, 17 for the inner 10 km
// and 18 for the inner 4 km. `only` keeps just some zooms.
function savedTiles({ only = null } = {}) {
  let levels = [];
  for (let z = 0; z <= 16; z++) levels.push(level(z, 15));
  levels.push(level(17, 5), level(18, 2));
  if (only) levels = levels.filter((lv) => only.includes(lv.z));
  const manifest = { version: 1, tileUrl: '{z}/{x}/{y}.jpg', credit: 'USGS <test> credit', complete: true, center: CENTER, levels };
  return { manifest, tilesUrl: BASE };
}

const fieldTile = (z) => {
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, z);
  return { z, x, y };
};
// A tile 10 km north-east of the field: inside the box, outside zoom 17's.
const ringTile = (z) => {
  const near = boxDegrees(CENTER, 10);
  const [x, y] = tileXY(near.north, near.east, z);
  return { z, x, y };
};
// 60 km east of the field, far outside the box.
const farTile = (z) => {
  const far = boxDegrees(CENTER, 60);
  const [x, y] = tileXY(CENTER.lat, far.east, z);
  return { z, x, y };
};

// ------------------------------------------------------------------
// Stand-ins for the page and for Leaflet
// ------------------------------------------------------------------

// Every address an img was pointed at, in order.
let requests = [];

function element(tag) {
  const attrs = new Map();
  const el = {
    tag,
    style: {},
    children: [],
    parent: null,
    append(child) { el.children.push(child); child.parent = el; },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
  };
  if (tag === 'img') {
    Object.defineProperty(el, 'src', {
      get: () => attrs.get('src') ?? '',
      set: (value) => { attrs.set('src', value); requests.push(value); },
    });
  }
  return el;
}
globalThis.document = { createElement: element };

function fakeLeaflet() {
  class Layer {
    constructor(options = {}) {
      this.options = options;
      this._tiles = {};
      this._map = null;
      this._handlers = {};
      this.redraws = 0;
    }
    addTo(map) { this._map = map; map.layers.push(this); return this; }
    remove() {
      if (!this._map) return this;
      this._map.layers = this._map.layers.filter((l) => l !== this);
      this._map = null;
      this.fire('remove');
      return this;
    }
    on(type, fn) { (this._handlers[type] ??= []).push(fn); return this; }
    fire(type, data) { for (const fn of this._handlers[type] ?? []) fn(data); }
    redraw() { this.redraws += 1; return this; }
    getTileSize() { return { x: 256, y: 256 }; }
    _removeTile(key) { delete this._tiles[key]; }
    _tileReady() {}
  }
  class GridLayer extends Layer {}
  class TileLayer extends GridLayer {
    constructor(url, options) { super(options); this._url = url; }
  }
  const extendable = (Base) => {
    Base.extend = (props) => {
      const Child = class extends Base {};
      Object.assign(Child.prototype, props);
      return Child;
    };
  };
  extendable(GridLayer);
  extendable(TileLayer);
  return {
    GridLayer,
    TileLayer,
    tileLayer: (url, options) => new TileLayer(url, options),
    DomUtil: { remove() {} },
    Util: {
      emptyImageUrl: 'data:image/gif;base64,EMPTY',
      extend: Object.assign,
      template: (text, data) => text.replace(/\{(\w+)\}/g, (_, name) => data[name]),
    },
  };
}

// A map that keeps its layers in a list, looking at `view`.
function fakeMap(view) {
  const map = {
    layers: [],
    view,
    hasLayer: (layer) => map.layers.includes(layer),
    getBounds: () => ({
      getSouth: () => map.view.south, getNorth: () => map.view.north, getWest: () => map.view.west, getEast: () => map.view.east,
    }),
  };
  return map;
}
const INSIDE = boxDegrees(CENTER, 2);   // a view well inside the saved box
const WIDE = boxDegrees(CENTER, 60);    // a view that reaches far outside it

// Launch mode's hub, as far as the background reads it.
function fakeHub(settings, { online = false } = {}) {
  const fns = new Set();
  const hub = {
    settings,
    checks: 0,
    online: {
      get: () => online,
      check: () => { hub.checks += 1; return Promise.resolve(online); },
      onChange: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    },
    setOnline(next) { online = next; for (const fn of [...fns]) fn(next); },
    listeners: () => fns.size,
  };
  return hub;
}

// A key check the test answers by hand.
function keyCheck() {
  const calls = [];
  const check = () => new Promise((resolve) => calls.push(resolve));
  check.calls = calls;
  check.answer = async (ok) => { calls.shift()(ok); await tick(); };
  return check;
}

// Makes a tile the way Leaflet does and returns what happened to it.
function makeTile(layer, coords) {
  const result = { done: 0, errors: [] };
  const box = layer.createTile(coords, (err) => { result.done += 1; result.errors.push(err); });
  result.box = box;
  result.img = box.children[0] ?? null;
  layer._tiles[`${coords.x}:${coords.y}:${coords.z}`] = { el: box, coords };
  return result;
}

// ------------------------------------------------------------------
// The tile math and the photo choice
// ------------------------------------------------------------------

test('a tile is whole inside the box, cut at its edge, and nothing outside it', () => {
  const tiles = createOfflineTiles(savedTiles());
  assert.deepEqual(clipToBox(tiles.bounds, fieldTile(16)), { left: 0, top: 0, right: 0, bottom: 0, whole: true });
  assert.equal(clipToBox(tiles.bounds, farTile(13)), null);
  // The box is the ground zoom 16's tiles cover. Its east edge runs along
  // the edge of zoom 16's last column, so the zoom 16 tile next to that is
  // outside: a sliver thinner than a pixel doesn't count.
  const last = level(16, 15);
  assert.equal(clipToBox(tiles.bounds, { z: 16, x: last.x1 + 1, y: last.y0 + 3 }), null);
  assert.ok(clipToBox(tiles.bounds, { z: 16, x: last.x1, y: last.y0 + 3 }).whole);
  // One zoom out, the tile over that edge is cut where the box ends: half
  // way across when zoom 16's last column is the left half of it.
  const over = { z: 15, x: Math.floor(last.x1 / 2), y: Math.floor((last.y0 + 3) / 2) };
  const clip = clipToBox(tiles.bounds, over);
  assert.equal(clip.whole, false);
  assert.equal(clip.right, last.x1 % 2 === 0 ? 128 : 0);
  assert.equal(clip.left, 0);
  // Far out, the box is a patch about 70 px wide. At zoom 8 it lies over
  // the line between two tiles, so each of them shows its own part, cut on
  // the other sides, and the two parts add up to the box.
  const at = fieldTile(8);
  const small = clipToBox(tiles.bounds, at);
  const beside = clipToBox(tiles.bounds, { ...at, x: at.x + 1 });
  assert.ok(small.left > 0 && small.top > 0 && small.bottom > 0);
  assert.equal(small.right, 0);
  assert.ok(beside.right > 0 && beside.top > 0 && beside.bottom > 0);
  assert.equal(beside.left, 0);
  const boxPx = ((tiles.bounds.east - tiles.bounds.west) / 360) * 2 ** 8 * 256;
  assert.ok(boxPx < 80);
  assert.ok(Math.abs((256 - small.left) + (256 - beside.right) - boxPx) < 0.25);
  // The tile on the far side of that one has none of the box.
  assert.equal(clipToBox(tiles.bounds, { ...at, x: at.x + 2 }), null);
});

test('a tile gets its own photo, or the closest saved one above it', () => {
  const tiles = createOfflineTiles(savedTiles());
  assert.deepEqual(pickPhoto(tiles, fieldTile(18)), fieldTile(18));
  // 10 km out there is no zoom 17 or 18: zoom 16 fills in.
  const ring = ringTile(18);
  assert.deepEqual(pickPhoto(tiles, ring), { z: 16, x: Math.floor(ring.x / 4), y: Math.floor(ring.y / 4) });
  // A file known to be missing is skipped, and the next zoom above is used.
  const own = fieldTile(18);
  const gone = new Set([`18/${own.x}/${own.y}`, `17/${own.x >> 1}/${own.y >> 1}`]);
  const isMissing = (z, x, y) => gone.has(`${z}/${x}/${y}`);
  assert.deepEqual(pickPhoto(tiles, own, isMissing), { z: 16, x: own.x >> 2, y: own.y >> 2 });
  // Told where to start, it never looks closer than that.
  assert.equal(pickPhoto(tiles, own, () => false, 15).z, 15);
  // With every file missing there is nothing.
  assert.equal(pickPhoto(tiles, own, () => true), null);
});

// ------------------------------------------------------------------
// The saved layer
// ------------------------------------------------------------------

test('a saved tile asks for its own file once, and a tile outside the box asks for nothing', async () => {
  requests = [];
  const tiles = createOfflineTiles(savedTiles());
  const layer = createSavedLayer(fakeLeaflet(), tiles, {});
  const at = fieldTile(16);
  const tile = makeTile(layer, at);
  assert.deepEqual(requests, [`${BASE}16/${at.x}/${at.y}.jpg`]);
  assert.equal(tile.img.style.width, '256.5px');
  assert.equal(tile.img.style.left, '0px');
  assert.equal(tile.box.style.clipPath, undefined);
  assert.equal(tile.done, 0);
  tile.img.onload();
  assert.equal(tile.done, 1);
  assert.equal(tile.errors[0], null);
  assert.equal(tile.box.fcTile.finished, true);

  // 60 km east: an empty box, no img, no request, and no error for Leaflet.
  const out = makeTile(layer, farTile(13));
  assert.equal(out.img, null);
  assert.equal(out.done, 0);
  await tick();
  assert.equal(out.done, 1);
  assert.equal(out.errors[0], null);
  assert.equal(requests.length, 1);
  assert.deepEqual(layer.fcSaved.counts, { loaded: 1, failed: 0, empty: 1, fellBack: 0, missingFiles: 0 });
});

test('where the closest zooms were not saved, the photo above is scaled up and moved into place', () => {
  requests = [];
  const tiles = createOfflineTiles(savedTiles());
  const layer = createSavedLayer(fakeLeaflet(), tiles, {});
  const at = ringTile(18);
  const tile = makeTile(layer, at);
  const px = Math.floor(at.x / 4);
  const py = Math.floor(at.y / 4);
  assert.deepEqual(requests, [`${BASE}16/${px}/${py}.jpg`]);
  // The zoom 16 photo is four tiles across at zoom 18.
  assert.equal(tile.img.style.width, '1024.5px');
  assert.equal(tile.img.style.height, '1024.5px');
  assert.equal(tile.img.style.left, `${-(at.x - px * 4) * 256}px`);
  assert.equal(tile.img.style.top, `${-(at.y - py * 4) * 256}px`);
});

test('a tile on the box\'s edge is cut off at the edge', () => {
  requests = [];
  const tiles = createOfflineTiles(savedTiles());
  const layer = createSavedLayer(fakeLeaflet(), tiles, {});
  const last = level(16, 15);
  // Find a zoom 15 tile the east edge runs through.
  const over = { z: 15, x: Math.floor(last.x1 / 2), y: Math.floor((last.y0 + 3) / 2) };
  const clip = clipToBox(tiles.bounds, over);
  const tile = makeTile(layer, over);
  if (clip.whole) {
    assert.equal(tile.box.style.clipPath, undefined);
  } else {
    // The box is half a px bigger than the tile, so the cut is too.
    assert.equal(tile.box.style.clipPath, `inset(0px ${clip.right + 0.5}px 0px 0px)`);
  }
  assert.equal(requests.length, 1);
});

test('a saved file that is missing falls back up the zooms, and is never asked for twice', () => {
  requests = [];
  const tiles = createOfflineTiles(savedTiles());
  const layer = createSavedLayer(fakeLeaflet(), tiles, {});
  const at = fieldTile(17);
  const tile = makeTile(layer, at);
  assert.deepEqual(requests, [`${BASE}17/${at.x}/${at.y}.jpg`]);
  // Zoom 17's file isn't there, and neither is zoom 16's.
  tile.img.onerror();
  assert.equal(requests[1], `${BASE}16/${at.x >> 1}/${at.y >> 1}.jpg`);
  assert.equal(tile.done, 0);
  tile.img.onerror();
  assert.equal(requests[2], `${BASE}15/${at.x >> 2}/${at.y >> 2}.jpg`);
  // Zoom 15's loads: the tile shows it, four times the size, with no error.
  assert.equal(tile.img.style.width, '1024.5px');
  tile.img.onload();
  assert.equal(tile.done, 1);
  assert.equal(tile.errors[0], null);
  assert.deepEqual(layer.fcSaved.counts, { loaded: 1, failed: 0, empty: 0, fellBack: 1, missingFiles: 2 });

  // The tile next to it under the same zoom 16 photo asks for its own file,
  // and when that is missing too it goes straight to zoom 15.
  const next = { z: 17, x: at.x ^ 1, y: at.y };
  const second = makeTile(layer, next);
  assert.equal(requests[3], `${BASE}17/${next.x}/${next.y}.jpg`);
  second.img.onerror();
  assert.equal(requests[4], `${BASE}15/${at.x >> 2}/${at.y >> 2}.jpg`);
  assert.equal(requests.length, 5);
  // And a new tile in the first spot doesn't ask for the missing files again.
  makeTile(layer, at);
  assert.equal(requests[5], `${BASE}15/${at.x >> 2}/${at.y >> 2}.jpg`);
  assert.equal(requests.length, 6);
});

test('a tile with no photo left gives up quietly, once', () => {
  requests = [];
  // Only zoom 16 was saved.
  const tiles = createOfflineTiles(savedTiles({ only: [16] }));
  let holes = 0;
  const layer = createSavedLayer(fakeLeaflet(), tiles, {}, { onHole: () => { holes += 1; } });
  const at = fieldTile(16);
  assert.equal(layer.fcSaved.covers(at), true);
  const tile = makeTile(layer, at);
  tile.img.onerror();
  // No retry and no error handed to Leaflet: an empty box.
  assert.equal(requests.length, 1);
  assert.equal(tile.done, 1);
  assert.equal(tile.errors[0], null);
  assert.equal(tile.box.children.length, 0);
  assert.equal(tile.box.fcTile.finished, true);
  assert.equal(holes, 1);
  assert.deepEqual(layer.fcSaved.counts, { loaded: 0, failed: 1, empty: 0, fellBack: 0, missingFiles: 1 });
  // After a hole the saved layer no longer says it covers anything, so the
  // online photos load underneath everywhere.
  assert.equal(layer.fcSaved.covers({ z: 16, x: at.x + 1, y: at.y }), false);
  // A second hole doesn't call again.
  const again = makeTile(layer, { z: 16, x: at.x + 1, y: at.y });
  again.img.onerror();
  assert.equal(holes, 1);
  assert.equal(layer.fcSaved.counts.failed, 2);
});

test('a tile the map let go of asks for nothing more', () => {
  requests = [];
  const L = fakeLeaflet();
  const tiles = createOfflineTiles(savedTiles());
  const layer = createSavedLayer(L, tiles, {});
  const at = fieldTile(17);
  const tile = makeTile(layer, at);
  layer._removeTile(`${at.x}:${at.y}:${at.z}`);
  assert.equal(tile.box.fcTile.dropped, true);
  // Its download is cancelled (Leaflet's empty picture), and a late error
  // has nobody to tell.
  assert.equal(tile.img.onerror, null);
  assert.equal(tile.img.getAttribute('src'), L.Util.emptyImageUrl);
});

// ------------------------------------------------------------------
// The whole background
// ------------------------------------------------------------------

test('the saved imagery is on at once, before the key check has answered', async () => {
  requests = [];
  const L = fakeLeaflet();
  const map = fakeMap(WIDE);
  const hub = fakeHub(savedTiles());
  const checkKey = keyCheck();
  const bg = createLaunchBackground({ L, map, config, hub, labelsPane: 'fc-labels', parts: { checkKey } });
  assert.equal(map.layers.length, 1);
  assert.equal(checkKey.calls.length, 1);
  let s = bg.status();
  assert.equal(s.savedLayerOn, true);
  assert.equal(s.onlineLayerOn, false);
  assert.equal(s.keyChecking, true);
  // Zoomed in past the closest saved zoom, Leaflet scales zoom 18 up.
  assert.equal(map.layers[0].options.maxNativeZoom, 18);
  assert.equal(map.layers[0].options.maxZoom, config.TILE_MAX_ZOOM);
  // Nothing is said while the first check is still out.
  assert.equal(bg.note(), '');
  assert.deepEqual(bg.credits(), ['USGS &lt;test&gt; credit']);

  // The check fails (no internet): nothing changes but the note.
  await checkKey.answer(false);
  s = bg.status();
  assert.equal(s.savedLayerOn, true);
  assert.equal(s.onlineLayerOn, false);
  assert.equal(s.labelsOn, false);
  assert.equal(s.keyChecks, 1);
  assert.equal(map.layers.length, 1);
  assert.equal(bg.note(), 'No internet, so the map shows the saved imagery and nothing outside it.');
  // With the whole view inside the saved imagery there is nothing to say.
  map.view = INSIDE;
  assert.equal(bg.note(), '');
  assert.equal(checkKey.calls.length, 0);
  bg.destroy();
});

test('the online layers come on when the internet answers, and go again when it stops', async () => {
  requests = [];
  const L = fakeLeaflet();
  const map = fakeMap(WIDE);
  const hub = fakeHub(savedTiles());
  const checkKey = keyCheck();
  let changes = 0;
  const bg = createLaunchBackground({ L, map, config, hub, labelsPane: 'fc-labels', onChange: () => { changes += 1; }, parts: { checkKey } });
  await checkKey.answer(false);
  assert.equal(changes, 1);

  // hub.online turns true: the key check is tried again, and Esri says yes.
  hub.setOnline(true);
  assert.equal(checkKey.calls.length, 1);
  assert.equal(bg.note(), 'Online imagery isn\'t available right now, so the map shows the saved imagery and nothing outside it.');
  await checkKey.answer(true);
  const s = bg.status();
  assert.equal(s.savedLayerOn, true);
  assert.equal(s.onlineLayerOn, true);
  assert.equal(s.labelsOn, true);
  assert.equal(s.keyChecks, 2);
  assert.equal(bg.note(), '');
  const [saved, online, labels] = map.layers;
  // The saved imagery is above the online photos, and the names are in
  // their own pane above both.
  assert.ok(saved.options.zIndex > online.options.zIndex);
  assert.equal(labels.options.pane, 'fc-labels');
  assert.deepEqual(bg.credits(), ['USGS &lt;test&gt; credit', config.ESRI_POWERED_BY, config.SATELLITE_ATTRIBUTION, config.SATELLITE_LABELS_ATTRIBUTION]);

  // While they are on, hub.online saying true again asks nothing.
  hub.setOnline(true);
  assert.equal(checkKey.calls.length, 0);

  // The internet stops answering: Esri's layers and credits go, the saved
  // imagery stays.
  hub.setOnline(false);
  assert.deepEqual(map.layers, [saved]);
  assert.deepEqual(bg.credits(), ['USGS &lt;test&gt; credit']);
  assert.equal(bg.status().onlineLayerOn, false);

  // And back.
  hub.setOnline(true);
  await checkKey.answer(true);
  assert.equal(map.layers.length, 3);

  bg.destroy();
  assert.equal(map.layers.length, 0);
  assert.equal(hub.listeners(), 0);
  // Nothing happens after that.
  hub.setOnline(false);
  hub.setOnline(true);
  assert.equal(checkKey.calls.length, 0);
});

test('online, a tile the saved imagery covers asks Esri for nothing', async () => {
  requests = [];
  const L = fakeLeaflet();
  const map = fakeMap(WIDE);
  const hub = fakeHub(savedTiles(), { online: true });
  const checkKey = keyCheck();
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { fetches += 1; return Promise.reject(new Error('no network in this test')); };
  try {
    const bg = createLaunchBackground({ L, map, config, hub, labelsPane: 'fc-labels', parts: { checkKey } });
    await checkKey.answer(true);
    const online = map.layers[1];
    // Inside the box, at a zoom Esri would first be asked about: an empty
    // box, no photo and no "which tiles exist" question.
    const inside = makeTile(online, fieldTile(18));
    assert.equal(inside.img, null);
    await tick();
    assert.equal(inside.done, 1);
    assert.equal(requests.length, 0);
    assert.equal(fetches, 0);
    // Outside the box Esri's photo is asked for as usual.
    const out = farTile(13);
    const outside = makeTile(online, out);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].startsWith(`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/13/${out.y}/${out.x}?token=`));
    outside.img.onload();
    // A tile over the box's edge is only partly covered, so it loads too.
    const last = level(16, 15);
    const edge = { z: 13, x: Math.floor((last.x1 + 1) / 8), y: Math.floor(last.y0 / 8) };
    assert.equal(clipToBox(createOfflineTiles(savedTiles()).bounds, edge)?.whole ?? false, false);
    makeTile(online, edge);
    assert.equal(requests.length, 2);
    const s = bg.status();
    assert.equal(s.onlineSkipped, 1);
    assert.equal(s.onlineLoaded, 1);
    assert.equal(s.onlineFailed, 0);
    bg.destroy();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('online photos that keep failing come off quietly, and are tried again when asked', async () => {
  requests = [];
  const L = fakeLeaflet();
  const map = fakeMap(WIDE);
  const hub = fakeHub(savedTiles(), { online: true });
  const checkKey = keyCheck();
  const quick = { ...config, TILE_FAIL_TIMEOUT_MS: 20 };
  const bg = createLaunchBackground({ L, map, config: quick, hub, labelsPane: 'fc-labels', parts: { checkKey } });
  await checkKey.answer(true);
  const online = map.layers[1];
  const out = farTile(13);
  for (let i = 0; i <= config.TILE_FAIL_COUNT; i++) makeTile(online, { ...out, x: out.x + i }).img.onerror(new Error('no photo'));
  // Not before the waiting time is over.
  assert.equal(bg.status().onlineLayerOn, true);
  await tick(40);
  const s = bg.status();
  assert.equal(s.onlineLayerOn, false);
  assert.equal(s.labelsOn, false);
  assert.equal(s.savedLayerOn, true);
  assert.equal(s.onlineFailed, config.TILE_FAIL_COUNT + 1);
  // hub.online was asked to look again, and nothing retries by itself.
  assert.equal(hub.checks, 1);
  assert.equal(checkKey.calls.length, 0);
  // A press on SATELLITE asks again.
  bg.retryOnline();
  assert.equal(checkKey.calls.length, 1);
  await checkKey.answer(true);
  assert.equal(bg.status().onlineLayerOn, true);
  bg.destroy();
});

test('with Wi-Fi off (the browser knows) or no key, nothing is asked of the internet', async () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  try {
    const map = fakeMap(WIDE);
    const hub = fakeHub(savedTiles());
    const checkKey = keyCheck();
    const bg = createLaunchBackground({ L: fakeLeaflet(), map, config, hub, labelsPane: 'fc-labels', parts: { checkKey } });
    // No check, so the note is there at once.
    assert.equal(checkKey.calls.length, 0);
    assert.equal(bg.status().keyChecks, 0);
    assert.equal(bg.status().savedLayerOn, true);
    assert.equal(bg.note(), 'No internet, so the map shows the saved imagery and nothing outside it.');
    // A press on SATELLITE asks hub.online, and still sends nothing while
    // the browser says it is offline.
    bg.retryOnline();
    assert.equal(hub.checks, 1);
    assert.equal(checkKey.calls.length, 0);
    bg.destroy();
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete globalThis.navigator;
  }

  // No Esri key in config.js: never a check, even with internet.
  const map = fakeMap(WIDE);
  const hub = fakeHub(savedTiles(), { online: true });
  const checkKey = keyCheck();
  const bg = createLaunchBackground({ L: fakeLeaflet(), map, config: { ...config, ESRI_API_KEY: '' }, hub, labelsPane: 'fc-labels', parts: { checkKey } });
  hub.setOnline(true);
  assert.equal(checkKey.calls.length, 0);
  assert.equal(bg.status().onlineLayerOn, false);
  assert.equal(bg.note(), 'Online imagery isn\'t available right now, so the map shows the saved imagery and nothing outside it.');
  bg.destroy();
});

test('with nothing saved the map still works: online photos, or plain ground and one note', async () => {
  requests = [];
  for (const settings of [null, { field: { center: CENTER }, manifest: null, tilesUrl: BASE }]) {
    const L = fakeLeaflet();
    const map = fakeMap(INSIDE);
    const hub = fakeHub(settings);
    const checkKey = keyCheck();
    const bg = createLaunchBackground({ L, map, config, hub, labelsPane: 'fc-labels', parts: { checkKey } });
    assert.equal(map.layers.length, 0);
    assert.equal(bg.status().savedLayerOn, false);
    assert.deepEqual(bg.credits(), []);
    assert.equal(bg.note(), '');
    await checkKey.answer(false);
    assert.equal(bg.note(), 'No internet and no saved imagery, so the map is blank. Tracking still works.');
    hub.setOnline(true);
    await checkKey.answer(true);
    assert.equal(bg.status().onlineLayerOn, true);
    assert.equal(bg.note(), '');
    // Nothing is skipped: every tile is Esri's.
    const online = map.layers[0];
    makeTile(online, fieldTile(13));
    assert.equal(bg.status().onlineSkipped, 0);
    bg.destroy();
  }
});
