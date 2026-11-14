// map-view.js
// The map's frame on Track a Rocket: the 3D view (globe-view.js) and the
// 2D map it falls back to, with everything that belongs to the map.
//
// The controls. One row, the same in every view: [ SATELLITE ] [ DARK MAP ]
// [ 3D ], [x] FOLLOW BOARD and [ KEY ], plus [ WHOLE FLIGHT ] and
// [ RESET VIEW ] while a saved flight is on screen. The active view is
// amber. This file builds the row and puts it in #fc-map-controls, the
// mount in the HUD layer (main.js and the HUD's CSS decide where it sits).
// If the page has no such mount, the row goes in the bottom left corner of
// this frame instead. KEY opens a legend upward from the row.
//
// The 3D view is where every visit starts (DEFAULT_VIEW in config.js).
// While it loads, the frame says "3D VIEWER LOADING..." with a blinking
// cursor. After THREE_SLOW_MS, or as soon as it fails, it adds "CHECK YOUR
// INTERNET CONNECTION" and a [ BACK TO THE MAP ] button. If the 3D view
// still turns up after that, it takes over. While it loads, the frame
// keeps showing what it already showed (the 2D map, when the viewer came
// from it).
//
// The 2D map (Leaflet) has the same things on it as the 3D view, minus
// the ground shadow (the 2D path is already flat): the breadcrumbs (a dot
// per fix in its speed color, a hollow grey ring for a weak fix, and a thin
// line through the good fixes that breaks where packets were missed), the
// board marker with its packet ring, the launch point, Manta's dish, the
// radio link with its traveling dot, the event diamonds and the recovery
// crosshair. The breadcrumbs are painted on one canvas, so a long flight
// stays quick. Two backgrounds: Esri satellite imagery (with Esri's place
// labels on top) and CARTO's dark map. The browser remembers the viewer's
// choice. If Esri turns the key down or the imagery keeps failing, the map
// shows the dark map and says so. The key check is shared by every map in
// the visit (esri.js).
//
// The names next to the markers ("DOGTOOTH", "MANTA", "LAUNCH POINT",
// "APOGEE 3,012 M") are drawn by one label layer (map-labels.js) that both
// views feed.
//
// Bottom right belongs to this frame: the map's notes, the scale bar and
// the map credits (Cesium's or Leaflet's, both required), kept above the
// timeline and anything else the HUD puts down there.
//
// One view for the whole visit. main.js can make this view once and keep
// it while the page moves between live data and saved flights, with a
// store switch (store-switch.js) as ctx.store. A store change of type
// 'source' means: forget everything drawn for the old store and draw the
// new one from scratch, flying to its site. ctx.session (live or replay,
// still loading or not) is read fresh on every draw for the same reason.
// A view made per screen on a plain store works too.
//
// The HUD's blocks are marked data-fc-cover. They count as covered parts
// of the view: WHOLE FLIGHT frames the path in what they leave free, and
// FOLLOW BOARD keeps the board clear of them.
//
// If Leaflet didn't load, or the map tiles keep failing, the map is
// replaced by a "No map" panel with each rocket's position, distance and
// bearing, and an arrow. Tracking keeps working either way.
//
// Used by: main.js. Reads the store, and the 3D view it starts (for its
// notes and camera mode). Never other views.

import { h, svg, setText, setChildren, createScheduler, prefersReducedMotion } from './dom.js';
import { rangeAndBearing, formatRangeBearing, formatAge, formatNumber, MISSING } from '../geo.js';
import { iconNode } from './icons.js?v=2';
import {
  boardSvg, BOARD_FOCUSED, BOARD_OTHER, startSvg, START_SIZE, dishSvg, DISH_SIZE, DISH_ANCHOR,
  diamondSvg, DIAMOND_SIZE, crosshairSvg, CROSSHAIR_SIZE, pathKeySvg, weakKeySvg, shadowKeySvg, linkKeySvg,
  DOT_PX, DOT_OUTLINE_PX, WEAK_DOT_PX, WEAK_LINE_PX, WEAK_COLOR, LINE_PX, LINE_OUTLINE_PX, OTHER_LINE_PX, OTHER_DOT_PX,
  NEAR_BLACK, WHITE, RING_MS, RING_FROM_SCALE, LINK_COLOR, LINK_ALPHA, LINK_PX, LINK_DASH_PX, LINK_TRAVEL_MS,
} from './markers.js';
import { checkEsriKey } from './esri.js';
import { loadCesium } from './cesium-loader.js';
import { createLabelLayer, LABEL_NAMES, LABEL_PRIORITY, apogeeLabel } from './map-labels.js';
import { speedColor } from '../track.js';
import { flightState, eventCrumb, recoveryInfo, STATE } from '../flight-state.js';

// Leaflet's own separator between credits.
const CREDIT_SEP = ' <span aria-hidden="true">|</span> ';
// How long (ms) the 3D view gets before the loading message adds "CHECK
// YOUR INTERNET CONNECTION" and the way back to the map.
const THREE_SLOW_MS = 10000;
// After the 3D view failed to download, it is tried again this often (ms)
// while the viewer stays on it, so it takes over once the internet is back.
const THREE_RETRY_MS = 15000;
// The events that get a diamond. Liftoff has none, since the launch point
// marks it.
const EVENT_TYPES = ['apogee', 'drogue', 'main', 'landed'];
// The launch point's dot sits with its middle on the spot.
const START_ANCHOR = [START_SIZE / 2, START_SIZE / 2];
// Room (px) the first view keeps between a marker and the map's edge or a
// covered area, when FIT_PADDING_PX doesn't fit.
const FIT_ROOM_PX = 12;
// The first view zooms out at most to here.
const FIT_MIN_ZOOM = 3;
// WHOLE FLIGHT keeps this much room (px) between the path and the edge of
// the part of the view nothing covers, in both views, so the markers fit.
const WHOLE_ROOM_PX = 28;
// Leaflet stacks markers by screen height plus this offset. These keep the
// focused board on top, then the other boards, the event markers, Manta
// and the launch points.
const Z_OFFSET = { pad: 0, gs: 10000, event: 15000, rocket: 20000, travel: 25000, focused: 30000 };
// How long (ms) FOLLOW BOARD waits after starting a pan before it checks again.
const FOLLOW_PAN_MS = 600;
// Leaflet starts an animated zoom a frame after it is asked for. A zoom
// that starts this soon (ms) after the map moved itself counts as its own,
// not the viewer's.
const OWN_MOVE_MS = 1200;
// Where the map waits before the first position when there is no ground
// station to start on: most of the world, until the first view fits.
const NO_STATION_CENTER = [20, 0];
const NO_STATION_ZOOM = 2;
// On the 2D map the labels fade out below this zoom (zoomed far out).
const LABEL_FAR_ZOOM = 11;
// The scale bar is at most this long (px), and as long as the roundest
// distance that fits.
const SCALE_MAX_PX = 96;
// The breadcrumb canvas reaches this share of the view past each edge, so
// a short drag shows no empty edge before it is painted again.
const TRACK_PADDING = 0.5;

const isLayer = (value) => value === 'satellite' || value === 'dark';

// The view the viewer last picked, 'map' or '3d', or null before they have
// picked one. It lasts for this visit only, so every visit starts on
// DEFAULT_VIEW.
let chosenView = null;

export function createMapView(root, ctx) {
  const { store, config, libs } = ctx;
  // What is on screen. main.js changes it while this view lives on, so it
  // is read fresh every time.
  const session = () => ctx.session ?? {};
  const isReplay = () => session().kind === 'replay';

  // ------------------------------------------------------------------
  // Page elements
  // ------------------------------------------------------------------
  const canvas = h('div', { class: 'fc-map-canvas', role: 'region', 'aria-label': 'Map of the board\'s path' });
  const waitBox = h('div', { class: 'fc-map-wait' }, 'LOADING THE MAP...');

  // The controls row. Satellite and Dark map are the two map backgrounds,
  // and 3D swaps the map for the 3D view.
  const satelliteBtn = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', 'aria-pressed': 'false', onclick: () => selectLayer('satellite') }, 'SATELLITE');
  const darkBtn = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', 'aria-pressed': 'false', onclick: () => selectLayer('dark') }, 'DARK MAP');
  const threeBtn = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', 'aria-pressed': 'false', onclick: () => selectThree() }, '3D');
  const viewPick = h('div', { class: 'fc-map-ctl-group', role: 'group', 'aria-label': 'Map view' }, satelliteBtn, darkBtn, threeBtn);
  // FOLLOW BOARD: one setting for both views.
  const followBox = h('input', { type: 'checkbox', checked: true, onchange: () => { setFollow(followBox.checked); scheduler.schedule(); } });
  const followLabel = h('label', { class: 'fc-bkt-check' }, followBox, h('span', {}, 'FOLLOW BOARD'));
  // The camera buttons, only while a saved flight is on screen.
  const wholeBtn = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', 'aria-pressed': 'false', onclick: () => showWholeFlight() }, 'WHOLE FLIGHT');
  const resetBtn = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => resetView() }, 'RESET VIEW');
  const cameraPick = h('div', { class: 'fc-map-ctl-group', role: 'group', 'aria-label': 'Camera', hidden: true }, wholeBtn, resetBtn);

  // The KEY: a legend for every marker and line, behind a toggle. Closed
  // at first. It opens upward from the row.
  const legendStationText = h('span', {}, LABEL_NAMES.station);
  const legendShadowRow = legendRow(iconNode(shadowKeySvg()), 'GROUND SHADOW (3D)');
  const legendStationRows = [
    legendRow(iconNode(dishSvg()), legendStationText),
    legendRow(iconNode(linkKeySvg()), 'RADIO LINK TO MANTA'),
  ];
  const legend = h('div', { class: 'fc-map-legend' },
    legendRow(iconNode(boardSvg(BOARD_FOCUSED)), 'DOGTOOTH BOARD'),
    legendRow(iconNode(boardSvg(BOARD_FOCUSED, { hollow: true })), 'NO GOOD FIX RIGHT NOW'),
    legendRow(iconNode(pathKeySvg()), 'GOOD FIX AND PATH, SLOW TO FAST'),
    legendRow(iconNode(weakKeySvg()), 'WEAK FIX, LEFT OFF THE PATH'),
    legendShadowRow,
    legendRow(iconNode(startSvg()), LABEL_NAMES.pad),
    ...legendStationRows,
    legendRow(iconNode(diamondSvg()), 'APOGEE, DROGUE, MAIN, LANDED'),
    legendRow(iconNode(crosshairSvg()), 'RECOVERY POSITION'));
  const keyBox = h('details', { class: 'fc-map-key' },
    h('summary', { class: 'fc-bkt fc-bkt--sm fc-map-key-toggle' }, 'KEY'),
    legend);

  const controls = h('div', { class: 'fc-map-ctl' }, viewPick, followLabel, keyBox, cameraPick);
  // The row goes in the HUD layer's mount. Without one, it goes in the
  // frame's own bottom left corner.
  const mount = document.getElementById('fc-map-controls');
  const ownCorner = mount ? null : h('div', { class: 'fc-map-ctl-own' });
  (mount ?? ownCorner).append(controls);

  // The 3D view's box. It fills the same frame as the map. globeCanvas
  // holds Cesium's own elements. (It can take keyboard focus: the arrow
  // keys move its camera.)
  const globeCanvas = h('div', {
    class: 'fc-globe-canvas',
    role: 'region',
    tabindex: '0',
    'aria-label': '3D view of the board\'s path. The arrow keys move the camera around, and plus and minus zoom.',
  });
  const globeBox = h('div', { class: 'fc-globe', hidden: true }, globeCanvas);
  // The 3D view's loading and failure messages, over whatever the frame
  // shows.
  const threePanel = h('div', { class: 'fc-globe-panel', hidden: true });
  // Screen readers hear the 3D side's messages from this one line. It is
  // always in the page and only its words change, which is what they
  // announce reliably.
  const globeSay = h('p', { class: 'sr-only', role: 'status' });
  // Cesium's "Data attribution" dialog opens in this box. It goes on the
  // stage, above the HUD, so the HUD can't cover the data credits.
  const globeDialogs = h('div', { class: 'fc-globe-dialogs' });

  // Bottom right: the notes, the scale bar and the credits.
  const status = h('p', { class: 'fc-map-status', role: 'status' });
  const scaleBar = h('span', { class: 'fc-scale-bar' });
  const scaleText = h('span', { class: 'fc-scale-text' });
  const scaleBox = h('div', { class: 'fc-scale', hidden: true, 'aria-hidden': 'true' }, scaleText, scaleBar);
  const globeCredits = h('div', { class: 'fc-globe-credits' });
  const mapCredits = h('div', { class: 'fc-map-credits' });
  const corner = h('div', { class: 'fc-map-corner' }, status, scaleBox, globeCredits, mapCredits);

  // The labels sit over both views, under the messages and the corner.
  const labelHost = h('div', { class: 'fc-map-labels' });

  const frame = h('div', { class: 'fc-map-frame' }, canvas, waitBox, globeBox, labelHost, threePanel, corner, ownCorner, globeSay);
  setChildren(root, h('section', { class: 'fc-mapbox', 'aria-labelledby': 'fc-map-title' },
    h('h2', { class: 'sr-only', id: 'fc-map-title' }, 'Map and 3D view'),
    frame));
  const labels = createLabelLayer(labelHost);

  function legendRow(key, text) {
    return h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-key' }, key), h('span', { class: 'fc-legend-text' }, text));
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let mode = 'loading';     // the 2D side: 'loading', 'leaflet' or 'fallback'
  let fallbackReason = null; // 'library' or 'tiles' while in the fallback
  let follow = true;
  let followPanUntil = 0;
  let destroyed = false;
  let L = null;
  let map = null;
  let fitted = false;
  let fitPads = 0;          // launch pads on the map at the last first-view fit
  let viewTouched = false;  // the viewer has dragged or zoomed the map
  let ownMove = false;      // true while this view moves the map itself
  let ownMoveUntil = 0;     // ...and until then, for a move Leaflet animates
  let flyNext = false;      // the next first view flies there (a new source)
  let whole2d = null;       // WHOLE FLIGHT on the map: { bounds } it framed, or null
  let lastState = null;     // the flight state at the last draw (to spot liftoff)
  let resizeObserver = null;
  let coverObserver = null;
  let trackRenderer = null; // the canvas the breadcrumbs are painted on
  let linkRenderer = null;  // the radio link's own drawing layer
  const rocketLayers = new Map(); // rocketId -> { marker, parts, lastPacketT }
  const padMarkers = new Map();   // rocketId -> { marker, parts }
  let gsMarker = null;
  let gsParts = null;
  let linkLine = null;
  let travelMarker = null;
  let travelRun = null;     // { from, to, start, frame }
  let eventMarkers = [];    // { marker, type, aglM, ll }
  let eventsKey = '';
  let crossMarker = null;
  let pendingPackets = false;

  // Map or 3D
  let view = 'map';         // 'map' or '3d': which one the frame shows
  let three = 'off';        // the 3D side: 'off', 'loading', 'ready' or 'failed'
  let threeKind = null;     // why it failed: 'load', 'start' or 'stopped'
  let threeSlow = false;    // the loading took longer than THREE_SLOW_MS
  let threeOverMap = false; // the 2D map stays in sight while the 3D view loads
  let threeGen = 0;         // goes up on every start, so an answer meant for an old one is ignored
  let slowTimer = 0;
  let retryTimer = 0;
  let globe = null;         // the 3D view once it is running (globe-view.js)
  let body = canvas;        // what the 2D side shows: the map or the no-map panel
  let retryBox = null;      // where the background buttons' note sits in the no-map panel

  // Map background
  let chosenLayer = readSavedLayer() ?? (isLayer(config.DEFAULT_MAP_LAYER) ? config.DEFAULT_MAP_LAYER : 'satellite');
  let shownLayer = null;    // 'satellite' or 'dark' while the map is up
  let baseTiles = null;
  let labelTiles = null;
  // Goes up every time the background changes or the map goes away, so
  // answers meant for an old background are ignored.
  let tileGen = 0;
  let credit = null;        // the credit line now on the map
  let satelliteNote = '';
  let labelsNote = '';
  let noTilesNote = '';

  libs.leaflet.ready.then((leaflet) => {
    if (destroyed) return;
    if (leaflet) { startLeaflet(leaflet); return; }
    showFallback('library', 'The map library didn\'t load.');
    // If it turns up after all, switch to the real map.
    libs.leaflet.late.then((late) => {
      if (!destroyed && late && mode === 'fallback' && fallbackReason === 'library') {
        // Leave fallback mode first, so if the map fails to start after all,
        // showFallback() builds the no-map panel again.
        mode = 'loading';
        fallbackReason = null;
        showBody(canvas);
        startLeaflet(late);
      }
    });
  });

  // Puts the map (or the no-map panel) in the frame.
  function showBody(el) {
    waitBox.remove();
    if (el !== body) body.replaceWith(el);
    body = el;
    applyView();
  }

  // ------------------------------------------------------------------
  // Leaflet
  // ------------------------------------------------------------------
  function startLeaflet(leaflet) {
    L = leaflet;
    try {
      const gs = store.getGroundStation();
      // With less motion asked for, zooms, fades and drag throws happen at once.
      const still = prefersReducedMotion();
      map = L.map(canvas, {
        zoomControl: false,
        attributionControl: true,
        zoomSnap: 0.5,
        maxZoom: config.TILE_MAX_ZOOM,
        zoomAnimation: !still,
        fadeAnimation: !still,
        markerZoomAnimation: !still,
        inertia: !still,
      });
      // Leaflet's arrow-key panning (and panTo) go through panBy, which
      // glides unless told not to. With less motion asked for (checked
      // fresh on every pan), every pan is instant.
      const panBy = map.panBy.bind(map);
      map.panBy = (offset, options = {}) => panBy(offset, prefersReducedMotion() ? { ...options, animate: false } : options);
      // With no ground station, it waits on a wide view of the world until
      // the first view has a position to fit.
      if (gs) map.setView([gs.lat, gs.lon], config.MAP_DEFAULT_ZOOM);
      else map.setView(NO_STATION_CENTER, NO_STATION_ZOOM);
      // Esri's labels sit above the photos and below everything drawn here.
      makePane('fc-labels', 300);
      makePane('fc-track', 410);
      makePane('fc-link', 420);
      // The breadcrumbs: one canvas, painted by paintTrack() whenever
      // Leaflet moves it (after a pan or zoom) and whenever the data
      // changes. No shapes are ever added to it, so Leaflet itself only
      // clears it.
      trackRenderer = L.canvas({ pane: 'fc-track', padding: TRACK_PADDING });
      map.addLayer(trackRenderer);
      trackRenderer.on('update', paintTrack);
      linkRenderer = L.svg({ pane: 'fc-link' });
      map.addLayer(linkRenderer);
      // The credit line goes in this frame's own corner, with the scale.
      // It shows one line until it is hovered, focused or tapped.
      const creditBox = map.attributionControl.getContainer();
      mapCredits.append(creditBox);
      creditBox.addEventListener('click', (e) => {
        if (!e.target.closest('a')) creditBox.classList.toggle('fc-credit-open');
      });
      // After any pan or zoom (FOLLOW BOARD's own pans included), look
      // again at the new view, even if playback is paused.
      map.on('moveend', () => scheduler.schedule());
      // The labels and the scale follow the map as it moves. During a zoom
      // the labels hide, since the markers glide while Leaflet animates.
      map.on('move', () => { placeLabels2d(); updateScale2d(); });
      map.on('zoomstart', () => labels.hide());
      map.on('zoomend', () => { placeLabels2d(); updateScale2d(); });
      // Dragging the map means you want to look around: stop following.
      map.on('dragstart', () => {
        viewTouched = true;
        whole2d = null;
        updateCameraButtons();
        if (!follow) return;
        setFollow(false);
      });
      // Zooming by hand keeps the first view from fitting itself again.
      map.on('zoomstart', () => {
        if (ownMove || performance.now() < ownMoveUntil) return;
        viewTouched = true;
        whole2d = null;
        updateCameraButtons();
      });
      if ('ResizeObserver' in window) {
        // A new map size (a turned phone, a resized window) fits the first
        // view again, so nothing ends up cut off or under the HUD, unless
        // the viewer has already moved the map themselves.
        let lastSize = null;
        resizeObserver = new ResizeObserver(() => {
          // Hidden behind the 3D view: there is no size to measure until
          // the map is back (showMap measures it again).
          if (view === '3d' && !threeOverMap) return;
          map?.invalidateSize();
          const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
          if (lastSize !== null && size !== lastSize && !viewTouched) fitted = false;
          lastSize = size;
          scheduler.schedule();
        });
        resizeObserver.observe(canvas);
      }
    } catch (err) {
      console.error('Flight Console: the map failed to start', err);
      removeMap();
      showFallback('library', 'The map couldn\'t start.');
      return;
    }
    mode = 'leaflet';
    fallbackReason = null;
    waitBox.remove();
    fitted = false;
    fitPads = 0;
    viewTouched = false;
    applyView();
    showLayer(chosenLayer);
    redrawAll();
  }

  function makePane(name, zIndex) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(zIndex);
    pane.style.pointerEvents = 'none';
  }

  function removeMap() {
    tileGen += 1;
    resizeObserver?.disconnect();
    resizeObserver = null;
    stopTravel();
    if (map) {
      map.off();
      map.remove();
    }
    map = null;
    trackRenderer = null;
    linkRenderer = null;
    baseTiles = null;
    labelTiles = null;
    shownLayer = null;
    credit = null;
    mapCredits.replaceChildren();
    rocketLayers.clear();
    padMarkers.clear();
    gsMarker = null;
    gsParts = null;
    linkLine = null;
    travelMarker = null;
    eventMarkers = [];
    eventsKey = '';
    crossMarker = null;
  }

  // ------------------------------------------------------------------
  // Map background
  // ------------------------------------------------------------------

  // The viewer's last choice, if the browser kept it. Storage can be
  // blocked (private windows, strict settings), so any failure just means
  // the choice isn't remembered.
  function readSavedLayer() {
    try {
      const saved = window.localStorage.getItem(config.MAP_LAYER_STORAGE_KEY);
      return isLayer(saved) ? saved : null;
    } catch {
      return null;
    }
  }

  function saveLayer(which) {
    try {
      window.localStorage.setItem(config.MAP_LAYER_STORAGE_KEY, which);
    } catch {
      // Not remembered. Nothing else changes.
    }
  }

  // A click on SATELLITE or DARK MAP. From the 3D view it goes back to the
  // map. In the no-map panel it tries the map again.
  function selectLayer(which) {
    chosenLayer = which;
    saveLayer(which);
    satelliteNote = '';
    keepFocus(() => showMap());
    if (mode === 'fallback' && fallbackReason === 'tiles') {
      retryMap();
      return;
    }
    if (mode !== 'leaflet') {
      updateLayerControls();
      return;
    }
    if (which !== shownLayer) showLayer(which);
    else scheduler.schedule();
  }

  // Puts one background on the map. Everything about the old one goes: its
  // tiles, its credit and its failure count, so one background's failures
  // never count against the other.
  function showLayer(which) {
    tileGen += 1;
    baseTiles?.remove();
    labelTiles?.remove();
    baseTiles = null;
    labelTiles = null;
    labelsNote = '';
    noTilesNote = '';
    shownLayer = which;
    updateCredit();
    updateLayerControls();
    if (which === 'satellite') startSatellite(tileGen);
    else startDark(tileGen);
    scheduler.schedule();
  }

  function startSatellite(gen) {
    if (!config.ESRI_API_KEY) {
      satelliteFailed(gen);
      return;
    }
    checkEsriKey(config).then((ok) => {
      if (gen !== tileGen || mode !== 'leaflet') return;
      if (!ok) {
        satelliteFailed(gen);
        return;
      }
      baseTiles = L.tileLayer(config.SATELLITE_URL, {
        key: encodeURIComponent(config.ESRI_API_KEY),
        maxZoom: config.TILE_MAX_ZOOM,
        // Past this zoom Esri has no photos, so the last good tiles are scaled up.
        maxNativeZoom: config.SATELLITE_MAX_NATIVE_ZOOM,
        // Hook for the CSS that hides hairline seams between photos (fc-sat-tiles).
        className: 'fc-sat-tiles',
      });
      watchTiles(baseTiles, () => satelliteFailed(gen));
      baseTiles.addTo(map);
      addLabels(gen);
      updateCredit();
      scheduler.schedule();
    });
  }

  // Esri's place and road names, over the photos.
  function addLabels(gen) {
    labelTiles = L.tileLayer(config.SATELLITE_LABELS_URL, {
      key: encodeURIComponent(config.ESRI_API_KEY),
      pane: 'fc-labels',
      // These tiles are 512 px, so each one covers four 256 px tiles of the
      // next zoom in. Leaflet asks for one zoom level less to match.
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: config.TILE_MAX_ZOOM,
    });
    const tiles = labelTiles;
    watchTiles(tiles, () => {
      if (gen !== tileGen || labelTiles !== tiles) return;
      tiles.remove();
      labelTiles = null;
      labelsNote = 'The map\'s place names didn\'t load.';
      updateCredit();
      scheduler.schedule();
    });
    tiles.addTo(map);
  }

  // Esri turned the key down, or the photos keep failing: show the dark map
  // instead. The viewer's choice stays SATELLITE, so the next visit tries
  // again.
  function satelliteFailed(gen) {
    if (gen !== tileGen || mode !== 'leaflet' || shownLayer !== 'satellite') return;
    satelliteNote = 'Satellite imagery isn\'t available right now, so the map shows the dark map.';
    showLayer('dark');
  }

  function startDark(gen) {
    // Tiles go on once main.js knows which CARTO key to use (on localhost it
    // first tries js/config.local.js).
    ctx.tileKey.then(({ key, source }) => {
      if (gen !== tileGen || mode !== 'leaflet') return;
      if (key) {
        baseTiles = L.tileLayer(config.TILE_URL, {
          key: encodeURIComponent(key),
          maxZoom: config.TILE_MAX_ZOOM,
        });
        watchTiles(baseTiles, () => {
          if (gen === tileGen) showFallback('tiles', 'The map tiles didn\'t load.');
        });
        baseTiles.addTo(map);
        updateCredit();
        return;
      }
      // No key: don't ask CARTO for tiles that would only say "API key required".
      noTilesNote = source === 'missing-local'
        ? 'On this computer the dark map needs the local CARTO key in js/config.local.js, so the path shows on a plain background.'
        : 'The dark map needs a CARTO key that isn\'t set up yet, so the path shows on a plain background.';
      scheduler.schedule();
    });
  }

  // More than TILE_FAIL_COUNT tile errors with no tile loaded within
  // TILE_FAIL_TIMEOUT_MS means this layer's tiles can't be reached. Each
  // layer keeps its own count.
  function watchTiles(tiles, onFail) {
    let errors = 0;
    let loads = 0;
    let windowOver = false;
    const check = () => {
      if (map && map.hasLayer(tiles) && windowOver && loads === 0 && errors > config.TILE_FAIL_COUNT) onFail();
    };
    tiles.on('tileload', () => { loads += 1; });
    tiles.on('tileerror', () => { errors += 1; check(); });
    const timer = setTimeout(() => { windowOver = true; check(); }, config.TILE_FAIL_TIMEOUT_MS);
    tiles.on('remove', () => clearTimeout(timer));
  }

  // The credit line for what is on the map right now. Esri asks for
  // "Powered by Esri" plus each Esri layer's data credit.
  function updateCredit() {
    let text = null;
    if (map && baseTiles && shownLayer === 'satellite') {
      text = [config.ESRI_POWERED_BY, config.SATELLITE_ATTRIBUTION, labelTiles ? config.SATELLITE_LABELS_ATTRIBUTION : null]
        .filter(Boolean).join(CREDIT_SEP);
    } else if (map && baseTiles && shownLayer === 'dark') {
      text = config.TILE_ATTRIBUTION;
    }
    if (text === credit || !map) return;
    if (credit) map.attributionControl.removeAttribution(credit);
    if (text) map.attributionControl.addAttribution(text);
    credit = text;
  }

  // The pressed button is the view on screen: 3D, or the map background
  // showing (the dark map after a satellite failure, with a note saying
  // why). In the no-map panel the chosen background stays pressed.
  function updateLayerControls() {
    const in3d = view === '3d';
    const shown = in3d ? null : (mode === 'leaflet' ? shownLayer : chosenLayer);
    satelliteBtn.setAttribute('aria-pressed', String(shown === 'satellite'));
    darkBtn.setAttribute('aria-pressed', String(shown === 'dark'));
    threeBtn.setAttribute('aria-pressed', String(in3d));
  }

  // ------------------------------------------------------------------
  // Map or 3D. The frame shows one of them. The map (or the no-map panel)
  // stays in place underneath while the 3D view is showing.
  // ------------------------------------------------------------------

  // Shows the pieces that belong to the view on screen now and hides the
  // rest. Called whenever the view, the map's state or the 3D side's state
  // changes.
  function applyView() {
    const in3d = view === '3d';
    const ready = three === 'ready';
    // The 3D view is in the page as soon as it starts, so Cesium has a size
    // to draw at, but it stays out of sight until its first picture is in.
    globeBox.hidden = !in3d;
    globeBox.classList.toggle('is-waiting', in3d && !ready);
    // While the 3D view loads, the map stays in sight if the viewer came
    // from it. Otherwise the frame shows the page's near-black and the
    // loading message.
    const mapUnder = in3d && !ready && threeOverMap;
    body.hidden = in3d && !mapUnder;
    waitBox.hidden = in3d && !mapUnder;
    threePanel.hidden = !in3d || ready;
    // Cesium's credits show with the 3D view, and Leaflet's with the map.
    globeCredits.hidden = !(in3d && ready);
    mapCredits.hidden = (in3d && !mapUnder) || mode !== 'leaflet';
    globeDialogs.hidden = !in3d;
    legendShadowRow.hidden = !in3d;
    if (!in3d && mode !== 'leaflet') scaleBox.hidden = true;
    if (in3d && !ready && !mapUnder) {
      scaleBox.hidden = true;
      labels.update([]);
    }
    updateLayerControls();
    updateCameraButtons();
  }

  // FOLLOW BOARD is one setting, shared by the map and the 3D view.
  function setFollow(on) {
    follow = Boolean(on);
    if (followBox.checked !== follow) followBox.checked = follow;
    if (follow) whole2d = null;
    globe?.setFollow(follow);
    updateCameraButtons();
  }

  // WHOLE FLIGHT and RESET VIEW show while a saved flight is on screen.
  // WHOLE FLIGHT stays amber while the camera keeps the whole flight
  // framed.
  function updateCameraButtons() {
    const replay = isReplay();
    if (cameraPick.hidden === replay) cameraPick.hidden = !replay;
    const whole = view === '3d' ? globe?.cameraMode() === 'whole' : Boolean(whole2d);
    wholeBtn.setAttribute('aria-pressed', String(!follow && whole));
  }

  function showWholeFlight() {
    setFollow(false);
    if (view === '3d') globe?.showWholeFlight();
    else if (mode === 'leaflet') fitWhole2d({ animate: true });
    updateCameraButtons();
  }

  function resetView() {
    if (view === '3d') globe?.resetView();
    else if (mode === 'leaflet') {
      // Back to the first view: the launch points, the board and Manta.
      whole2d = null;
      fitted = false;
      viewTouched = false;
      flyNext = true;
      scheduler.schedule();
    }
    updateCameraButtons();
  }

  // Runs a view change and, if keyboard focus was on a button that the
  // change removed, moves it to the button for the view now showing.
  function keepFocus(change) {
    const lost = threePanel.contains(document.activeElement) || body.contains(document.activeElement);
    change();
    // A button that was just hidden still counts as focused until the
    // browser catches up, so check that it can actually be seen.
    const now = document.activeElement;
    if (!lost || (frame.contains(now) && now.getClientRects().length > 0)) return;
    const target = [threeBtn, satelliteBtn, darkBtn].find((b) => b.getAttribute('aria-pressed') === 'true') ?? threeBtn;
    target.focus({ preventScroll: true });
  }

  // A click on 3D.
  function selectThree() {
    chosenView = '3d';
    keepFocus(() => openThree());
  }

  // BACK TO THE MAP.
  function selectMap() {
    keepFocus(() => showMap());
  }

  // Shows the 3D side and starts it if it isn't running. Cesium downloads
  // here the first time, whether the page opened on 3D or the viewer
  // clicked 3D.
  function openThree() {
    const was = view;
    // Coming from a map that is showing, it stays in sight while 3D loads.
    threeOverMap = was === 'map' && mode === 'leaflet' && Boolean(map) && !body.hidden && canvas.clientWidth > 0;
    view = '3d';
    if (globe) {
      // On screen first, so the view has a size to measure when it wakes up.
      applyView();
      globe.setActive(true);
    } else if (three !== 'loading') startThree();
    applyView();
    if (was !== '3d') scheduler.schedule();
  }

  // Back to the map (or the no-map panel). The 3D view stays in memory,
  // paused, so coming back to it is instant.
  function showMap() {
    if (view === 'map') return;
    view = 'map';
    chosenView = 'map';
    globe?.setActive(false);
    clearTimeout(retryTimer);
    setText(globeSay, '');
    labels.update([]);
    applyView();
    if (mode === 'leaflet') {
      map.invalidateSize();
      scheduler.flush();
    } else {
      setText(status, '');
      scheduler.schedule();
    }
  }

  // Downloads Cesium and the 3D view's own code, then starts the view. The
  // loading message stays up until the view says its first picture is in.
  function startThree({ again = false } = {}) {
    const gen = ++threeGen;
    three = 'loading';
    threeKind = null;
    if (!again) threeSlow = false;
    clearTimeout(slowTimer);
    clearTimeout(retryTimer);
    // After THREE_SLOW_MS the message says to check the connection, and
    // offers the way back to the map. The download carries on.
    if (!threeSlow) {
      slowTimer = setTimeout(() => {
        if (destroyed || gen !== threeGen || three !== 'loading') return;
        threeSlow = true;
        showThreePanel();
      }, THREE_SLOW_MS);
    }
    showThreePanel();
    Promise.all([loadCesium(), import('./globe-view.js?v=5')]).then(([Cesium, module]) => {
      if (destroyed || gen !== threeGen) return;
      // They went back to the map while it loaded. The next click on 3D
      // starts it, with no download left to wait for.
      if (view !== '3d') {
        three = 'off';
        clearTimeout(slowTimer);
        return;
      }
      try {
        root.closest('.fc-stage')?.append(globeDialogs);
        globe = module.createGlobeView(globeCanvas, ctx, {
          Cesium,
          credits: globeCredits,
          dialogs: globeDialogs,
          follow,
          labels,
          covers: () => rectsOver(globeCanvas, coverElements(), []),
          freeInsets: () => freeInsets(globeCanvas),
          idleBottom: () => bottomBand(globeCanvas),
          onScale: (mpp) => { if (view === '3d' && three === 'ready') setScale(mpp); },
          onReady: () => {
            if (destroyed || gen !== threeGen) return;
            three = 'ready';
            threeSlow = false;
            threeOverMap = false;
            clearTimeout(slowTimer);
            setText(globeSay, '');
            applyView();
            scheduler.schedule();
          },
          onChange: () => scheduler.schedule(),
          // Sliding the 3D view away from the board stops following it,
          // as dragging the map does.
          onFollowOff: () => setFollow(false),
          onFail: (err) => {
            if (!destroyed && gen === threeGen) failThree('stopped', err);
          },
        });
      } catch (err) {
        failThree('start', err);
      }
    }, (err) => {
      if (destroyed || gen !== threeGen) return;
      failThree('load', err);
    });
  }

  function failThree(kind, err) {
    console.warn('Flight Console: the 3D view is not available', err);
    threeGen += 1;
    clearTimeout(slowTimer);
    destroyGlobe();
    three = 'failed';
    threeKind = kind;
    showThreePanel();
    applyView();
    scheduler.schedule();
    // A download that failed is tried again now and then while the viewer
    // stays on the 3D view, so it takes over when the internet is back.
    if (kind === 'load') {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function retry() {
        if (destroyed || view !== '3d' || three !== 'failed' || threeKind !== 'load') return;
        startThree({ again: true });
      }, THREE_RETRY_MS);
    }
  }

  function destroyGlobe() {
    try {
      globe?.destroy();
    } catch (err) {
      console.warn('Flight Console: error closing the 3D view', err);
    }
    globe = null;
    labels.update([]);
    globeCanvas.replaceChildren();
    globeCredits.replaceChildren();
    globeDialogs.replaceChildren();
    globeDialogs.remove();
  }

  // What the message over the 3D view says: "3D VIEWER LOADING..." with
  // the blinking cursor, then the connection hint and the way back to the
  // map, or why there is no 3D view.
  function showThreePanel() {
    const back = () => h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => selectMap() }, 'BACK TO THE MAP');
    let line;
    let say;
    let action = null;
    if (three === 'loading' && !threeSlow) {
      line = h('p', { class: 'fc-globe-msg' }, '3D VIEWER LOADING...', h('span', { class: 'fc-cursor', 'aria-hidden': 'true' }, '_'));
      say = '3D viewer loading.';
    } else if (three === 'failed' && threeKind === 'start') {
      line = h('p', { class: 'fc-globe-msg' }, '3D VIEWER CAN\'T RUN IN THIS BROWSER');
      say = 'The 3D viewer can\'t run in this browser. The map still works.';
      action = back();
    } else if (three === 'failed' && threeKind === 'stopped') {
      line = h('p', { class: 'fc-globe-msg' }, '3D VIEWER STOPPED. PRESS 3D TO START IT AGAIN');
      say = 'The 3D viewer stopped. The map still works.';
      action = back();
    } else {
      line = h('p', { class: 'fc-globe-msg' }, '3D VIEWER LOADING... CHECK YOUR INTERNET CONNECTION');
      say = '3D viewer still loading. Check your internet connection. The map still works.';
      action = back();
    }
    setChildren(threePanel, h('div', { class: 'fc-globe-msgbox' }, line, action));
    setText(globeSay, say);
  }

  // ------------------------------------------------------------------
  // Covered areas: the parts of the view under the HUD (every element on
  // the stage marked data-fc-cover, this file's controls row included) and
  // the arrow tabs at the panel's edges. Measured on every draw, because
  // they change size.
  // ------------------------------------------------------------------
  function coverElements() {
    const stage = root.closest('.fc-stage');
    const panels = stage ? [...stage.querySelectorAll('[data-fc-cover]')] : [];
    if (ownCorner) panels.push(ownCorner);
    // The console's arrow tabs at the panel's edges cover a little of the
    // view too. (A hidden one has no size, so it doesn't count.)
    const tabs = [...(root.closest('.fc-screens')?.querySelectorAll('.fc-flip') ?? [])];
    return [...panels, ...tabs];
  }

  // Rectangles in map pixels ({ left, top, right, bottom }) for everything
  // that overlaps the map, this frame's own corner included.
  function coveredRects() {
    if (!map) return [];
    const panels = coverElements();
    return rectsOver(canvas, [...panels, corner], panels);
  }

  // The parts of elements that overlap boxEl, in boxEl's own pixels.
  function rectsOver(boxEl, elements, panels) {
    const box = boxEl.getBoundingClientRect();
    const out = [];
    for (const el of elements) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // panel: one of the HUD's blocks (they can grow, like the readings
      // column when MORE opens).
      const rect = { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top, panel: panels.includes(el) };
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= box.width || rect.top >= box.height) continue;
      out.push(rect);
    }
    return out;
  }

  // The room (px) to keep free on each side of the view so nothing ends
  // up under a covered area. Each area can be cleared by keeping a band
  // free along its nearest top or bottom edge, or along its nearest left
  // or right edge. Every mix is tried, and score() picks the best one (the
  // closest zoom for the first view, the largest free area for FOLLOW
  // BOARD and WHOLE FLIGHT). score() returns null for a mix that doesn't
  // work at all. margin is the extra room past each area and the view's
  // edge, the same on every side, or { top, right, bottom, left }. With
  // sideways set, a HUD column (a block taller than it is wide, like the
  // readings column on the right) is only cleared sideways: it keeps its
  // width but grows taller when MORE opens, so a view that only clears its
  // bottom edge wouldn't last. If no mix works, the result is null, or
  // with roomiest set the mix that leaves the largest free area.
  function clearInsets(covers, size, margin, score, { sideways = false, roomiest = false } = {}) {
    const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
    const options = covers.map((c) => {
      const vertical = (c.top + c.bottom) / 2 < size.y / 2 ? { top: c.bottom + m.top } : { bottom: size.y - c.top + m.bottom };
      const horizontal = (c.left + c.right) / 2 < size.x / 2 ? { left: c.right + m.left } : { right: size.x - c.left + m.right };
      const column = c.panel && c.bottom - c.top > c.right - c.left;
      return [sideways && column ? horizontal : vertical, horizontal];
    });
    let best = null;
    let widest = null;
    const combos = 2 ** Math.min(options.length, 12);
    for (let bits = 0; bits < combos; bits++) {
      const ins = { ...m };
      options.forEach((pair, i) => {
        for (const [side, value] of Object.entries(pair[(bits >> i) & 1])) ins[side] = Math.max(ins[side], value);
      });
      const w = size.x - ins.left - ins.right;
      const hgt = size.y - ins.top - ins.bottom;
      const room = Math.max(0, w) * Math.max(0, hgt);
      if (!widest || room > widest.room) widest = { ins, room };
      // Leave at least a little map to look at.
      if (w < 80 || hgt < 80) continue;
      const s = score(ins);
      if (s === null || Number.isNaN(s)) continue;
      if (!best || s > best.score) best = { ins, score: s };
    }
    if (best) return best.ins;
    return roomiest ? widest?.ins ?? { ...m } : null;
  }

  const freeArea = (size) => (ins) => (size.x - ins.left - ins.right) * (size.y - ins.top - ins.bottom);

  // The part of a view (boxEl: the map or the 3D view) WHOLE FLIGHT frames
  // the path in, as insets from each edge: clear of every covered area,
  // with WHOLE_ROOM_PX to spare, as large as it can be.
  function freeInsets(boxEl) {
    const size = { x: boxEl.clientWidth, y: boxEl.clientHeight };
    const covers = rectsOver(boxEl, [...coverElements(), corner], []);
    return clearInsets(covers, size, WHOLE_ROOM_PX, freeArea(size), { roomiest: true });
  }

  // The part of the map FOLLOW BOARD keeps the board in, as insets: the
  // free part WHOLE FLIGHT uses, made a little smaller where there is
  // room, so the board stays FOLLOW_EDGE_PX clear of the map's edge and
  // the HUD's blocks.
  // Returns { ins, free }: those insets, and the free part's own.
  function followInsets(size, covers) {
    const free = clearInsets(covers, size, WHOLE_ROOM_PX, freeArea(size), { roomiest: true });
    const extra = Math.max(0, config.FOLLOW_EDGE_PX - WHOLE_ROOM_PX);
    const sx = Math.max(0, Math.min(extra, (size.x - free.left - free.right - 40) / 2));
    const sy = Math.max(0, Math.min(extra, (size.y - free.top - free.bottom - 40) / 2));
    return { ins: { left: free.left + sx, right: free.right + sx, top: free.top + sy, bottom: free.bottom + sy }, free };
  }

  // The height (px) of the band the controls row and the corner take
  // along the bottom of a view, so the idle Earth can sit above it.
  // (The arrow tabs halfway up the sides don't count.)
  function bottomBand(boxEl) {
    const box = boxEl.getBoundingClientRect();
    let band = 0;
    for (const el of [...coverElements(), corner]) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.top < box.top + box.height * 0.6 || r.top >= box.bottom) continue;
      band = Math.max(band, box.bottom - r.top);
    }
    return band;
  }

  // The bottom right corner (notes, scale and credits) sits just above
  // whatever the HUD has under it: the timeline across the whole width,
  // or the controls row when it reaches this far right on a phone.
  let cornerLift = '';
  function placeCorner() {
    const box = frame.getBoundingClientRect();
    if (box.height < 1) return;
    const c = corner.getBoundingClientRect();
    let lift = 8;
    for (const el of coverElements()) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Only things down in the bottom part, under the corner's width.
      if (r.bottom < box.top + box.height * 0.65 || r.right <= c.left || r.left >= c.right) continue;
      const need = box.bottom - r.top + 6;
      if (need > box.height * 0.5) continue;
      lift = Math.max(lift, need);
    }
    const value = `${Math.round(lift)}px`;
    if (value === cornerLift) return;
    cornerLift = value;
    corner.style.bottom = value;
  }

  // ------------------------------------------------------------------
  // The scale bar, in both views: the roundest distance that fits in
  // SCALE_MAX_PX, worked out from how many meters a screen pixel covers.
  // ------------------------------------------------------------------
  let scaleShown = '';
  function setScale(mpp) {
    if (!Number.isFinite(mpp) || mpp <= 0) {
      scaleBox.hidden = true;
      scaleShown = '';
      return;
    }
    const most = mpp * SCALE_MAX_PX;
    const pow = 10 ** Math.floor(Math.log10(most));
    const lead = most / pow;
    const meters = (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * pow;
    const px = Math.round(meters / mpp);
    const text = meters >= 1000 ? `${formatNumber(meters / 1000, 0)} KM` : `${formatNumber(meters, 0)} M`;
    const key = `${text}|${px}`;
    if (scaleBox.hidden) scaleBox.hidden = false;
    if (key === scaleShown) return;
    scaleShown = key;
    setText(scaleText, text);
    scaleBar.style.width = `${px}px`;
  }

  function updateScale2d() {
    if (!map || view !== 'map' || mode !== 'leaflet') return;
    const size = map.getSize();
    if (size.x < 100) return;
    const y = size.y / 2;
    const a = map.containerPointToLatLng([size.x / 2 - 50, y]);
    const b = map.containerPointToLatLng([size.x / 2 + 50, y]);
    setScale(map.distance(a, b) / 100);
  }

  // ------------------------------------------------------------------
  // Drawing on the map: where each rocket is
  // ------------------------------------------------------------------

  // Where a rocket's marker goes: its newest good crumb, with its place in
  // the list, or null. A board that has only sent weak fixes so far (too
  // few satellites, as on a bench indoors) goes on its newest weak one
  // (good: false), so it still shows, hollow, with its label and radio link.
  function boardCrumb(rocket) {
    const crumbs = rocket.crumbs ?? [];
    let weak = null;
    for (let i = crumbs.length - 1; i >= 0; i--) {
      if (crumbs[i].quality === 'good') return { crumb: crumbs[i], index: i, newest: i === crumbs.length - 1, good: true };
      if (crumbs[i].quality === 'weak' && !weak) weak = { crumb: crumbs[i], index: i, newest: i === crumbs.length - 1, good: false };
    }
    return weak;
  }

  // ------------------------------------------------------------------
  // Drawing on the map: the breadcrumbs, painted on one canvas. The line
  // goes through the good fixes' smoothed positions and breaks before any
  // fix with gapBefore. It gets a dark outline first, then each piece in
  // its speed colors (a gradient between its two ends, like the 3D view).
  // Then the dots: good ones solid in their speed color with a dark
  // outline, weak ones as hollow grey rings. Outliers aren't drawn.
  // ------------------------------------------------------------------
  function paintTrack() {
    const r = trackRenderer;
    // (_ctx and _container are the canvas renderer's own drawing surface in
    // Leaflet 1.9.4. The map draws nothing else on this one.)
    const g = r?._ctx;
    if (!g || !map) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, r._container.width, r._container.height);
    g.restore();
    if (view === '3d' && !threeOverMap) return;
    const focused = store.getFocused();
    const rockets = store.getRockets().sort((a, b) => (a.id === focused?.id) - (b.id === focused?.id));
    for (const rocket of rockets) paintCrumbs(g, rocket, rocket.id === focused?.id);
  }

  function paintCrumbs(g, rocket, isFocused) {
    const crumbs = rocket.crumbs ?? [];
    if (!crumbs.length) return;
    const own = rocket.profile?.color ?? WHITE;
    const colorOf = (c) => (isFocused ? speedColor(c.speedMps) : own);
    const width = isFocused ? LINE_PX : OTHER_LINE_PX;
    // The line's runs, split where packets were missed. (gapBefore sits on
    // the crumb right after the gap, which can be a weak fix or an outlier
    // the line skips, so the break is carried to the next good one.)
    const runs = [];
    let run = null;
    let broken = true;
    for (const c of crumbs) {
      if (c.gapBefore) broken = true;
      if (c.quality !== 'good' || !c.line) continue;
      const p = map.latLngToLayerPoint([c.line.lat, c.line.lon]);
      if (broken) {
        run = [];
        runs.push(run);
        broken = false;
      }
      run.push({ x: p.x, y: p.y, color: colorOf(c) });
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = NEAR_BLACK;
    g.lineWidth = width + 2 * LINE_OUTLINE_PX;
    for (const pts of runs) {
      if (pts.length < 2) continue;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
    }
    g.lineWidth = width;
    for (const pts of runs) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a.color === b.color) g.strokeStyle = b.color;
        else {
          const ramp = g.createLinearGradient(a.x, a.y, b.x, b.y);
          ramp.addColorStop(0, a.color);
          ramp.addColorStop(1, b.color);
          g.strokeStyle = ramp;
        }
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
    }
    // The dots, raw positions, in two passes: every dark edge first, then
    // every fill on top. So a run of dots that overlap (a slow descent, or
    // the map zoomed out) reads as its speed colors with one thin dark
    // edge around the run, and dots far enough apart each keep their own
    // dark ring.
    const dotR = (isFocused ? DOT_PX : OTHER_DOT_PX) / 2;
    const weakR = WEAK_DOT_PX / 2;
    const spots = [];
    for (const c of crumbs) {
      if (c.quality === 'outlier') continue;
      const p = map.latLngToLayerPoint([c.lat, c.lon]);
      spots.push({ x: p.x, y: p.y, good: c.quality === 'good', color: c.quality === 'good' ? colorOf(c) : null });
    }
    g.fillStyle = NEAR_BLACK;
    g.strokeStyle = NEAR_BLACK;
    g.lineWidth = WEAK_LINE_PX + 2 * DOT_OUTLINE_PX;
    for (const s of spots) {
      g.beginPath();
      if (s.good) {
        g.arc(s.x, s.y, dotR + DOT_OUTLINE_PX, 0, Math.PI * 2);
        g.fill();
      } else {
        g.arc(s.x, s.y, weakR, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.lineWidth = WEAK_LINE_PX;
    g.strokeStyle = WEAK_COLOR;
    for (const s of spots) {
      g.beginPath();
      if (s.good) {
        g.arc(s.x, s.y, dotR, 0, Math.PI * 2);
        g.fillStyle = s.color;
        g.fill();
      } else {
        g.arc(s.x, s.y, weakR, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }

  // ------------------------------------------------------------------
  // Drawing on the map: markers. Each marker is built once and then only
  // moved. Screen readers skip them: the HUD says the same things in words.
  // ------------------------------------------------------------------
  function markerOptions(parts, size, anchor, zIndexOffset) {
    return {
      icon: L.divIcon({ className: 'fc-mk', html: parts.el, iconSize: size, iconAnchor: anchor }),
      interactive: false,
      keyboard: false,
      zIndexOffset,
    };
  }

  // The board marker: the board, with its packet ring under it.
  function buildRocketIcon(isFocused) {
    const size = isFocused ? BOARD_FOCUSED : BOARD_OTHER;
    const ring = h('span', { class: 'fc-rkt-ring' });
    const iconBox = h('span', { class: 'fc-rkt-icon' }, iconNode(boardSvg(size)));
    const el = h('div', { class: `fc-rkt${isFocused ? ' fc-rkt--focus' : ''}`, 'aria-hidden': 'true', style: { '--w': `${size[0]}px`, '--h': `${size[1]}px` } }, ring, iconBox);
    return { el, ring, focused: isFocused, iconW: size[0], iconH: size[1], ringAnim: null };
  }

  function buildIcon(cls, markup) {
    return { el: h('div', { class: cls, 'aria-hidden': 'true' }, iconNode(markup)) };
  }

  // Removes everything drawn for the rockets (a new flight, or a new map).
  function clearRocketLayers() {
    for (const layers of rocketLayers.values()) layers.marker?.remove();
    rocketLayers.clear();
    for (const pad of padMarkers.values()) pad.marker.remove();
    padMarkers.clear();
    for (const m of eventMarkers) m.marker.remove();
    eventMarkers = [];
    eventsKey = '';
    crossMarker?.remove();
    crossMarker = null;
    linkLine?.remove();
    linkLine = null;
    stopTravel();
    gsMarker?.remove();
    gsMarker = null;
    gsParts = null;
  }

  // The KEY names Manta's demo position while the ground station is the
  // config placeholder, and leaves out Manta and the radio link when there
  // is no ground station. It runs for both views.
  function updateLegend() {
    const gs = store.getGroundStation();
    for (const row of legendStationRows) {
      if (row.hidden !== !gs) row.hidden = !gs;
    }
    if (gs) setText(legendStationText, gs.source === 'config' ? `${LABEL_NAMES.station}, DEMO POSITION` : LABEL_NAMES.station);
  }

  function redrawAll() {
    if (mode !== 'leaflet') return;
    clearRocketLayers();
    // Hidden behind the 3D view, the map has no size to draw into. It
    // draws when it is back (showMap).
    if (view === 'map') drawLeaflet();
  }

  // ------------------------------------------------------------------
  // Packet ring and radio dot on the map. Each new packet for a board
  // grows one thin white ring out of its marker, and (for the focused
  // board with Manta on the map) sends a small white dot along the radio
  // link. Nothing new starts while they still move. Nothing moves when the
  // viewer asked for less motion.
  // ------------------------------------------------------------------
  function packetArrived2d(rocket, layers, isFocused) {
    if (prefersReducedMotion()) return;
    const parts = layers.parts;
    if (parts && (!parts.ringAnim || parts.ringAnim.playState === 'finished') && typeof parts.ring.animate === 'function') {
      parts.ringAnim = parts.ring.animate([
        { transform: `scale(${RING_FROM_SCALE})`, opacity: 1 },
        { transform: 'scale(1)', opacity: 0 },
      ], { duration: RING_MS, easing: 'cubic-bezier(0.25, 0.6, 0.4, 1)' });
    }
    if (isFocused && linkLine && !travelRun) {
      const [from, to] = linkLine.getLatLngs();
      if (!travelMarker) {
        travelMarker = L.marker(from, markerOptions({ el: h('span', { class: 'fc-travel-dot', 'aria-hidden': 'true' }) }, [0, 0], [0, 0], Z_OFFSET.travel));
      }
      travelMarker.setLatLng(from).addTo(map);
      travelRun = { from, to, start: performance.now(), frame: 0 };
      const step = (now) => {
        if (!travelRun || destroyed || !map) return;
        const u = Math.min(1, (now - travelRun.start) / LINK_TRAVEL_MS);
        const at = L.latLng(
          travelRun.from.lat + (travelRun.to.lat - travelRun.from.lat) * u,
          travelRun.from.lng + (travelRun.to.lng - travelRun.from.lng) * u);
        travelMarker.setLatLng(at);
        if (u < 1) travelRun.frame = window.requestAnimationFrame(step);
        else stopTravel();
      };
      travelRun.frame = window.requestAnimationFrame(step);
    }
  }

  function stopTravel() {
    if (travelRun) window.cancelAnimationFrame(travelRun.frame);
    travelRun = null;
    travelMarker?.remove();
  }

  // ------------------------------------------------------------------
  // Drawing on the map: one pass over everything
  // ------------------------------------------------------------------
  function drawLeaflet() {
    const rockets = store.getRockets();
    const focused = store.getFocused();
    const gs = store.getGroundStation();

    // Manta (none at all for a board on the bench)
    updateLegend();
    if (!gs) {
      gsMarker?.remove();
      gsMarker = null;
      gsParts = null;
    } else if (!gsMarker) {
      gsParts = buildIcon('fc-gs', dishSvg());
      gsMarker = L.marker([gs.lat, gs.lon], markerOptions(gsParts, DISH_SIZE, DISH_ANCHOR, Z_OFFSET.gs)).addTo(map);
    } else {
      gsMarker.setLatLng([gs.lat, gs.lon]);
    }

    let focusedBoard = null;
    for (const rocket of rockets) {
      const isFocused = focused?.id === rocket.id;
      // The launch point: the last good position before liftoff.
      const pad = padMarkers.get(rocket.id);
      if (rocket.padPosition) {
        const ll = [rocket.padPosition.lat, rocket.padPosition.lon];
        if (!pad) {
          const parts = buildIcon('fc-pad', startSvg());
          padMarkers.set(rocket.id, { parts, marker: L.marker(ll, markerOptions(parts, [START_SIZE, START_SIZE], START_ANCHOR, Z_OFFSET.pad)).addTo(map) });
        } else {
          pad.marker.setLatLng(ll);
        }
      } else if (pad) {
        pad.marker.remove();
        padMarkers.delete(rocket.id);
      }

      // The board marker at its newest good fix (or newest weak one, if it
      // has no good one yet): the board's blue while the fix is good right
      // now, hollow otherwise.
      let layers = rocketLayers.get(rocket.id);
      if (!layers) {
        layers = { marker: null, parts: null, lastPacketT: null };
        rocketLayers.set(rocket.id, layers);
      }
      const spot = boardCrumb(rocket);
      if (spot) {
        const ll = [spot.crumb.lat, spot.crumb.lon];
        if (isFocused) focusedBoard = ll;
        const zIndex = isFocused ? Z_OFFSET.focused : Z_OFFSET.rocket;
        if (layers.marker && layers.parts.focused !== isFocused) {
          layers.marker.remove();
          layers.marker = null;
        }
        if (!layers.marker) {
          layers.parts = buildRocketIcon(isFocused);
          // The icon's middle is the position, so the marker box has no size.
          layers.marker = L.marker(ll, markerOptions(layers.parts, [0, 0], [0, 0], zIndex)).addTo(map);
        } else {
          layers.marker.setLatLng(ll);
        }
        layers.parts.el.classList.toggle('fc-rkt--nofix', !(store.hasFixNow(rocket) && spot.newest && spot.good));
      } else if (layers.marker) {
        layers.marker.remove();
        layers.marker = null;
        layers.parts = null;
      }
      // New packets start the ring (and the radio dot, below).
      const t = rocket.lastPacketT;
      layers.newPacket = pendingPackets && Number.isFinite(t) && layers.lastPacketT !== null && t > layers.lastPacketT && Boolean(layers.marker);
      layers.lastPacketT = Number.isFinite(t) ? t : null;
    }

    // The radio link from the focused board to Manta.
    if (gs && focusedBoard) {
      const lls = [focusedBoard, [gs.lat, gs.lon]];
      if (!linkLine) {
        linkLine = L.polyline(lls, {
          pane: 'fc-link',
          renderer: linkRenderer,
          color: LINK_COLOR,
          opacity: LINK_ALPHA,
          weight: LINK_PX,
          dashArray: LINK_DASH_PX.join(' '),
          lineCap: 'butt',
          interactive: false,
        }).addTo(map);
      } else {
        linkLine.setLatLngs(lls);
      }
    } else if (linkLine) {
      linkLine.remove();
      linkLine = null;
      stopTravel();
    }

    for (const rocket of rockets) {
      const layers = rocketLayers.get(rocket.id);
      if (layers?.newPacket) packetArrived2d(rocket, layers, focused?.id === rocket.id);
    }
    pendingPackets = false;

    drawEvents2d(focused);
    paintTrack();

    // Everything below reads sizes and positions (after all the writes
    // above). The map's size is kept up to date by the ResizeObserver.
    const size = map.getSize();
    const covers = coveredRects();
    const target = focusedBoard ? L.latLng(focusedBoard) : null;
    const focusedParts = target ? rocketLayers.get(focused?.id)?.parts ?? null : null;
    // A map squeezed to almost nothing (hidden, or mid-layout) has no view
    // worth fitting or following yet.
    const usable = size.x >= 120 && size.y >= 120;

    // First view: the pad(s), the focused board and Manta, in the part of
    // the map nothing covers (see firstView). With several rockets, their
    // pads can show up one after another, so the view fits again for each
    // new pad until the viewer drags or zooms the map. FOLLOW BOARD waits
    // for the next draw, and the first view keeps the focused board
    // further from the edges than FOLLOW BOARD's margin, so the view stays
    // put until the board really heads off.
    let justFitted = false;
    if ((!fitted || (!viewTouched && padMarkers.size > fitPads)) && usable && !whole2d) {
      const fit = firstView(target, focusedParts, gs, size, covers);
      if (fit) {
        const animate = flyNext && !prefersReducedMotion();
        ownMove = true;
        if (fit.bounds) {
          const opts = { paddingTopLeft: fit.paddingTopLeft, paddingBottomRight: fit.paddingBottomRight, maxZoom: config.FIT_MAX_ZOOM };
          if (animate) map.flyToBounds(fit.bounds, opts);
          else map.fitBounds(fit.bounds, { ...opts, animate: false });
        } else if (animate) {
          map.flyTo(fit.center, fit.zoom);
        } else {
          map.setView(fit.center, fit.zoom, { animate: false });
        }
        ownMove = false;
        ownMoveUntil = performance.now() + OWN_MOVE_MS;
        if (animate) followPanUntil = performance.now() + 1500;
        flyNext = false;
        fitted = true;
        fitPads = padMarkers.size;
        justFitted = true;
      }
    }

    // WHOLE FLIGHT keeps the whole path framed as it grows.
    if (whole2d && !justFitted) {
      const all = wholePoints();
      if (all.length && !all.every((ll) => whole2d.bounds.contains(ll))) fitWhole2d({ animate: true });
    }

    // FOLLOW BOARD: when the focused board gets within FOLLOW_EDGE_PX of
    // the edge of the free part of the map (the same part WHOLE FLIGHT
    // frames in, clear of the HUD's blocks), pan so it sits well inside
    // it again. Where it moves them depends on what else stays in sight
    // (see followShift). The zoom stays the visitor's. If the board is
    // ever right outside the free part (a HUD block grew over it), the
    // map moves at once instead of gliding, so it is never hidden.
    if (follow && target && usable && !justFitted) {
      const p = map.latLngToContainerPoint(target);
      const point = { left: p.x, top: p.y, right: p.x, bottom: p.y };
      const { ins, free } = followInsets(size, covers);
      const outside = (r) => p.x < r.left || p.x > size.x - r.right || p.y < r.top || p.y > size.y - r.bottom;
      const urgent = outside(free);
      if (urgent || (outside(ins) && performance.now() > followPanUntil)) {
        const shift = followShift(point, ins, size, covers);
        // Already as centered as it gets (a free part too small for the
        // board): no pan, so it doesn't pan on the spot.
        if (Math.abs(shift.x) >= 2 || Math.abs(shift.y) >= 2) {
          const newCenter = map.containerPointToLatLng(size.divideBy(2).add(shift));
          const animate = !urgent && !prefersReducedMotion();
          ownMove = true;
          map.panTo(newCenter, { animate, duration: 0.5 });
          ownMove = false;
          ownMoveUntil = performance.now() + OWN_MOVE_MS;
          followPanUntil = animate ? performance.now() + FOLLOW_PAN_MS : 0;
        }
      }
    }

    placeLabels2d();
    updateScale2d();
    setText(status, statusText());
  }

  // The focused rocket's event diamonds and its recovery crosshair.
  function drawEvents2d(focused) {
    const spots = focused
      ? EVENT_TYPES.map((type) => focused.events.find((e) => e.type === type)).filter(Boolean)
        .map((e) => ({ e, c: eventCrumb(focused, e) })).filter((s) => s.c)
      : [];
    const key = `${focused?.id ?? ''}|${spots.map(({ e, c }) => `${e.type}@${c.t}`).join(',')}`;
    if (key !== eventsKey) {
      eventsKey = key;
      for (const m of eventMarkers) m.marker.remove();
      eventMarkers = spots.map(({ e, c }) => {
        const ll = L.latLng(c.lat, c.lon);
        const parts = buildIcon('fc-event', diamondSvg());
        const marker = L.marker(ll, markerOptions(parts, [DIAMOND_SIZE, DIAMOND_SIZE], [DIAMOND_SIZE / 2, DIAMOND_SIZE / 2], Z_OFFSET.event)).addTo(map);
        return { marker, type: e.type, aglM: e.aglM, ll };
      });
    }
    const where = focused ? recoveryInfo(store, focused)?.position : null;
    if (!where) {
      crossMarker?.remove();
      crossMarker = null;
    } else if (!crossMarker) {
      const parts = buildIcon('fc-cross', crosshairSvg());
      crossMarker = L.marker([where.lat, where.lon], markerOptions(parts, [CROSSHAIR_SIZE, CROSSHAIR_SIZE], [CROSSHAIR_SIZE / 2, CROSSHAIR_SIZE / 2], Z_OFFSET.event)).addTo(map);
    } else {
      crossMarker.setLatLng([where.lat, where.lon]);
    }
  }

  // The labels on the map: the same names as in 3D, placed from Leaflet's
  // own projection.
  function placeLabels2d() {
    // In 3D (even while it loads over the map) the 3D view feeds the labels.
    if (!map || mode !== 'leaflet' || view === '3d') return;
    const items = [];
    const focused = store.getFocused();
    const at = (ll) => map.latLngToContainerPoint(ll);
    const board = focused ? rocketLayers.get(focused.id)?.marker : null;
    if (board) {
      const p = at(board.getLatLng());
      items.push({ id: 'board', text: LABEL_NAMES.board, x: p.x, y: p.y, r: BOARD_FOCUSED[1] / 2 + 2, priority: LABEL_PRIORITY.board });
    }
    if (gsMarker) {
      const p = at(gsMarker.getLatLng());
      items.push({ id: 'station', text: LABEL_NAMES.station, x: p.x, y: p.y - DISH_ANCHOR[1] / 2, r: DISH_SIZE[0] / 2, priority: LABEL_PRIORITY.station });
    }
    const pad = focused ? padMarkers.get(focused.id) : null;
    if (pad) {
      const p = at(pad.marker.getLatLng());
      items.push({ id: 'pad', text: LABEL_NAMES.pad, x: p.x, y: p.y, r: START_SIZE / 2, priority: LABEL_PRIORITY.pad });
    }
    const apogee = eventMarkers.find((m) => m.type === 'apogee');
    if (apogee) {
      const p = at(apogee.ll);
      items.push({ id: 'apogee', text: apogeeLabel(apogee.aglM), x: p.x, y: p.y, r: DIAMOND_SIZE / 2, priority: LABEL_PRIORITY.apogee });
    }
    labels.update(items, { far: map.getZoom() < LABEL_FAR_ZOOM, avoid: rectsOver(canvas, coverElements(), []) });
  }

  // Every spot WHOLE FLIGHT frames on the map: every fix drawn, the
  // launch points, the event diamonds and Manta.
  function wholePoints() {
    const out = [];
    for (const rocket of store.getRockets()) {
      for (const c of rocket.crumbs ?? []) if (c.quality !== 'outlier') out.push(L.latLng(c.lat, c.lon));
      if (rocket.padPosition) out.push(L.latLng(rocket.padPosition.lat, rocket.padPosition.lon));
    }
    for (const m of eventMarkers) out.push(m.ll);
    const gs = store.getGroundStation();
    if (gs) out.push(L.latLng(gs.lat, gs.lon));
    return out;
  }

  // WHOLE FLIGHT on the map: the whole path in the part of the map the HUD
  // leaves free, with WHOLE_ROOM_PX to spare for the markers.
  function fitWhole2d({ animate }) {
    if (!map) return;
    const all = wholePoints();
    if (!all.length) return;
    const bounds = L.latLngBounds(all);
    const ins = freeInsets(canvas);
    ownMove = true;
    map.fitBounds(bounds, {
      paddingTopLeft: [ins.left, ins.top],
      paddingBottomRight: [ins.right, ins.bottom],
      maxZoom: config.FIT_MAX_ZOOM,
      animate: animate && !prefersReducedMotion(),
    });
    ownMove = false;
    ownMoveUntil = performance.now() + OWN_MOVE_MS;
    whole2d = { bounds };
    updateCameraButtons();
  }

  // ------------------------------------------------------------------
  // The first view. Each thing to show (the launch pads, the focused
  // board, Manta) is a point with the room its marker needs around it in
  // px, plus a little air. The view is the closest zoom at which all of
  // that fits inside the part of the map nothing covers. FIT_PADDING_PX of
  // air is kept when that costs at most half a zoom step, otherwise less.
  // Covered areas always count.
  // ------------------------------------------------------------------
  function firstView(target, rocketParts, gs, size, covers) {
    const pads = [...padMarkers.values()];
    if (!pads.length && !target) return null;
    // The focused board stays further than FOLLOW BOARD's edge margin from
    // every edge, so it doesn't pan right after the first view.
    const keep = config.FOLLOW_EDGE_PX + 8;
    const items = (air) => {
      const out = [];
      const add = (ll, left, right, up, down) => out.push({ ll, l: left + air, r: right + air, u: up + air, d: down + air });
      for (const pad of pads) {
        add(pad.marker.getLatLng(), START_ANCHOR[0], START_SIZE - START_ANCHOR[0], START_ANCHOR[1], START_SIZE - START_ANCHOR[1]);
      }
      if (gsParts) {
        add(L.latLng(gs.lat, gs.lon), DISH_ANCHOR[0], DISH_SIZE[0] - DISH_ANCHOR[0], DISH_ANCHOR[1], DISH_SIZE[1] - DISH_ANCHOR[1]);
      }
      if (target) {
        const half = Math.max(rocketParts?.iconW ?? 0, rocketParts?.iconH ?? 0) / 2 + air;
        out.push({ ll: target, l: Math.max(keep, half), r: Math.max(keep, half), u: Math.max(keep, half), d: Math.max(keep, half) });
      }
      return out;
    };
    const tiers = [items(config.FIT_PADDING_PX), items(FIT_ROOM_PX)];
    const area = freeArea(size);
    const views = tiers.map((list) => {
      const ins = clearInsets(covers, size, 0, (o) => {
        const fit = fitItems(list, o, size);
        return fit ? fit.zoom * 1e7 + area(o) : null;
      }, { sideways: true });
      return ins ? fitItems(list, ins, size) : null;
    });
    // The roomy view, unless it is more than half a zoom step further out.
    if (views[0] && (!views[1] || views[0].zoom >= views[1].zoom - 0.5)) return views[0];
    const found = views.find(Boolean);
    if (found) return found;
    // Nothing fits at all: the points only, in the largest free part.
    const ins = clearInsets(covers, size, FIT_ROOM_PX, area, { sideways: true, roomiest: true });
    const bounds = L.latLngBounds(tiers[1].map((it) => it.ll));
    return { bounds, paddingTopLeft: [ins.left, ins.top], paddingBottomRight: [ins.right, ins.bottom] };
  }

  // The closest zoom (in the map's half steps, from FIT_MAX_ZOOM down to
  // FIT_MIN_ZOOM) at which every item and the room around it fits inside
  // the free box left by insets ins, and the center that puts the whole
  // group in the middle of that box. null if it doesn't fit even at
  // FIT_MIN_ZOOM.
  function fitItems(list, ins, size) {
    const boxW = size.x - ins.left - ins.right;
    const boxH = size.y - ins.top - ins.bottom;
    if (!list.length || boxW <= 0 || boxH <= 0) return null;
    // Map pixels at zoom 0. Each zoom step doubles them, and the room
    // around each item stays the same, so a closer zoom never fits better.
    for (const it of list) it.p0 ??= map.project(it.ll, 0);
    const extent = (z) => {
      const k = 2 ** z;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const it of list) {
        x0 = Math.min(x0, it.p0.x * k - it.l);
        x1 = Math.max(x1, it.p0.x * k + it.r);
        y0 = Math.min(y0, it.p0.y * k - it.u);
        y1 = Math.max(y1, it.p0.y * k + it.d);
      }
      return { x0, x1, y0, y1, fits: x1 - x0 <= boxW && y1 - y0 <= boxH };
    };
    for (let z = config.FIT_MAX_ZOOM; z >= FIT_MIN_ZOOM; z -= 0.5) {
      const e = extent(z);
      if (!e.fits) continue;
      const middle = L.point((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
      const freeMiddle = L.point(ins.left + boxW / 2, ins.top + boxH / 2);
      return { zoom: z, center: map.unproject(middle.add(size.divideBy(2)).subtract(freeMiddle), z) };
    }
    return null;
  }

  // How far (map px) FOLLOW BOARD moves the view for the board (box), with
  // ins the free part. The box always ends up inside the free part. Along
  // the direction it was leaving, it goes about to the middle, and along
  // the other direction it stays where it is. But when another shift keeps
  // more of Manta and the launch pads on the map and clear of covered
  // areas, that one wins (never closer than a sixth of the way from an
  // edge in the leaving direction, so it doesn't nudge the map on every
  // frame).
  function followShift(box, ins, size, covers) {
    const axis = (a0, a1, lo0, hi0) => {
      // Shifts that keep [a0, a1] inside [lo0, hi0].
      const lo = a1 - hi0;
      const hi = a0 - lo0;
      const middle = (lo + hi) / 2;
      if (lo > hi) return { list: [middle], aim: middle };
      const steps = Array.from({ length: 7 }, (_, i) => lo + ((hi - lo) * i) / 6);
      if (lo <= 0 && hi >= 0) return { list: [0, ...steps], aim: 0 };
      // Leaving: not the end that only just brings the box back inside.
      const nearEnd = Math.abs(lo) < Math.abs(hi) ? 0 : 6;
      return { list: steps.filter((_, i) => i !== nearEnd), aim: middle };
    };
    const xs = axis(box.left, box.right, ins.left, size.x - ins.right);
    const ys = axis(box.top, box.bottom, ins.top, size.y - ins.bottom);
    const others = [];
    if (gsMarker) others.push(iconRect(map.latLngToContainerPoint(gsMarker.getLatLng()), DISH_ANCHOR, DISH_SIZE));
    for (const pad of padMarkers.values()) others.push(iconRect(map.latLngToContainerPoint(pad.marker.getLatLng()), START_ANCHOR, [START_SIZE, START_SIZE]));
    let best = null;
    for (const x of xs.list) {
      for (const y of ys.list) {
        const seen = others.filter((r) => !tooClose({ left: r.left - x, right: r.right - x, top: r.top - y, bottom: r.bottom - y }, 4, size, covers)).length;
        const cost = Math.abs(x - xs.aim) + Math.abs(y - ys.aim);
        if (!best || seen > best.seen || (seen === best.seen && cost < best.cost)) best = { x, y, seen, cost };
      }
    }
    return L.point(best.x, best.y);
  }

  // An icon's box (map px) from its point, anchor and size.
  function iconRect(p, anchor, iconSize) {
    return { left: p.x - anchor[0], top: p.y - anchor[1], right: p.x - anchor[0] + iconSize[0], bottom: p.y - anchor[1] + iconSize[1] };
  }

  // True when box b (map px) is within gap of the map's edge or of a
  // covered area.
  function tooClose(b, gap, size, covers) {
    if (b.left < gap || b.top < gap || b.right > size.x - gap || b.bottom > size.y - gap) return true;
    return covers.some((c) => b.right > c.left - gap && b.left < c.right + gap && b.bottom > c.top - gap && b.top < c.bottom + gap);
  }

  // The map's notes: its backgrounds on the map, the 3D view's ground
  // heights and imagery in 3D.
  function statusText() {
    const viewNotes = view === '3d' ? globe?.notes() ?? [] : [satelliteNote, labelsNote, noTilesNote];
    return viewNotes.filter(Boolean).join(' ');
  }

  // ------------------------------------------------------------------
  // No-map panel. Each rocket's row is built once and only its text is
  // updated, so the coordinates can be selected and copied during playback.
  // ------------------------------------------------------------------
  let nomapList = null;
  let gsRow = null;
  const fallbackRows = new Map(); // rocketId -> row parts

  function showFallback(reason, message) {
    if (mode === 'fallback') return;
    removeMap();
    mode = 'fallback';
    fallbackReason = reason;
    nomapList = h('ul', { class: 'fc-nomap-list' });
    gsRow = h('li', { class: 'fc-nomap-gs' });
    fallbackRows.clear();
    // After a tile failure, either background can be tried again with the
    // row's own buttons.
    retryBox = reason === 'tiles'
      ? h('p', { class: 'fc-nomap-note' }, 'Press SATELLITE or DARK MAP to try the map again, or 3D for the 3D view.')
      : null;
    const panel = h('div', { class: 'fc-nomap' },
      h('div', { class: 'fc-nomap-head' },
        h('h3', { class: 'fc-nomap-title' }, 'NO MAP'),
        h('p', { class: 'fc-nomap-note' }, `${message} Map tiles need internet. Tracking still works.`),
        retryBox),
      nomapList);
    showBody(panel);
    if (view === 'map') {
      setText(status, '');
      labels.update([]);
      scaleBox.hidden = true;
    }
    updateLayerControls();
    drawFallback();
  }

  // From the no-map panel: bring the map back with the chosen background.
  function retryMap() {
    if (!L || destroyed) return;
    mode = 'loading';
    fallbackReason = null;
    retryBox = null;
    showBody(canvas);
    startLeaflet(L);
  }

  // A compass with north at the top and an arrow along the bearing from
  // Manta, in the rocket's color.
  function compass(color) {
    const ticks = [90, 180, 270].map((deg) =>
      svg('line', { class: 'fc-compass-tick', x1: 0, y1: -27, x2: 0, y2: -22, transform: `rotate(${deg})` }));
    const arrow = svg('g', {},
      svg('path', { d: 'M0 -16 L6.5 -3 L2.2 -3 L2.2 15 L-2.2 15 L-2.2 -3 L-6.5 -3 Z', fill: color, stroke: config.HALO_COLOR, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    const el = svg('svg', { viewBox: '-32 -32 64 64', class: 'fc-compass', 'aria-hidden': 'true', focusable: 'false' },
      svg('circle', { class: 'fc-compass-ring', r: 27 }),
      ...ticks,
      svg('text', { class: 'fc-compass-n', y: -18.5, 'text-anchor': 'middle' }, 'N'),
      arrow);
    return { el, arrow };
  }

  function fallbackRow(rocket) {
    const { el, arrow } = compass(rocket.profile?.color ?? WHITE);
    const position = h('div', { class: 'fc-nomap-line' });
    const range = h('div', { class: 'fc-nomap-line fc-nomap-range' });
    const fixNote = h('div', { class: 'fc-nomap-line fc-nomap-warn' });
    const li = h('li', { class: 'fc-nomap-item' },
      el,
      h('div', { class: 'fc-nomap-name' }, rocket.profile?.name ?? LABEL_NAMES.board),
      position, range, fixNote);
    return { li, arrow, position, range, fixNote };
  }

  function drawFallback() {
    if (!nomapList) return;
    // The panel keeps its text in the part of the view the HUD leaves free.
    if (view === 'map' && body.isConnected && body.clientWidth > 0) {
      const ins = freeInsets(body);
      const pad = `${Math.round(ins.top)}px ${Math.round(ins.right)}px ${Math.round(ins.bottom)}px ${Math.round(ins.left)}px`;
      if (body.style.padding !== pad) body.style.padding = pad;
    }
    const gs = store.getGroundStation();
    const rockets = store.getRockets();
    const ids = rockets.map((r) => r.id).join('|');
    if (nomapList.dataset.ids !== ids) {
      nomapList.dataset.ids = ids;
      fallbackRows.clear();
      for (const r of rockets) fallbackRows.set(r.id, fallbackRow(r));
      setChildren(nomapList, rockets.map((r) => fallbackRows.get(r.id).li), gsRow);
    }
    for (const rocket of rockets) {
      const row = fallbackRows.get(rocket.id);
      const fix = rocket.lastGoodFix;
      const rb = fix && gs ? rangeAndBearing(gs, fix) : null;
      let position = 'NO GPS DATA';
      if (fix) position = `${formatNumber(fix.lat, 5)}, ${formatNumber(fix.lon, 5)}`;
      else if (rocket.lastPacketT === null) position = 'NO DATA YET';
      else if (rocket.sensorGroups.has('gps')) position = 'NO GPS FIX YET';
      setText(row.position, position);
      setText(row.range, rb ? `${formatRangeBearing(rb)} from Manta` : MISSING);
      if (row.range.hidden !== !gs) row.range.hidden = !gs;
      let note = '';
      if (fix && store.isSilent(rocket)) note = `No recent packets. Last good fix ${formatAge(store.ageOf(fix.t))}`;
      else if (fix && store.gpsIsQuiet(rocket)) note = `No recent GPS data. Last good fix ${formatAge(store.ageOf(fix.t))}`;
      else if (fix && !store.hasFixNow(rocket)) note = `No GPS fix. Last good fix ${formatAge(store.ageOf(fix.t))}`;
      setText(row.fixNote, note);
      row.fixNote.hidden = !note;
      const turn = rb ? `rotate(${rb.bearingDeg.toFixed(1)})` : '';
      if (row.arrow.getAttribute('transform') !== turn) {
        if (turn) row.arrow.setAttribute('transform', turn); else row.arrow.removeAttribute('transform');
      }
      row.arrow.style.display = rb ? '' : 'none';
    }
    gsRow.hidden = !gs;
    if (gs) setText(gsRow, `Manta at ${formatNumber(gs.lat, 5)}, ${formatNumber(gs.lon, 5)}${gs.source === 'config' ? ' (demo position)' : ''}`);
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------

  // When the flight state turns to FLIGHT (liftoff), FOLLOW BOARD switches
  // on by itself, so the camera follows the board up. The viewer can
  // switch it off again.
  function watchFlightState() {
    const now = flightState(store, store.getFocused()).state;
    if (now === STATE.FLIGHT && lastState !== STATE.FLIGHT && !follow) setFollow(true);
    lastState = now;
  }

  const scheduler = createScheduler(() => {
    watchFlightState();
    updateCameraButtons();
    if (view === '3d') {
      // The 3D view draws itself. Only the notes, the camera buttons and
      // the legend are drawn here.
      setText(status, three === 'ready' ? statusText() : '');
      updateLegend();
      if (threeOverMap && three !== 'ready' && mode === 'leaflet') drawLeaflet();
    } else if (mode === 'leaflet') drawLeaflet();
    else if (mode === 'fallback') drawFallback();
    placeCorner();
    if (view === '3d') globe?.relayout();
  }, { maxFps: config.MAP_MAX_FPS });

  // A new source (store-switch.js): forget everything drawn for the old
  // store, and draw the new one from scratch, flying to its site. The 3D
  // view does the same with its own drawing when it hears the change.
  function newSource() {
    lastState = null;
    whole2d = null;
    pendingPackets = false;
    labels.update([]);
    if (keyBox.open) keyBox.open = false;
    setFollow(true);
    if (mode === 'leaflet') {
      clearRocketLayers();
      fitted = false;
      fitPads = 0;
      viewTouched = false;
      flyNext = true;
      // A saved flight still downloading: head for its launch point now.
      const s = session();
      const padPoint = s.loading ? s.entry?.summary?.padPoint : null;
      if (Array.isArray(padPoint) && view === 'map') {
        ownMove = true;
        if (prefersReducedMotion()) map.setView(padPoint, config.MAP_DEFAULT_ZOOM, { animate: false });
        else map.flyTo(padPoint, config.MAP_DEFAULT_ZOOM);
        ownMove = false;
        ownMoveUntil = performance.now() + OWN_MOVE_MS;
      } else if (view === 'map' && !store.getGroundStation() && !store.getRockets().some((r) => r.crumbs?.length)) {
        ownMove = true;
        map.setView(NO_STATION_CENTER, NO_STATION_ZOOM, { animate: !prefersReducedMotion() });
        ownMove = false;
        ownMoveUntil = performance.now() + OWN_MOVE_MS;
      }
    }
    if (mode === 'fallback' && nomapList) nomapList.dataset.ids = '';
    updateCameraButtons();
  }

  const unsubscribe = store.subscribe((change) => {
    const type = change?.type;
    if (type === 'source') newSource();
    else if (type === 'clear') {
      if (mode === 'leaflet') clearRocketLayers();
    } else if (type === 'samples' && !change.quiet) {
      pendingPackets = true;
    }
    scheduler.schedule();
  });

  // The HUD's blocks change size (MORE opens, the timeline appears), so the
  // corner and FOLLOW BOARD look again when they do.
  if ('ResizeObserver' in window) {
    coverObserver = new ResizeObserver(() => scheduler.schedule());
    for (const el of coverElements()) coverObserver.observe(el);
    coverObserver.observe(frame);
    coverObserver.observe(corner);
  }

  // A hook for the browser tests: where every point WHOLE FLIGHT frames is
  // on screen right now, and the free part of the view it aims for. Not
  // used by the page itself.
  root.fcMapTest = {
    fit() {
      if (view === '3d') return globe ? { view, ...globe.debugFit() } : null;
      if (!map) return null;
      const size = map.getSize();
      return {
        view,
        points: wholePoints().map((ll) => map.latLngToContainerPoint(ll)).map((p) => ({ x: p.x, y: p.y })),
        insets: freeInsets(canvas),
        width: size.x,
        height: size.y,
        moving: Boolean(map._animatingZoom || map._panAnim?._inProgress),
      };
    },
    // Where the focused board shows on screen (px in the view) and the
    // free part of the view FOLLOW BOARD keeps it in, with where the camera
    // (or the map's middle) is.
    camera() {
      if (view === '3d') return globe ? { view, ...globe.debugCamera() } : null;
      if (!map) return null;
      const size = map.getSize();
      const focused = store.getFocused();
      const spot = focused ? boardCrumb(focused) : null;
      const p = spot ? map.latLngToContainerPoint([spot.crumb.lat, spot.crumb.lon]) : null;
      const ins = freeInsets(canvas);
      const c = map.getCenter();
      return {
        view,
        mode: follow ? 'follow' : 'free',
        board: p ? { x: p.x, y: p.y } : null,
        free: { x0: ins.left, x1: size.x - ins.right, y0: ins.top, y1: size.y - ins.bottom },
        width: size.x,
        height: size.y,
        center: [c.lat, c.lng],
        centerPx: (({ x, y }) => [x, y])(map.project(c, map.getZoom())),
        zoom: map.getZoom(),
        moving: Boolean(map._animatingZoom || map._panAnim?._inProgress),
      };
    },
    // How many things each view has drawn right now.
    counts() {
      return {
        view,
        three,
        globe: globe?.debugCounts() ?? null,
        map: map ? { boards: [...rocketLayers.values()].filter((l) => l.marker).length, pads: padMarkers.size, events: eventMarkers.length, station: Boolean(gsMarker), link: Boolean(linkLine), cross: Boolean(crossMarker) } : null,
        labels: labelHost.querySelectorAll('.fc-lbl').length,
        labelsShown: [...labelHost.querySelectorAll('.fc-lbl.is-shown')].map((el) => el.textContent),
      };
    },
  };

  // The frame opens on the view the viewer last picked in this visit, or
  // on DEFAULT_VIEW before they have picked one.
  applyView();
  if ((chosenView ?? config.DEFAULT_VIEW) === '3d') openThree();

  return {
    destroy() {
      destroyed = true;
      threeGen += 1;
      clearTimeout(slowTimer);
      clearTimeout(retryTimer);
      coverObserver?.disconnect();
      unsubscribe();
      scheduler.cancel();
      destroyGlobe();
      removeMap();
      labels.destroy();
      controls.remove();
      delete root.fcMapTest;
    },
  };
}
