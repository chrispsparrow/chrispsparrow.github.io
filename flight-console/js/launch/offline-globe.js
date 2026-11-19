// offline-globe.js: the ground the 3D view draws on the launch page, where
// nothing may wait on the internet. The normal page never loads this file.
// There the 3D view (js/views/globe-view.js) uses Cesium ion's imagery and
// terrain, as it always has.
//
// On the launch page the ground is built from three things, bottom to top:
//   1. Plain ground: one flat color over the whole Earth. It is what shows
//      outside the saved map when there is no internet.
//   2. Esri's satellite photos from the internet, only once Esri has
//      accepted the key from this page. With no internet this layer is
//      never added. Nothing else waits for it.
//   3. The saved map tiles (offline-maps/<field>/, see offline-tiles.js):
//      one layer per group of saved zoom levels, the closest on top. Past
//      the closest saved zoom Cesium scales the closest photo up by itself.
//
// The plain ground is a real layer, not just the globe's color, for two
// reasons. Cesium stretches the edge of its bottom layer over the rest of
// the Earth, which would smear the saved map's edge out to the horizon.
// And a piece of ground with one layer loaded can be drawn while the
// others are still on their way, so a dead internet connection can never
// hold back the saved map.
//
// A saved tile that turns out to be missing (the download was stopped
// early) is counted and left out. Cesium then draws the tile above it,
// scaled up. It is never asked for twice in a row and nothing is logged for
// it, apart from the browser's own line about a file that wasn't found.
// So inside the saved box a hole shows the closest saved photo above it,
// never Esri's: the saved layers cover Esri's everywhere inside the box.
// That is also why Esri is never asked for a tile that lies wholly inside
// the box. On a phone's connection at the field that saves most of what
// the opening view would otherwise download, for nothing anyone could see.
//
// What is here:
//   GROUND_COLOR_VAR, GROUND_COLOR_FALLBACK   the plain ground's color
//   openingView(settings, station)   where the 3D view looks when the
//                                    launch page opens
//   savedLayerPlan(settings)         the saved layers to make, far to near
//   onlineLayerPlan(config)          the Esri layer to make
//   tileInside(level, x, y, rect)    whether a map tile lies wholly
//                                    inside a rectangle
//   guardRequests(provider, ...)     counts a layer's tiles and keeps
//                                    missing ones quiet
//   createGlobeGround(...)           builds the layers on a Cesium viewer
//                                    and keeps them up to date
//
// Everything above createGlobeGround() needs no page and no Cesium, so
// Node can test it (test/offline-globe.test.mjs).
//
// Used by: js/views/globe-view.js (map-view.js loads this file for it on
// the launch page).

import { createOfflineTiles } from './offline-tiles.js';

// The plain ground's color: a CSS variable set in flight-console-launch.css
// (a calm slate between the page's near-black and its off-white), and the
// color used if that stylesheet didn't load.
export const GROUND_COLOR_VAR = '--fc-launch-ground';
export const GROUND_COLOR_FALLBACK = '#3D3E45';

// The closest zoom asked of Esri. Esri has photos this close around the
// field, and the saved map is no closer either. A place where Esri has
// less just shows the closest photo it has, scaled up.
export const ONLINE_MAX_LEVEL = 18;
// How long (ms) to wait before asking Esri about the key again, after a no
// that came while the internet seemed to be up.
const KEY_RETRY_MS = 60000;

// The opening view: the camera looks at the field from this far (m), tilted
// down this much (degrees), facing north. From there the view shows the pad
// area and one to two kilometers around it, all inside the closest saved
// zoom.
export const OPENING_RANGE_M = 3200;
export const OPENING_PITCH_DEG = -30;
export const OPENING_HEADING_DEG = 0;

const validSpot = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// Where the 3D view looks when the launch page opens, and where RESET VIEW
// returns to while there is no rocket on screen: the field's center from
// launch-mode/field.json. If that file didn't load, the ground station
// (station, { lat, lon } or null). With neither there is nothing to open
// on, and this returns null.
export function openingView(settings, station) {
  const center = settings?.field?.center;
  const at = validSpot(center) ? center : validSpot(station) ? station : null;
  if (!at) return null;
  return { lat: at.lat, lon: at.lon, rangeM: OPENING_RANGE_M, pitchDeg: OPENING_PITCH_DEG, headingDeg: OPENING_HEADING_DEG };
}

// The saved layers to make, far to near (so the last one goes on top):
//   { url, rect: { south, west, north, east }, maxLevel, credit }
// and allow(level, x, y), which says whether a tile is worth asking for.
//
// offline-tiles.js groups the saved zoom levels by the ground they cover.
// Two things are added here, for a download that hasn't finished:
//   - A zoom level the manifest says has no tiles yet (saved: 0) is never
//     asked for. A group's layer stops at its closest zoom that has tiles,
//     and a group that adds no closer zoom than the one under it is left
//     out.
//   - A tile the manifest lists as missing is never asked for.
// Returns { layers: [], allow, offline: null } when nothing is saved.
export function savedLayerPlan(settings) {
  const offline = createOfflineTiles(settings);
  if (!offline) return { layers: [], allow: () => false, offline: null };

  const empty = new Set();
  for (const lv of settings.manifest.levels) {
    if (Number.isInteger(lv.z) && lv.saved === 0) empty.add(lv.z);
  }
  // The address pattern with Cesium's own {z}, {x} and {y} left in.
  const url = offline.url('{z}', '{x}', '{y}');
  const layers = [];
  let deepest = -1;
  for (const stack of offline.stacks) {
    let maxLevel = stack.maxZoom;
    while (maxLevel >= 0 && empty.has(maxLevel)) maxLevel -= 1;
    if (maxLevel <= deepest) continue;
    deepest = maxLevel;
    layers.push({ url, rect: { ...stack.rect }, maxLevel, credit: offline.credit });
  }
  const allow = (level, x, y) => !empty.has(level) && offline.has(level, x, y);
  return { layers, allow, offline };
}

// The Esri layer to make: { url, maxLevel, credit, poweredBy }. The key
// goes into the address here, so Cesium only has {z}, {y} and {x} to fill
// in. Returns null when the page has no key.
export function onlineLayerPlan(config) {
  if (!config?.ESRI_API_KEY || !config.SATELLITE_URL) return null;
  return {
    url: config.SATELLITE_URL.replace('{key}', encodeURIComponent(config.ESRI_API_KEY)),
    maxLevel: ONLINE_MAX_LEVEL,
    credit: String(config.SATELLITE_ATTRIBUTION ?? ''),
    poweredBy: String(config.ESRI_POWERED_BY ?? ''),
  };
}

// True when the web map tile (level, x, y) lies wholly inside rect
// ({ south, west, north, east } in degrees). The tiles are the usual web
// map layout, the one Cesium's WebMercatorTilingScheme uses: x from the
// west, y from the north.
export function tileInside(level, x, y, rect) {
  if (!rect) return false;
  const n = 2 ** level;
  const lon = (col) => (col / n) * 360 - 180;
  const lat = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return lon(x) >= rect.west && lon(x + 1) <= rect.east && lat(y + 1) >= rect.south && lat(y) <= rect.north;
}

// Counts the tiles a layer's provider loads and fails, and keeps a missing
// tile quiet. Cesium asks a provider for each tile with
// requestImage(x, y, level, request).
//   counts        { loaded, failed, skipped, pending }, added to here
//   allow         (level, x, y) -> false for a tile not to ask for: a saved
//                 tile known to be missing, or an Esri tile hidden under
//                 the saved map. It is turned down at once, with no
//                 request at all, and counted as skipped.
//   isCancelled   (request) -> true when Cesium itself dropped the request
//                 (it does that to tiles the camera has moved away from,
//                 and asks again later), so it isn't counted as failed
//   onSettle      called after each tile is in, failed or turned down. The
//                 3D view only draws when asked, and a tile turned down
//                 here never goes through Cesium's own requests, which is
//                 what normally asks for the next frame.
// Listening to the provider's errorEvent is what keeps Cesium from logging
// every failed tile. A failed tile isn't tried again: Cesium only retries
// when a listener asks it to, and this one doesn't.
export function guardRequests(provider, { counts, allow = () => true, isCancelled = () => false, onSettle = () => {} }) {
  const request = provider.requestImage;
  provider.requestImage = function (x, y, level, req, ...rest) {
    if (!allow(level, x, y)) {
      counts.skipped += 1;
      // (Cesium handles this rejection itself: the tile counts as failed
      // and the one above it is drawn in its place.)
      const turnedDown = Promise.reject(new Error(`Tile ${level}/${x}/${y} is not asked for`));
      turnedDown.catch(() => onSettle());
      return turnedDown;
    }
    const promise = request.call(this, x, y, level, req, ...rest);
    // (Nothing came back: Cesium has too many requests on their way and
    // will ask again.)
    if (typeof promise?.then !== 'function') return promise;
    counts.pending += 1;
    promise.then(() => {
      counts.pending -= 1;
      counts.loaded += 1;
      onSettle();
    }, () => {
      counts.pending -= 1;
      if (!isCancelled(req)) counts.failed += 1;
      onSettle();
    });
    return promise;
  };
  provider.errorEvent?.addEventListener(() => {});
  return provider;
}

// ------------------------------------------------------------------
// The layers, on a Cesium viewer
// ------------------------------------------------------------------

// Builds the ground on viewer (a Cesium.Viewer made with no base layer).
//   C              the Cesium library
//   settings       hub.settings from launch-mode.js (null is fine)
//   online         hub.online from launch-mode.js: get() and onChange(fn)
//   config         js/config.js (the Esri address, key and credits)
//   checkEsriKey   esri.js's key check: (config) -> a promise of true or false
//   groundColor    the plain ground's color, a CSS color string
//   onChange       called when a layer was added or a tile settled, so the
//                  view can draw again
// Returns:
//   savedLayers          how many saved layers were made
//   allowOnline()        from now on the Esri layer may be added. The 3D
//                        view calls it once its first picture with the
//                        saved map is in, so that picture never waits for
//                        tiles from the internet.
//   status()             the numbers for hub.parts.globe.status()
//   destroy()            stops listening. (The viewer destroys the layers.)
export function createGlobeGround({ C, viewer, settings, online, config, checkEsriKey, groundColor, onChange = () => {} }) {
  const layers = viewer.imageryLayers;
  const saved = { loaded: 0, failed: 0, skipped: 0, pending: 0 };
  const net = { loaded: 0, failed: 0, skipped: 0, pending: 0 };
  const isCancelled = (request) => request?.state === C.RequestState.CANCELLED;
  let destroyed = false;

  // 1. Plain ground: one small picture of the ground color, laid over the
  // whole Earth. It is made here from a canvas, so there is nothing to
  // download.
  let plain = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const g = canvas.getContext('2d');
    g.fillStyle = groundColor;
    g.fillRect(0, 0, 4, 4);
    plain = layers.addImageryProvider(new C.SingleTileImageryProvider({ url: canvas.toDataURL('image/png'), tileWidth: 4, tileHeight: 4 }), 0);
  } catch (err) {
    // Without it the globe's own color still shows (the same color). Only
    // the saved map's edge may look stretched.
    console.warn('Launch mode: the 3D view\'s plain ground could not be made', err);
  }

  // 3. The saved map, far to near. (Made before the Esri layer, which
  // slides in under these when it comes.)
  const plan = savedLayerPlan(settings);
  let savedLayers = 0;
  for (const item of plan.layers) {
    try {
      const provider = new C.UrlTemplateImageryProvider({
        url: item.url,
        tilingScheme: new C.WebMercatorTilingScheme(),
        rectangle: C.Rectangle.fromDegrees(item.rect.west, item.rect.south, item.rect.east, item.rect.north),
        minimumLevel: 0,
        maximumLevel: item.maxLevel,
        credit: item.credit ? new C.Credit(item.credit, true) : undefined,
        enablePickFeatures: false,
      });
      guardRequests(provider, { counts: saved, allow: plan.allow, isCancelled, onSettle: onChange });
      layers.addImageryProvider(provider);
      savedLayers += 1;
    } catch (err) {
      console.warn('Launch mode: a saved map layer could not be added to the 3D view', err);
    }
  }

  // 2. Esri's photos. The key is checked when the view starts, again each
  // time the internet comes back, and once a minute after a no that came
  // while the internet was up. The layer goes in once Esri has
  // said yes and the view has allowed it (allowOnline).
  const onlinePlan = onlineLayerPlan(config);
  const poweredBy = onlinePlan?.poweredBy ? new C.Credit(onlinePlan.poweredBy, true) : null;
  // The saved map's outer edge. Esri's tiles wholly inside it are hidden
  // under the saved layers, so they are never asked for (see the top of
  // this file).
  const savedBox = plan.layers[0]?.rect ?? null;
  const outsideSaved = (level, x, y) => !tileInside(level, x, y, savedBox);
  let onlineLayer = null;
  let onlineAllowed = false;
  let key = onlinePlan ? 'unknown' : 'none';   // 'none', 'unknown', 'checking', 'yes' or 'no'
  let failedAtStart = 0;                        // net.failed when the layer now showing was made

  let keyTimer = 0;
  function checkKey() {
    if (destroyed || !onlinePlan || key === 'yes' || key === 'checking') return;
    clearTimeout(keyTimer);
    key = 'checking';
    // checkEsriKey never throws and gives up by itself after a few seconds.
    Promise.resolve(checkEsriKey(config)).then((ok) => ok, () => false).then((ok) => {
      if (destroyed) return;
      key = ok ? 'yes' : 'no';
      addOnline();
      // A no while the internet answers (a slow or patchy connection) is
      // asked again now and then. With no internet the next try waits for
      // hub.online to say it is back.
      if (!ok && online?.get?.()) keyTimer = setTimeout(checkKey, KEY_RETRY_MS);
    });
  }

  function addOnline() {
    if (destroyed || onlineLayer || !onlineAllowed || key !== 'yes') return;
    try {
      const provider = new C.UrlTemplateImageryProvider({
        url: onlinePlan.url,
        tilingScheme: new C.WebMercatorTilingScheme(),
        minimumLevel: 0,
        maximumLevel: onlinePlan.maxLevel,
        credit: onlinePlan.credit ? new C.Credit(onlinePlan.credit) : undefined,
        enablePickFeatures: false,
      });
      guardRequests(provider, { counts: net, allow: outsideSaved, isCancelled, onSettle: onChange });
      // Right over the plain ground, under every saved layer.
      onlineLayer = layers.addImageryProvider(provider, plain ? 1 : 0);
      failedAtStart = net.failed;
      if (poweredBy) viewer.creditDisplay.addStaticCredit(poweredBy);
      onChange();
    } catch (err) {
      console.warn('Launch mode: Esri\'s imagery could not be added to the 3D view', err);
    }
  }

  // The internet is back. Cesium never asks twice for a tile that failed,
  // so if any failed while it was away, the Esri layer is made again and
  // asks for them afresh.
  function refreshOnline() {
    if (!onlineLayer || net.failed === failedAtStart) return;
    layers.remove(onlineLayer, true);
    onlineLayer = null;
    if (poweredBy) viewer.creditDisplay.removeStaticCredit(poweredBy);
    addOnline();
  }

  const stopOnline = online?.onChange?.((isOnline) => {
    if (destroyed || !isOnline) return;
    if (key === 'yes') refreshOnline();
    else checkKey();
  });
  checkKey();

  return {
    savedLayers,
    allowOnline() {
      if (onlineAllowed) return;
      onlineAllowed = true;
      addOnline();
    },
    status() {
      return {
        plainGround: Boolean(plain),
        savedLayers,
        savedMaxLevels: plan.layers.map((item) => item.maxLevel),
        savedLoaded: saved.loaded,
        savedFailed: saved.failed,
        savedSkipped: saved.skipped,
        savedPending: saved.pending,
        onlineKey: key,
        onlineLayerOn: Boolean(onlineLayer),
        onlineLoaded: net.loaded,
        onlineFailed: net.failed,
        onlineSkipped: net.skipped,
        onlinePending: net.pending,
      };
    },
    destroy() {
      destroyed = true;
      clearTimeout(keyTimer);
      stopOnline?.();
    },
  };
}
