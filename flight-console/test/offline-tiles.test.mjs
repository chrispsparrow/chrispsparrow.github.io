// Tests for js/launch/offline-tiles.js: which saved map tiles launch mode
// has. The manifest here is built the way launch-mode/download_tiles.py
// builds it, for the CRMRC field's box.
// Run with: node --test "flight-console/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createOfflineTiles } from '../js/launch/offline-tiles.js';

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

function level(z, halfKm, missing = []) {
  const box = boxDegrees(CENTER, halfKm);
  const [x0, y0] = tileXY(box.north, box.west, z);
  const [x1, y1] = tileXY(box.south, box.east, z);
  return {
    z, x0, x1, y0, y1, halfKm, missing, box,
    count: (x1 - x0 + 1) * (y1 - y0 + 1),
    covered: { south: tileLat(y1 + 1, z), west: tileLon(x0, z), north: tileLat(y0, z), east: tileLon(x1 + 1, z) },
  };
}

function manifest({ missing17 = [] } = {}) {
  const levels = [];
  for (let z = 0; z <= 16; z++) levels.push(level(z, 15));
  levels.push(level(17, 5, missing17));
  levels.push(level(18, 2));
  return { version: 1, tileUrl: '{z}/{x}/{y}.jpg', credit: 'USGS', complete: true, center: CENTER, levels };
}

const settings = (m = manifest()) => ({ manifest: m, tilesUrl: 'http://localhost:8000/offline-maps/crmrc/' });

test('no manifest, no tiles', () => {
  assert.equal(createOfflineTiles(null), null);
  assert.equal(createOfflineTiles({ manifest: null, tilesUrl: 'x/' }), null);
  assert.equal(createOfflineTiles({ manifest: { levels: [] }, tilesUrl: 'x/' }), null);
});

test('the field has a tile at every zoom from 0 to 18, and the address is zoom/x/y', () => {
  const tiles = createOfflineTiles(settings());
  assert.equal(tiles.minZoom, 0);
  assert.equal(tiles.maxZoom, 18);
  for (let z = 0; z <= 18; z++) {
    const [x, y] = tileXY(CENTER.lat, CENTER.lon, z);
    assert.ok(tiles.has(z, x, y), `zoom ${z}`);
    assert.equal(tiles.deepest(z, x, y), z);
  }
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 16);
  assert.equal(tiles.url(16, x, y), `http://localhost:8000/offline-maps/crmrc/16/${x}/${y}.jpg`);
});

test('past the closest saved zoom, the closest saved tile over the same ground is used', () => {
  const tiles = createOfflineTiles(settings());
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 20);
  assert.equal(tiles.has(20, x, y), false);
  assert.equal(tiles.deepest(20, x, y), 18);
  assert.deepEqual(tiles.parent(20, x, y, 18), { z: 18, x: Math.floor(x / 4), y: Math.floor(y / 4) });
});

test('10 km out there is no zoom 17, so zoom 16 fills in. 40 km out there is nothing close', () => {
  const tiles = createOfflineTiles(settings());
  const near = boxDegrees(CENTER, 10);
  const [x, y] = tileXY(near.north, near.east, 18);
  assert.equal(tiles.deepest(18, x, y), 16);
  // Far outside the box only the far zooms (whose tiles are huge) have it.
  const far = boxDegrees(CENTER, 40);
  const [fx, fy] = tileXY(far.north, far.east, 16);
  assert.equal(tiles.has(16, fx, fy), false);
  assert.ok(tiles.deepest(16, fx, fy) < 12);
  // The other side of the world has nothing at zoom 5 and up.
  const [ox, oy] = tileXY(-33.9, 151.2, 12);
  const deepest = tiles.deepest(12, ox, oy);
  assert.ok(deepest === null || deepest < 2);
});

test('a tile the download missed falls back to the zoom above it', () => {
  const [mx, my] = tileXY(CENTER.lat, CENTER.lon, 17);
  const tiles = createOfflineTiles(settings(manifest({ missing17: [[mx, my]] })));
  assert.equal(tiles.has(17, mx, my), false);
  assert.equal(tiles.deepest(17, mx, my), 16);
  // Zoom 18 over the same ground is still its own tile.
  const [x, y] = tileXY(CENTER.lat, CENTER.lon, 18);
  assert.equal(tiles.deepest(18, x, y), 18);
  // And a search told to start at 17 skips the missing tile.
  assert.equal(tiles.deepest(18, x, y, 17), 16);
});

test('the 3D view gets three stacks, each inside the one before, with every tile in them saved', () => {
  const tiles = createOfflineTiles(settings());
  assert.deepEqual(tiles.stacks.map((s) => s.maxZoom), [16, 17, 18]);
  for (let i = 1; i < tiles.stacks.length; i++) {
    const outer = tiles.stacks[i - 1].rect;
    const inner = tiles.stacks[i].rect;
    assert.ok(inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east);
  }
  assert.deepEqual(tiles.bounds, tiles.stacks[0].rect);
  // Every tile that touches a stack's rectangle, at every zoom up to its
  // closest, is saved. Checked along the rectangle's edges and its middle.
  for (const stack of tiles.stacks) {
    const r = stack.rect;
    const spots = [];
    for (let i = 0; i <= 20; i++) {
      const lat = r.south + (r.north - r.south) * i / 20;
      const lon = r.west + (r.east - r.west) * i / 20;
      spots.push([lat, r.west], [lat, r.east], [r.south, lon], [r.north, lon], [lat, lon]);
    }
    for (let z = 0; z <= stack.maxZoom; z++) {
      for (const [lat, lon] of spots) {
        const [x, y] = tileXY(lat, lon, z);
        assert.ok(tiles.has(z, x, y), `stack to ${stack.maxZoom}: zoom ${z} at ${lat}, ${lon}`);
      }
    }
  }
  // The far stack covers the whole 30 km box.
  const box = boxDegrees(CENTER, 15);
  const b = tiles.bounds;
  assert.ok(b.south <= box.south && b.north >= box.north && b.west <= box.west && b.east >= box.east);
});

test('the real manifest on this laptop, when the tiles have been downloaded, reads the same way', (t) => {
  const file = new URL('../../offline-maps/crmrc/manifest.json', import.meta.url);
  if (!existsSync(file)) {
    t.skip('no tiles downloaded here');
    return;
  }
  const real = JSON.parse(readFileSync(file, 'utf8'));
  const tiles = createOfflineTiles({ manifest: real, tilesUrl: 'http://localhost:8000/offline-maps/crmrc/' });
  assert.ok(tiles);
  const c = real.center;
  const [x, y] = tileXY(c.lat, c.lon, tiles.maxZoom);
  assert.equal(tiles.deepest(tiles.maxZoom, x, y), tiles.maxZoom);
  assert.ok(tiles.stacks.length >= 1);
});
