// offline-leaflet.js: the 2D map's background on the launch page, where the
// internet may be off, or up but dead. Nothing here ever waits on the
// network before the map shows.
//
// What is on the map, bottom to top:
//   1. Plain ground: the map's own background color. Always there.
//   2. Esri's satellite photos, the normal page's layer (js/views/esri.js).
//      Only on while Esri has said yes to the key and the internet answers.
//   3. The saved imagery: the photos launch-mode/download_tiles.py saved for
//      the box around the field. On at once, from files on this laptop.
//   4. Esri's place names, on with the online photos.
//
// THE SAVED LAYER. Each map tile shows the closest saved photo of its
// ground: its own file, or the nearest zoom above it, scaled up and moved
// so the right part fills the tile. (The same box-around-one-photo tiles as
// the Esri layer, with the same redone Leaflet methods, shared from
// esri.js.) Zoomed in past the closest saved zoom, the closest photos are
// scaled up.
//
// It only draws inside the saved box (tiles.bounds, the same rectangle the
// 3D view uses). A tile outside it is an empty see-through box that asks for
// nothing, and a tile on the edge is cut off at the edge. The far zooms'
// saved photos reach far past the box (zoom 0 is the whole world in one
// tile), and without the cut they would cover the online photos with a blur
// everywhere.
//
// A SAVED FILE THAT ISN'T THERE (the download was stopped early): the tile
// falls back to the next saved zoom above it, and so on up, until a photo
// loads. Each missing file is asked for once and remembered for the visit,
// so no tile asks for it again and nothing retries. A tile with no photo at
// all ends as an empty box, without an error. Reload the page after a
// download finishes to pick up the new files.
//
// THE ONLINE LAYERS are extras. The key check is tried once when the map
// opens (unless the browser already knows it is offline), again whenever
// hub.online turns true while they are off, and when SATELLITE is pressed
// while the map is already showing. Nothing else asks again, so with no
// internet there is one failed check per visit. If the check fails, hangs
// or the photos keep failing, nothing else changes: the saved imagery
// stays, and note() says in one plain line why the map is blank outside it.
// Their tile errors never reach map-view.js's own failure count, so they
// can't switch the map to the dark map or the "No map" panel. When
// hub.online turns false they come off, so no request is left hanging.
// Where a saved photo covers a whole tile, the online layer doesn't ask
// Esri for that tile at all.
//
// Usage (map-view.js, launch page only):
//   const bg = createLaunchBackground({ L, map, config, hub, labelsPane, onChange });
//   bg.credits()      the credit lines for what is on the map now (HTML)
//   bg.note()         one line for the map's notes, or ''
//   bg.status()       counts for hub.parts.map2d.status() and the tests
//   bg.retryOnline()  try the online layers again now (SATELLITE pressed
//                     while the map shows)
//   bg.destroy()
//
// Used by: map-view.js. The tile math and the photo choice touch no page
// elements, so Node can test them (test/offline-leaflet.test.mjs).

import { checkEsriKey, createSatelliteLayer, boxTileMethods, placePhoto } from '../views/esri.js?v=3';
import { createOfflineTiles } from './offline-tiles.js';

// How many times one tile falls back to a zoom further out after a saved
// file turned out to be missing. More than there are zooms, so every saved
// zoom above gets its turn. It is not a retry: each step asks for a
// different file, a file found missing is never asked for again, and the
// steps end at the farthest zoom. (1 would leave a hole where two zooms in
// a row are missing, and that is the usual case: download_tiles.py saves
// the smallest levels first, so a download stopped early is missing its
// biggest ones, zoom 16 and often zoom 17, while its manifest still lists
// them.)
const MISSING_FALLBACK_STEPS = 24;
// Less than this much (px) of a tile inside the saved box counts as none of
// it, and a cut smaller than this counts as no cut. The box's edges sit a
// hair inside the saved tiles' own edges (offline-tiles.js), so without
// this every tile just outside the box would be asked for a sliver.
const EDGE_PX = 0.5;
// Each tile's box is this much (px) wider and taller than the tile, to hide
// seams (.fc-sat-tiles in flight-console-map.css). A cut on the right or
// the bottom has to allow for it.
const SEAM_PX = 0.5;
// The saved layer sits above the online photos, in the same map pane.
const ONLINE_Z = 1;
const SAVED_Z = 2;

// ------------------------------------------------------------------
// Tile math and the photo choice (no page elements)
// ------------------------------------------------------------------

// Where a longitude or latitude falls, in tiles of zoom z from the west or
// north edge of the world (the usual web map layout, fractions included).
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;

// How much of the tile at coords ({ z, x, y }) is inside bounds
// ({ south, west, north, east }), as the px to cut off each side of a tile
// `size` px across: { left, top, right, bottom, whole }. whole is true when
// nothing is cut. null when the tile is outside.
export function clipToBox(bounds, coords, size = 256) {
  const left = Math.max(0, (tileX(bounds.west, coords.z) - coords.x) * size);
  const right = Math.max(0, (coords.x + 1 - tileX(bounds.east, coords.z)) * size);
  const top = Math.max(0, (tileY(bounds.north, coords.z) - coords.y) * size);
  const bottom = Math.max(0, (coords.y + 1 - tileY(bounds.south, coords.z)) * size);
  if (size - left - right < EDGE_PX || size - top - bottom < EDGE_PX) return null;
  const snap = (px) => (px < EDGE_PX ? 0 : Math.round(px * 10) / 10);
  const clip = { left: snap(left), top: snap(top), right: snap(right), bottom: snap(bottom) };
  clip.whole = !(clip.left || clip.top || clip.right || clip.bottom);
  return clip;
}

// The saved photo for the tile at coords: { z, x, y } of the closest saved
// tile over its ground, looking from zoom `from` (the tile's own unless
// given) outward, and skipping the files isMissing(z, x, y) says aren't
// there. null when nothing is saved for that ground.
export function pickPhoto(tiles, coords, isMissing = () => false, from = coords.z) {
  let at = from;
  while (at >= tiles.minZoom) {
    const z = tiles.deepest(coords.z, coords.x, coords.y, at);
    if (z === null) return null;
    const photo = tiles.parent(coords.z, coords.x, coords.y, z);
    if (!isMissing(photo.z, photo.x, photo.y)) return photo;
    at = z - 1;
  }
  return null;
}

// The credit comes from the manifest and goes into the page as HTML.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// ------------------------------------------------------------------
// The saved imagery layer
// ------------------------------------------------------------------

// A Leaflet layer for the saved photos (L is Leaflet, tiles is
// createOfflineTiles()'s answer with its bounds, options the usual
// L.gridLayer options). onHole() runs the first time a tile inside the box
// ends with no photo at all.
//
// The layer keeps its numbers and one question for the online layer in
// layer.fcSaved:
//   counts          { loaded, failed, empty, fellBack, missingFiles }
//                   loaded and failed and empty count tiles: a photo on
//                   screen, a tile inside the box left with none, and a
//                   tile outside the box. fellBack counts the loaded tiles
//                   that show a zoom further out because a file was
//                   missing. missingFiles counts those files.
//   covers(coords)  true when a saved photo will fill that whole tile, so
//                   nothing under it can be seen
export function createSavedLayer(L, tiles, options = {}, { onHole } = {}) {
  const counts = { loaded: 0, failed: 0, empty: 0, fellBack: 0, missingFiles: 0 };
  // The saved files that turned out not to be there, as "z/x/y".
  const missing = new Set();
  const isMissing = (z, x, y) => missing.has(`${z}/${x}/${y}`);
  let holes = false;
  const hole = () => {
    counts.failed += 1;
    if (holes) return;
    holes = true;
    onHole?.();
  };

  const SavedLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const box = document.createElement('div');
      const size = this.getTileSize();
      const clip = clipToBox(tiles.bounds, coords, size.x);
      const first = clip ? pickPhoto(tiles, coords, isMissing) : null;
      if (!first) {
        // Outside the box, or (it shouldn't happen) inside it with nothing
        // saved. Either way an empty box, and no request. Leaflet wants to
        // hear about it after this function has returned.
        if (clip) hole();
        else counts.empty += 1;
        setTimeout(() => done(null, box), 0);
        return box;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      box.append(img);
      // finished: a photo loaded, or the tile gave up. dropped: the map let
      // go of the tile (drop() in esri.js).
      const tile = { img, finished: false, dropped: false };
      box.fcTile = tile;
      if (!clip.whole) {
        const far = (px) => (px ? px + SEAM_PX : 0);
        box.style.clipPath = `inset(${clip.top}px ${far(clip.right)}px ${far(clip.bottom)}px ${clip.left}px)`;
      }
      const show = (photo, steps) => {
        if (tile.dropped) return;
        placePhoto(img, coords, photo.z, size);
        img.onload = () => {
          tile.finished = true;
          counts.loaded += 1;
          if (steps > 0) counts.fellBack += 1;
          done(null, box);
        };
        img.onerror = () => {
          // The file isn't there. Remember that, and show the next saved
          // zoom above instead.
          const key = `${photo.z}/${photo.x}/${photo.y}`;
          if (!missing.has(key)) {
            missing.add(key);
            counts.missingFiles += 1;
          }
          const next = steps < MISSING_FALLBACK_STEPS ? pickPhoto(tiles, coords, isMissing, photo.z - 1) : null;
          if (next) {
            show(next, steps + 1);
            return;
          }
          // Nothing left to show: an empty box, and no error for Leaflet.
          tile.finished = true;
          img.onload = null;
          img.onerror = null;
          img.remove();
          hole();
          done(null, box);
        };
        img.src = tiles.url(photo.z, photo.x, photo.y);
      };
      show(first, 0);
      return box;
    },

    ...boxTileMethods(L),
  });

  const layer = new SavedLayer(options);
  layer.fcSaved = {
    counts,
    // Once any tile inside the box has ended empty, the saved layer can't
    // promise anything, so the online layer loads everywhere again.
    covers(coords) {
      if (holes) return false;
      const clip = clipToBox(tiles.bounds, coords);
      return Boolean(clip?.whole && pickPhoto(tiles, coords, isMissing));
    },
  };
  return layer;
}

// ------------------------------------------------------------------
// The whole background
// ------------------------------------------------------------------

// Counts a layer's tiles the way map-view.js's watchTiles() does: more than
// TILE_FAIL_COUNT errors with nothing loaded within TILE_FAIL_TIMEOUT_MS
// means the layer can't be reached, and onFail() runs once.
function failWatch(config, onFail) {
  let errors = 0;
  let loads = 0;
  let windowOver = false;
  let stopped = false;
  const check = () => {
    if (stopped || !windowOver || loads > 0 || errors <= config.TILE_FAIL_COUNT) return;
    stopped = true;
    onFail();
  };
  const timer = setTimeout(() => { windowOver = true; check(); }, config.TILE_FAIL_TIMEOUT_MS);
  return {
    load() { loads += 1; },
    error() { errors += 1; check(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

// Puts the launch page's background on a Leaflet map and keeps it right as
// the internet comes and goes.
//   L, map       Leaflet and the map
//   config       js/config.js
//   hub          launch mode's hub (settings and online are read)
//   labelsPane   the map pane Esri's place names go in
//   onChange()   runs when the layers, the credits or the note changed
//   parts        only for the tests: { checkKey } in place of the real
//                Esri key check
export function createLaunchBackground({ L, map, config, hub, labelsPane, onChange = () => {}, parts = {} }) {
  const checkKey = parts.checkKey ?? (() => checkEsriKey(config));
  // Saved imagery with no box to keep it in is left out: its far zooms
  // would cover the whole world.
  const everything = createOfflineTiles(hub.settings);
  const tiles = everything?.bounds ? everything : null;

  let destroyed = false;
  let saved = null;      // the saved imagery layer
  let online = null;     // Esri's photos, while they are on
  let labels = null;     // Esri's place names, while they are on
  let checking = false;  // a key check is on its way
  let settled = false;   // the first key check has answered (or there was none to make)
  let keyAccepted = null;
  const counts = { keyChecks: 0, onlineLoaded: 0, onlineFailed: 0, onlineSkipped: 0 };

  // The saved imagery goes on first, and waits for nothing.
  if (tiles) {
    saved = createSavedLayer(L, tiles, {
      minZoom: tiles.minZoom,
      maxZoom: config.TILE_MAX_ZOOM,
      // Zoomed in closer than the closest saved zoom, Leaflet scales that
      // zoom's tiles up.
      maxNativeZoom: tiles.maxZoom,
      zIndex: SAVED_Z,
      // fc-sat-tiles: the CSS that sizes each tile's box (as for Esri's).
      className: 'fc-sat-tiles fc-saved-tiles',
    }, {
      // A hole in the saved imagery: let the online photos show through.
      onHole: () => online?.redraw(),
    });
    saved.addTo(map);
  }

  function onlineOff() {
    online?.remove();
    labels?.remove();
    online = null;
    labels = null;
  }

  // Esri's place names, over everything. If they keep failing they come
  // off again, and nothing is said.
  function addLabels() {
    const layer = L.tileLayer(config.SATELLITE_LABELS_URL, {
      key: encodeURIComponent(config.ESRI_API_KEY),
      pane: labelsPane,
      // 512 px tiles, one zoom level behind (see addLabels in map-view.js).
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: config.TILE_MAX_ZOOM,
    });
    const watch = failWatch(config, () => {
      if (destroyed || labels !== layer) return;
      layer.remove();
      labels = null;
      onChange();
    });
    layer.on('tileload', watch.load);
    layer.on('tileerror', watch.error);
    layer.on('remove', watch.stop);
    labels = layer;
    layer.addTo(map);
  }

  // Esri said yes: its photos go on under the saved imagery.
  function onlineOn() {
    if (online) return;
    const layer = createSatelliteLayer(L, config, {
      key: encodeURIComponent(config.ESRI_API_KEY),
      maxZoom: config.TILE_MAX_ZOOM,
      maxNativeZoom: config.SATELLITE_MAX_NATIVE_ZOOM,
      zIndex: ONLINE_Z,
      className: 'fc-sat-tiles',
    });
    // The photos keep failing: off they come, quietly. hub.online is asked
    // to look again, and they are tried again when it next turns true.
    const watch = failWatch(config, () => {
      if (destroyed || online !== layer) return;
      onlineOff();
      hub.online.check();
      onChange();
    });
    // A tile the saved imagery covers completely asks Esri for nothing.
    // The rest are counted here (not by Leaflet's events, which would
    // count the skipped ones as loaded).
    const createTile = layer.createTile;
    layer.createTile = function (coords, done) {
      if (saved?.fcSaved.covers(coords)) {
        counts.onlineSkipped += 1;
        const box = document.createElement('div');
        setTimeout(() => done(null, box), 0);
        return box;
      }
      return createTile.call(this, coords, (err, el) => {
        if (err) {
          counts.onlineFailed += 1;
          watch.error();
        } else {
          counts.onlineLoaded += 1;
          watch.load();
        }
        done(err, el);
      });
    };
    layer.on('remove', watch.stop);
    online = layer;
    layer.addTo(map);
    addLabels();
  }

  // Asks Esri whether it takes the key (esri.js: one request, given up
  // after TILE_FAIL_TIMEOUT_MS, and a yes is kept for the visit). Nothing
  // waits on the answer.
  function tryOnline() {
    if (destroyed || online || checking) return;
    // With no key, or with Wi-Fi off (the browser already knows), nothing
    // is sent.
    if (!config.ESRI_API_KEY || globalThis.navigator?.onLine === false) {
      settled = true;
      return;
    }
    checking = true;
    counts.keyChecks += 1;
    Promise.resolve(checkKey()).catch(() => false).then((ok) => {
      checking = false;
      settled = true;
      if (destroyed) return;
      keyAccepted = Boolean(ok);
      if (ok) onlineOn();
      onChange();
    });
  }

  const stopWatching = hub.online.onChange((isOnline) => {
    if (destroyed) return;
    if (isOnline) tryOnline();
    else onlineOff();
    onChange();
  });
  // The first try, right away. It doesn't wait for hub.online's own check.
  tryOnline();

  // Whether everything in view is inside the saved box.
  function viewInsideSaved() {
    if (!tiles) return false;
    const view = map.getBounds();
    const box = tiles.bounds;
    return view.getSouth() >= box.south && view.getNorth() <= box.north && view.getWest() >= box.west && view.getEast() <= box.east;
  }

  return {
    // The credit lines for the layers on the map right now, as HTML.
    credits() {
      const lines = [];
      if (saved && tiles.credit) lines.push(escapeHtml(tiles.credit));
      if (online) lines.push(config.ESRI_POWERED_BY, config.SATELLITE_ATTRIBUTION);
      if (labels) lines.push(config.SATELLITE_LABELS_ATTRIBUTION);
      return lines;
    },

    // One plain line for the map's notes while part of the view has no
    // imagery, or ''. Nothing while the first key check is still out, and
    // nothing while the whole view is inside the saved imagery.
    note() {
      if (online || !settled) return '';
      const internet = hub.online.get();
      if (!saved) {
        return internet
          ? 'Online imagery isn\'t available right now and there is no saved imagery, so the map is blank. Tracking still works.'
          : 'No internet and no saved imagery, so the map is blank. Tracking still works.';
      }
      if (viewInsideSaved()) return '';
      return internet
        ? 'Online imagery isn\'t available right now, so the map shows the saved imagery and nothing outside it.'
        : 'No internet, so the map shows the saved imagery and nothing outside it.';
    },

    status() {
      const s = saved?.fcSaved.counts;
      return {
        savedLayerOn: Boolean(saved && map.hasLayer(saved)),
        savedLoaded: s?.loaded ?? 0,
        savedFailed: s?.failed ?? 0,
        savedEmpty: s?.empty ?? 0,
        savedFellBack: s?.fellBack ?? 0,
        savedMissingFiles: s?.missingFiles ?? 0,
        savedBounds: tiles?.bounds ?? null,
        savedZooms: tiles ? { min: tiles.minZoom, max: tiles.maxZoom } : null,
        onlineLayerOn: Boolean(online && map.hasLayer(online)),
        onlineLoaded: counts.onlineLoaded,
        onlineFailed: counts.onlineFailed,
        onlineSkipped: counts.onlineSkipped,
        labelsOn: Boolean(labels && map.hasLayer(labels)),
        keyChecks: counts.keyChecks,
        keyChecking: checking,
        keyAccepted,
      };
    },

    // A press on SATELLITE while the online layers are off: ask again now.
    retryOnline() {
      if (destroyed || online) return;
      hub.online.check();
      tryOnline();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopWatching();
      onlineOff();
      saved?.remove();
      saved = null;
    },
  };
}
