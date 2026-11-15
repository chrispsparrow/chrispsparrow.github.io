// Checks the satellite tile layer in js/views/esri.js: the Leaflet methods
// it redoes for its tiles, which are boxes around a photo instead of the
// photo itself. Leaflet isn't loaded here. A small stand-in gives the layer
// what it needs, and each tile is a box with a fake img, so the checks are
// about what the layer decides to keep, drop and cancel.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/esri-layer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteLayer } from '../js/views/esri.js';

const EMPTY = 'data:image/gif;base64,EMPTY';

// What Leaflet's own GridLayer methods did, so the tests can see them run.
function fakeLeaflet() {
  const calls = [];
  const GridLayer = function () {};
  GridLayer.prototype._removeTile = function (key) {
    calls.push(['gridRemove', key]);
    delete this._tiles[key];
  };
  GridLayer.prototype._tileReady = function (coords) {
    calls.push(['gridReady', coords.z]);
  };
  const TileLayer = function (url, options) {
    this._url = url;
    this.options = options;
    this._tiles = {};
    this._map = {};
    this.fired = [];
  };
  TileLayer.prototype = Object.create(GridLayer.prototype);
  TileLayer.prototype.fire = function (type, data) { this.fired.push([type, data]); };
  TileLayer.extend = (props) => {
    const Child = function (...args) { TileLayer.apply(this, args); };
    Child.prototype = Object.create(TileLayer.prototype);
    Object.assign(Child.prototype, props);
    return Child;
  };
  const removed = [];
  return {
    L: {
      TileLayer,
      GridLayer,
      DomUtil: { remove: (el) => removed.push(el) },
      Util: { emptyImageUrl: EMPTY },
    },
    calls,
    removed,
  };
}

// A tile box as createTile makes it: finished once its photo loaded or
// failed, with src set once it has asked for its photo.
function box({ finished = false, src = null } = {}) {
  const attrs = new Map(src ? [['src', src]] : []);
  const img = {
    onload: () => {},
    onerror: () => {},
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
  };
  return { fcTile: { img, finished, dropped: false } };
}

const config = { SATELLITE_URL: 'https://example.test/{z}/{y}/{x}' };

function layerWith(tiles, tileZoom) {
  const fake = fakeLeaflet();
  const layer = createSatelliteLayer(fake.L, config, {});
  layer._tileZoom = tileZoom;
  for (const [key, entry] of Object.entries(tiles)) layer._tiles[key] = entry;
  return { layer, ...fake };
}

test('a zoom keeps the old level\'s finished photos and drops only the ones still loading', () => {
  const done = box({ finished: true, src: 'https://example.test/15/1/1' });
  const loading = box({ src: 'https://example.test/15/1/2' });
  const waiting = box();
  const current = box({ src: 'https://example.test/16/2/2' });
  const { layer, removed } = layerWith({
    a: { el: done, coords: { z: 15 } },
    b: { el: loading, coords: { z: 15 } },
    c: { el: waiting, coords: { z: 15 } },
    d: { el: current, coords: { z: 16 } },
  }, 16);
  layer._abortLoading();
  // The finished photo of the old level stays, so the map isn't black
  // until the new level is in. The new level's tile is never touched.
  assert.deepEqual(Object.keys(layer._tiles).sort(), ['a', 'd']);
  assert.equal(done.fcTile.dropped, false);
  assert.equal(current.fcTile.dropped, false);
  // The loading one is cancelled, and the waiting one never asks.
  assert.equal(loading.fcTile.img.getAttribute('src'), EMPTY);
  assert.equal(loading.fcTile.img.onload, null);
  assert.equal(waiting.fcTile.dropped, true);
  assert.equal(waiting.fcTile.img.getAttribute('src'), null);
  assert.deepEqual(removed, [loading, waiting]);
  assert.deepEqual(layer.fired.map(([type]) => type), ['tileabort', 'tileabort']);
});

test('removing a tile cancels its photo and then lets Leaflet remove it', () => {
  const loading = box({ src: 'https://example.test/16/2/2' });
  const { layer, calls } = layerWith({ k: { el: loading, coords: { z: 16 } } }, 16);
  layer._removeTile('k');
  assert.equal(loading.fcTile.dropped, true);
  assert.equal(loading.fcTile.img.getAttribute('src'), EMPTY);
  assert.deepEqual(calls, [['gridRemove', 'k']]);
  // A key that isn't there does nothing.
  layer._removeTile('nothing');
  assert.deepEqual(calls, [['gridRemove', 'k']]);
});

test('a dropped tile\'s late answer is ignored, a live one goes to Leaflet', () => {
  const dropped = box({ src: 'x' });
  dropped.fcTile.dropped = true;
  const live = box({ src: 'y' });
  const { layer, calls } = layerWith({}, 16);
  layer._tileReady({ z: 16 }, null, dropped);
  assert.deepEqual(calls, []);
  layer._tileReady({ z: 16 }, null, live);
  assert.deepEqual(calls, [['gridReady', 16]]);
  // Once the layer is off the map, nothing goes through.
  layer._map = null;
  layer._tileReady({ z: 16 }, null, live);
  assert.deepEqual(calls, [['gridReady', 16]]);
});
