// map-view.js
// The 3D view's frame, and the 2D map it falls back to.
//
// The console's first panel is the 3D view (globe-view.js), in every mode.
// This file starts it, shows "Loading the 3D view..." until its first
// picture is in, and owns its small controls in the bottom left corner:
// the camera buttons (FOLLOW, WHOLE FLIGHT, RESET VIEW) and the KEY, which
// opens a short legend for the markers and lines. If the 3D
// view can't start (no WebGL, no internet, a lost context), it says why and
// offers the 2D map below instead.
//
// The 2D map: the same markers as the 3D view (markers.js). Each rocket
// is a board marker with orange pulse rings while its GPS fix is good,
// and a thin trail that fades out behind it like a comet's tail (the
// focused rocket's in orange, the others thinner in their own colors).
// The start point (the launch point in a replay) is a small off-white dot,
// and the ground station a small off-white dish. Only good GPS positions
// are ever drawn. A fix gap, or a stretch with no position at all, is left
// as a break in the trail. There are no text labels on the map: the
// readings panel says what they used to say.
//
// A store with no ground station (a board on the bench) has no dish and
// no line to it: the map leaves both out, and the KEY drops their rows.
//
// With no GPS fix (or no recent packets at all), the board marker turns
// hollow at its last good position and its rings stop, and the line to
// the ground station dims. The marker always stands upright: no board
// sends orientation data, so it never turns.
//
// Two map backgrounds: Esri satellite imagery (the default, with Esri's
// labels on top unless "Labels" is unchecked) and CARTO's dark map. The
// browser remembers the viewer's choice. If Esri turns the key down or the
// imagery keeps failing, the map shows the dark map and says so. The key
// check is shared by every map in the visit (esri.js), so a yes from Esri
// counts for the whole visit.
//
// The console's overlays (the replay's clock and phase strip, the readings
// panel and the altitude timeline, from other views) float over the frame,
// and so do this frame's own controls. Anything in the stage marked
// data-fc-cover counts as covered, and the first view and Follow keep
// the markers clear of covered areas.
//
// If Leaflet didn't load, or the map tiles keep failing, the map is
// replaced by a "No map" panel with each rocket's position, distance and
// bearing, and an arrow. Tracking keeps working either way. After a tile
// failure the panel offers both backgrounds to try again. If Leaflet shows
// up late (slow connection), the real map takes over.
//
// The frame opens on DEFAULT_VIEW (config.js), which is the 3D view, so
// Cesium downloads then (cesium-loader.js). While the 3D view shows, the
// map's own buttons (Satellite, Dark map) stay out of sight. They only show
// on the 2D map, next to a "3D" button to try the 3D view again. After the
// viewer goes to the map, later screens in the same visit open on it. The
// map stays alive underneath while 3D is showing, so switching back is
// instant, and following the rocket is one setting shared by both.
//
// Used by: main.js. Reads the store, and the 3D view it starts (for its
// notes and camera mode). Never other views.

import { h, svg, setText, setChildren, createScheduler, prefersReducedMotion, markerClass } from './dom.js';
import { rangeAndBearing, formatRangeBearing, formatAge, formatNumber, MISSING } from '../geo.js';
import { iconNode } from './icons.js?v=2';
import {
  boardSvg, BOARD_FOCUSED, BOARD_OTHER, startSvg, START_SIZE, dishSvg, DISH_SIZE, DISH_ANCHOR,
  TRAIL_WINDOW_S, TRAIL_WIDTH_PX, TRAIL_OTHER_WIDTH_PX,
} from './markers.js';
import { checkEsriKey } from './esri.js';
import { FLIGHT_WORDS } from './hud-text.js?v=3';
import { loadCesium } from './cesium-loader.js';

// Leaflet's own separator between credits.
const CREDIT_SEP = ' <span aria-hidden="true">|</span> ';

// The trail fades in this many steps of opacity (one line each), from
// nothing at its far end to TRAIL_ALPHA at the marker, along this power of
// the share of the window left, as in the 3D view.
const TRAIL_STEPS = 10;
const TRAIL_ALPHA = 0.95;
const TRAIL_FADE_POWER = 1.6;
// The start point's dot sits with its middle on the spot.
const START_ANCHOR = [START_SIZE / 2, START_SIZE / 2];
// Room (px) the first view keeps between a marker and the map's edge or a
// covered area, when FIT_PADDING_PX doesn't fit.
const FIT_ROOM_PX = 12;
// The first view zooms out at most to here.
const FIT_MIN_ZOOM = 3;
// When no part of the map leaves FOLLOW_EDGE_PX around the rocket, Follow
// settles for this much room (px).
const FOLLOW_TIGHT_PX = 8;
// Each trail sample in a KEY gets its own gradient id.
let trailKeyCount = 0;
// Leaflet stacks markers by screen height plus this offset. These keep the
// focused rocket on top, then the other rockets, the ground station and
// the pads.
const Z_OFFSET = { pad: 0, gs: 10000, rocket: 20000, focused: 30000 };
// How long (ms) Follow waits after starting a pan before it checks again.
const FOLLOW_PAN_MS = 600;
// Where the map waits before the first position when there is no ground
// station to start on: most of the world, until the first view fits.
const NO_STATION_CENTER = [20, 0];
const NO_STATION_ZOOM = 2;

const isLayer = (value) => value === 'satellite' || value === 'dark';

// The view the viewer last picked, 'map' or '3d', or null before they have
// picked one. It lasts for this visit only, so every visit starts on
// DEFAULT_VIEW.
let chosenView = null;

export function createMapView(root, ctx) {
  const { store, config, libs } = ctx;
  // What to call the thing being tracked (a rocket, or a board on a desk).
  const words = ctx.words ?? FLIGHT_WORDS;

  // ------------------------------------------------------------------
  // Page elements
  // ------------------------------------------------------------------
  const followBox = h('input', { type: 'checkbox', checked: true, onchange: () => { setFollow(followBox.checked); scheduler.schedule(); } });
  const followLabel = h('label', { class: 'fc-map-check' }, followBox, words.follow);
  const canvas = h('div', { class: 'fc-map-canvas', role: 'region', 'aria-label': words.mapLabel });
  const waitBox = h('div', { class: 'fc-map-wait' }, 'Loading the map...');

  // Map background and view: Satellite and Dark map are the two map
  // backgrounds, and 3D swaps the map for the 3D view. A labels switch
  // shows while Satellite is on. "Map" only stands in for the two
  // backgrounds while the map library is missing, as the way back from 3D.
  const satelliteBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectLayer('satellite') }, 'SATELLITE');
  const darkBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectLayer('dark') }, 'DARK MAP');
  const mapBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectMap() }, 'MAP');
  const threeBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectThree() }, '3D');
  const labelsBox = h('input', { type: 'checkbox', checked: true, onchange: () => setLabels(labelsBox.checked) });
  const labelsLabel = h('label', { class: 'fc-map-check' }, labelsBox, 'Labels');
  const layerSeg = h('div', { class: 'fc-seg' }, satelliteBtn, darkBtn, threeBtn);
  const layerPick = h('div', { class: 'fc-layer-pick', role: 'group', 'aria-label': 'Map background and view' },
    layerSeg, labelsLabel);

  // The 3D camera buttons, in place of the "Follow rocket" checkbox while
  // the 3D view is showing. Button labels are written in capitals.
  const followBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'true', onclick: () => setFollow(!follow) }, words.follow.toUpperCase());
  const wholeBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => { setFollow(false); globe?.showWholeFlight(); updateCameraButtons(); } }, (words.whole ?? '').toUpperCase());
  const resetBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', onclick: () => { globe?.resetView(); updateCameraButtons(); } }, 'RESET VIEW');
  // A board on a desk has no flight to frame, so it gets no "Whole flight".
  const cameraPick = h('div', { class: 'fc-seg fc-cam-pick', role: 'group', 'aria-label': '3D camera', hidden: true },
    followBtn, words.whole ? wholeBtn : null, resetBtn);

  // The legend, behind a small KEY toggle at the end of the controls.
  // Closed at first. It shows the same markers and lines as the map and
  // the 3D view, and says "(demo position)" while the ground station is
  // the config placeholder.
  const legendGsText = h('span', {}, 'Ground station');
  // The ground station row hides while there is no ground station.
  const legendGsRows = [
    legendRow(iconNode(dishSvg()), legendGsText),
  ];
  // The 3D view marks apogee, the parachutes and landing in the sky with
  // the altitude timeline's symbol. The 2D map doesn't, so this row only
  // shows in 3D (see applyView). A board on a desk has none.
  const legendEventRow = words.event
    ? legendRow(h('span', { class: markerClass('detected') }), words.event)
    : null;
  const legend = h('div', { class: 'fc-map-legend' },
    legendRow(iconNode(boardSvg(BOARD_FOCUSED)), words.marker),
    legendRow(iconNode(boardSvg(BOARD_FOCUSED, { hollow: true })), 'No position fix right now'),
    legendRow(trailKey(), `${words.track}, last ${TRAIL_WINDOW_S} seconds`),
    legendRow(iconNode(startSvg()), words.pad),
    ...legendGsRows,
    legendEventRow);
  const keyBox = h('details', { class: 'fc-map-key', hidden: true },
    h('summary', { class: 'fc-btn fc-btn--sm fc-map-key-toggle' }, 'KEY'),
    legend);

  // Bottom left corner: the controls, with the frame's notes above them.
  const controls = h('div', { class: 'fc-map-controls' }, layerPick, followLabel, cameraPick, keyBox);
  const status = h('p', { class: 'fc-map-status', role: 'status' });
  const topLeft = h('div', { class: 'fc-map-topleft' }, controls, status);

  // The 3D view's box. It fills the same frame as the map. globeCanvas
  // holds Cesium's own elements, globeCredits its logo and data credits,
  // and globePanel the loading and failure messages.
  // (It can take keyboard focus: the arrow keys move its camera.)
  const globeCanvas = h('div', {
    class: 'fc-globe-canvas',
    role: 'region',
    tabindex: '0',
    'aria-label': `${words.globeLabel}. The arrow keys move the camera around, and plus and minus zoom.`,
  });
  const globeCredits = h('div', { class: 'fc-globe-credits' });
  const globePanel = h('div', { class: 'fc-globe-panel', hidden: true });
  // Screen readers hear the 3D side's messages from this one line. It is
  // always in the page and only its words change, which is what they
  // announce reliably.
  const globeSay = h('p', { class: 'sr-only', role: 'status' });
  const globeBox = h('div', { class: 'fc-globe', hidden: true }, globeCanvas, globeCredits, globePanel);
  // Cesium's "Data attribution" dialog opens in this box. It goes on the
  // stage, above the overlays (the readings panel and the timeline), so they can't
  // cover the data credits (see startThree).
  const globeDialogs = h('div', { class: 'fc-globe-dialogs' });

  controls.hidden = true;

  // The controls come first, so Tab reaches them before the map (and then
  // Leaflet's zoom buttons and credits). They float above it either way.
  const frame = h('div', { class: 'fc-map-frame' }, topLeft, canvas, waitBox, globeBox, globeSay);

  setChildren(root, h('section', { class: 'fc-mapbox', 'aria-labelledby': 'fc-map-title' },
    h('h2', { class: 'sr-only', id: 'fc-map-title' }, words.globeLabel),
    frame));

  // On narrow screens Cesium's credits sit on their own line just above
  // the bottom left corner's controls and notes (flight-console.css). The
  // controls wrap to two rows on a small phone, so their height is kept in
  // --fc-ctl-h on the frame.
  const cornerObserver = 'ResizeObserver' in window
    ? new ResizeObserver(() => frame.style.setProperty('--fc-ctl-h', `${Math.round(topLeft.offsetHeight)}px`))
    : null;
  cornerObserver?.observe(topLeft);

  // A short sample of the trail for the legend: thin orange, fading out
  // toward its far end (the left).
  function trailKey() {
    const id = `fc-trail-fade-${trailKeyCount += 1}`;
    return svg('svg', { width: 28, height: 10, viewBox: '0 0 28 10', 'aria-hidden': 'true', focusable: 'false' },
      // (In the line's own units: a flat line has no height, and a gradient
      // sized to that draws nothing.)
      svg('defs', {}, svg('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 2, x2: 26, y1: 5, y2: 5 },
        svg('stop', { offset: 0, 'stop-color': config.TRACK_COLOR, 'stop-opacity': 0 }),
        svg('stop', { offset: 0.6, 'stop-color': config.TRACK_COLOR, 'stop-opacity': 0.42 }),
        svg('stop', { offset: 1, 'stop-color': config.TRACK_COLOR, 'stop-opacity': TRAIL_ALPHA }))),
      svg('line', { x1: 2, y1: 5, x2: 26, y2: 5, stroke: `url(#${id})`, 'stroke-width': TRAIL_WIDTH_PX }));
  }

  function legendRow(key, text) {
    return h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-key' }, key), text);
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let mode = 'loading';     // 'loading', 'leaflet' or 'fallback'
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
  let resizeObserver = null;
  let coverObserver = null;
  const rocketLayers = new Map(); // rocketId -> layers for that rocket
  const padMarkers = new Map();   // rocketId -> { marker, parts }
  let gsMarker = null;
  let gsParts = null;
  let cornerBR = null;            // Leaflet's bottom right corner (zoom and credits)
  let cornerStyle = '';

  // Map or 3D
  let view = 'map';        // 'map' or '3d': which one the frame shows
  let three = 'off';       // the 3D side: 'off', 'loading', 'ready' or 'failed'
  let threeGen = 0;        // goes up on every start, so an answer meant for an old one is ignored
  let globe = null;        // the 3D view once it is running (globe-view.js)
  let body = canvas;       // what the 2D side shows: the map or the no-map panel
  let retryBox = null;     // where the background buttons sit in the no-map panel

  // Map background
  let chosenLayer = readSavedLayer() ?? (isLayer(config.DEFAULT_MAP_LAYER) ? config.DEFAULT_MAP_LAYER : 'satellite');
  let shownLayer = null;   // 'satellite' or 'dark' while the map is up
  let showLabels = true;
  let baseTiles = null;
  let labelTiles = null;
  // Goes up every time the background changes or the map goes away, so
  // answers meant for an old background are ignored.
  let tileGen = 0;
  let credit = null;       // the credit line now on the map
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

  // Puts the map (or the no-map panel) in the frame, after the controls.
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
    // The controls and the KEY show first, so the map starts at its real size.
    controls.hidden = false;
    keyBox.hidden = false;
    layerPick.hidden = false;
    followLabel.hidden = false;
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
      // Zoom buttons in the bottom right corner, above the credits.
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      // A distance scale, useful for recovery with or without tiles.
      L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      cornerBR = canvas.querySelector('.leaflet-bottom.leaflet-right');
      cornerStyle = '';
      // Esri's labels sit above the photos and below everything drawn here.
      // The dark outlines get their own layer just under the lines.
      makePane('fc-labels', 300);
      makePane('fc-halo', 390);
      // The credit line shows one line until it is hovered, focused or tapped.
      const creditBox = map.attributionControl.getContainer();
      creditBox.addEventListener('click', (e) => {
        if (!e.target.closest('a')) creditBox.classList.toggle('fc-credit-open');
      });
      // After any pan or zoom (Follow's own pans included), Follow looks
      // again at the new view, even if playback is paused.
      map.on('moveend', () => scheduler.schedule());
      // Dragging the map means you want to look around: stop following.
      map.on('dragstart', () => {
        viewTouched = true;
        if (!follow) return;
        setFollow(false);
      });
      // Zooming by hand keeps the first view from fitting itself again.
      map.on('zoomstart', () => {
        if (!ownMove) viewTouched = true;
      });
      if ('ResizeObserver' in window) {
        // A new map size (a turned phone, a resized window) fits the first
        // view again, so nothing ends up cut off or under a panel, unless
        // the viewer has already moved the map themselves.
        let lastSize = null;
        resizeObserver = new ResizeObserver(() => {
          // Hidden behind the 3D view: there is no size to measure until
          // the map is back (showMap measures it again).
          if (view === '3d') return;
          map?.invalidateSize();
          const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
          if (lastSize !== null && size !== lastSize && !viewTouched) fitted = false;
          lastSize = size;
          scheduler.schedule();
        });
        resizeObserver.observe(canvas);
        // The readings panel grows when "More readings" opens, so Follow
        // looks again whenever a covering panel changes size.
        coverObserver = new ResizeObserver(() => scheduler.schedule());
        for (const el of coverElements()) coverObserver.observe(el);
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
    coverObserver?.disconnect();
    coverObserver = null;
    if (map) {
      map.off();
      map.remove();
    }
    map = null;
    baseTiles = null;
    labelTiles = null;
    shownLayer = null;
    credit = null;
    cornerBR = null;
    rocketLayers.clear();
    padMarkers.clear();
    gsMarker = null;
    gsParts = null;
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

  // A click on "Satellite" or "Dark map". In the no-map panel it brings the
  // map back to try again. From the 3D view it also goes back to the map.
  function selectLayer(which) {
    chosenLayer = which;
    saveLayer(which);
    satelliteNote = '';
    showMap();
    if (mode === 'fallback' && fallbackReason === 'tiles') {
      retryMap();
      return;
    }
    if (mode !== 'leaflet') return;
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
      if (showLabels) addLabels(gen);
      updateCredit();
      scheduler.schedule();
    });
  }

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
      labelsNote = 'The map labels didn\'t load.';
      updateCredit();
      scheduler.schedule();
    });
    tiles.addTo(map);
  }

  function setLabels(on) {
    showLabels = on;
    if (mode !== 'leaflet' || shownLayer !== 'satellite' || !baseTiles) return;
    labelTiles?.remove();
    labelTiles = null;
    labelsNote = '';
    if (on) addLabels(tileGen);
    updateCredit();
    scheduler.schedule();
  }

  // Esri turned the key down, or the photos keep failing: show the dark map
  // instead. The viewer's choice stays "Satellite", so the next visit tries
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
        ? 'On this computer the dark map needs the local CARTO key in js/config.local.js, so tracks show on a plain background. Tracking still works.'
        : 'The dark map needs a CARTO key that isn\'t set up yet, so tracks show on a plain background. Tracking still works.';
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

  // The pressed button shows the background on the map now (the dark map
  // after a satellite failure, with a note saying why), or 3D while the 3D
  // view is showing.
  function updateLayerControls() {
    const in3d = view === '3d';
    const shown = mode === 'leaflet' && !in3d ? shownLayer : null;
    satelliteBtn.setAttribute('aria-pressed', String(shown === 'satellite'));
    darkBtn.setAttribute('aria-pressed', String(shown === 'dark'));
    mapBtn.setAttribute('aria-pressed', String(!in3d));
    threeBtn.setAttribute('aria-pressed', String(in3d));
    // Without the map library there are no backgrounds to pick, so one
    // "Map" button stands in for them.
    const noLibrary = mode === 'fallback' && fallbackReason === 'library';
    const wanted = noLibrary ? [mapBtn, threeBtn] : [satelliteBtn, darkBtn, threeBtn];
    if (wanted.length !== layerSeg.children.length || wanted.some((b, i) => layerSeg.children[i] !== b)) setChildren(layerSeg, wanted);
    labelsLabel.hidden = shown !== 'satellite';
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
    const tilesFailed = mode === 'fallback' && fallbackReason === 'tiles';
    body.hidden = in3d;
    waitBox.hidden = in3d;
    globeBox.hidden = !in3d;
    // The panel covers the 3D view until it is running. Cesium's credits
    // show with the view, not under the panel, where their links could
    // take keyboard focus unseen.
    globePanel.hidden = three === 'ready';
    globeCredits.hidden = three !== 'ready';
    globeDialogs.hidden = !in3d;
    // After a tile failure the background buttons sit in the no-map panel.
    // In 3D they come back to the corner, since they are the way back.
    if (in3d && layerPick.parentNode !== controls) controls.insertBefore(layerPick, followLabel);
    else if (!in3d && tilesFailed && retryBox && layerPick.parentNode !== retryBox) retryBox.append(layerPick);
    // The 3D view is the panel. The map's own buttons only show on the 2D
    // map, the way back to 3D included.
    layerPick.hidden = in3d;
    controls.hidden = in3d ? three !== 'ready' : (mode === 'loading' || tilesFailed);
    followLabel.hidden = in3d || mode !== 'leaflet';
    cameraPick.hidden = !(in3d && three === 'ready');
    keyBox.hidden = in3d ? three !== 'ready' : mode !== 'leaflet';
    if (legendEventRow) legendEventRow.hidden = !in3d;
    updateLayerControls();
    updateCameraButtons();
  }

  // "Follow rocket" is one setting, shared by the map's checkbox and the
  // 3D view's button.
  function setFollow(on) {
    follow = Boolean(on);
    if (followBox.checked !== follow) followBox.checked = follow;
    globe?.setFollow(follow);
    updateCameraButtons();
  }

  function updateCameraButtons() {
    followBtn.setAttribute('aria-pressed', String(follow));
    wholeBtn.setAttribute('aria-pressed', String(!follow && globe?.cameraMode() === 'whole'));
  }

  // Runs a view change and, if keyboard focus was on a button that the
  // change removed, moves it to the button for the view now showing.
  function keepFocus(change) {
    const lost = globePanel.contains(document.activeElement) || body.contains(document.activeElement);
    change();
    // A button that was just hidden still counts as focused until the
    // browser catches up, so check that it can actually be seen.
    const now = document.activeElement;
    if (!lost || (frame.contains(now) && now.getClientRects().length > 0)) return;
    const target = [threeBtn, satelliteBtn, darkBtn, mapBtn].find((b) => b.isConnected && b.getAttribute('aria-pressed') === 'true') ?? threeBtn;
    target.focus({ preventScroll: true });
  }

  // A click on "3D".
  function selectThree() {
    chosenView = '3d';
    keepFocus(() => openThree());
  }

  // The "Map" button and "Back to the map".
  function selectMap() {
    keepFocus(() => showMap());
  }

  // Shows the 3D side and starts it if it isn't running. Cesium downloads
  // here the first time, whether a flight opened on 3D or the viewer
  // clicked "3D".
  function openThree() {
    const was = view;
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
    setText(globeSay, '');
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
  // "Loading" panel stays up until the view says its first picture is in
  // (the ground, and the rocket if there is one to draw).
  function startThree() {
    const gen = ++threeGen;
    three = 'loading';
    showThreePanel('loading');
    Promise.all([loadCesium(), import('./globe-view.js?v=5')]).then(([Cesium, module]) => {
      if (destroyed || gen !== threeGen) return;
      // They went back to the map while it loaded. The next click on 3D
      // starts it, with no download left to wait for.
      if (view !== '3d') {
        three = 'off';
        return;
      }
      try {
        root.closest('.fc-stage')?.append(globeDialogs);
        globe = module.createGlobeView(globeCanvas, ctx, {
          Cesium,
          credits: globeCredits,
          dialogs: globeDialogs,
          follow,
          covers: () => rectsOver(globeCanvas, [...coverElements(), controls, status, globeCredits], []),
          onReady: () => {
            if (destroyed || gen !== threeGen) return;
            three = 'ready';
            setText(globeSay, '');
            applyView();
            scheduler.schedule();
          },
          onChange: () => scheduler.schedule(),
          // Sliding the 3D view away from the rocket stops following it,
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

  const THREE_PROBLEMS = {
    load: 'The 3D view needs internet to load. The map view still works.',
    start: 'The 3D view couldn\'t start in this browser. The map view still works.',
    stopped: 'The 3D view stopped working. The map view still works.',
  };

  function failThree(kind, err) {
    console.warn('Flight Console: the 3D view is not available', err);
    threeGen += 1;
    destroyGlobe();
    three = 'failed';
    showThreePanel(kind);
    applyView();
    scheduler.schedule();
  }

  function destroyGlobe() {
    try {
      globe?.destroy();
    } catch (err) {
      console.warn('Flight Console: error closing the 3D view', err);
    }
    globe = null;
    globeCanvas.replaceChildren();
    globeCredits.replaceChildren();
    globeDialogs.replaceChildren();
    globeDialogs.remove();
  }

  // What the panel over the 3D view says: "Loading", or why there is no
  // 3D view.
  function showThreePanel(kind) {
    if (kind === 'loading') {
      setChildren(globePanel, h('p', { class: 'fc-globe-wait' }, 'Loading the 3D view...'));
      setText(globeSay, 'Loading the 3D view...');
      return;
    }
    const back = h('button', { type: 'button', class: 'fc-btn', onclick: () => selectMap() }, 'BACK TO THE MAP');
    const problem = THREE_PROBLEMS[kind] ?? THREE_PROBLEMS.load;
    setChildren(globePanel, h('div', { class: 'fc-globe-card fc-globe-card--warn' },
      h('h3', { class: 'fc-nomap-title' }, 'No 3D view'),
      h('p', { class: 'fc-nomap-note' }, problem),
      h('div', { class: 'fc-globe-actions' }, back)));
    setText(globeSay, `No 3D view. ${problem}`);
  }

  // ------------------------------------------------------------------
  // Covered areas: the parts of the map hidden under the console's overlays
  // (the clock, phase strip, readings panel and altitude timeline), its
  // arrow tabs and this frame's own controls. Measured on every draw,
  // because they change size.
  // ------------------------------------------------------------------
  function coverElements() {
    const stage = root.closest('.fc-stage');
    const panels = stage ? [...stage.querySelectorAll('[data-fc-cover]')] : [];
    // The console's arrow tabs at the panel's edges cover a little of the
    // view too. (A hidden one has no size, so it doesn't count.)
    const tabs = [...(root.closest('.fc-screens')?.querySelectorAll('.fc-flip') ?? [])];
    return [...panels, ...tabs];
  }

  // Rectangles in map pixels ({ left, top, right, bottom }) for everything
  // that overlaps the map. Leaflet's zoom buttons, distance scale and credit
  // line count too.
  function coveredRects() {
    if (!map) return [];
    const leafletBits = ['.leaflet-control-zoom', '.leaflet-control-scale', '.leaflet-control-attribution'].map((sel) => canvas.querySelector(sel));
    const panels = coverElements();
    return rectsOver(canvas, [...panels, controls, status, ...leafletBits], panels);
  }

  // The parts of elements that overlap boxEl, in boxEl's own pixels. The 3D
  // view uses the same measuring for WHOLE FLIGHT.
  function rectsOver(boxEl, elements, panels) {
    const box = boxEl.getBoundingClientRect();
    const out = [];
    for (const el of elements) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // panel: one of the other views' panels (the readings panel, say).
      const rect = { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top, panel: panels.includes(el) };
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= box.width || rect.top >= box.height) continue;
      out.push(rect);
    }
    return out;
  }

  // The room (px) to keep free on each side of the map so nothing ends up
  // under a covered area. Each area can be cleared by keeping a band free
  // along its nearest top or bottom edge, or along its nearest left or
  // right edge. Every mix is tried, and score() picks the best one (the
  // closest zoom for the first view, the largest free area for Follow).
  // score() returns null for a mix that doesn't work at all. margin is the
  // extra room past each area and the map's edge, the same on every side,
  // or { top, right, bottom, left }. smallGap, if given, is the room past
  // this map's own small controls instead. With sideways set, the other
  // views' panels are only cleared sideways: the readings panel keeps its
  // width but grows taller when "More readings" opens, so a view that only
  // clears its bottom edge wouldn't last. If no mix works, the result is
  // null, or with roomiest set the mix that leaves the largest free area
  // (the covered areas still count, however little is left).
  function clearInsets(covers, size, margin, score, { sideways = false, smallGap = null, roomiest = false } = {}) {
    const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
    const options = covers.map((c) => {
      const g = c.panel || smallGap === null ? m : { top: smallGap, right: smallGap, bottom: smallGap, left: smallGap };
      const vertical = (c.top + c.bottom) / 2 < size.y / 2 ? { top: c.bottom + g.top } : { bottom: size.y - c.top + g.bottom };
      const horizontal = (c.left + c.right) / 2 < size.x / 2 ? { left: c.right + g.left } : { right: size.x - c.left + g.right };
      return [sideways && c.panel ? horizontal : vertical, horizontal];
    });
    let best = null;
    let widest = null;
    const combos = 2 ** options.length;
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

  // Leaflet's bottom right corner holds the zoom buttons and the credits.
  // It stops short of the controls and scale on the left, and moves left of
  // the readings panel if that panel reaches down to it.
  function placeCorner(size) {
    if (!cornerBR) return;
    const box = canvas.getBoundingClientRect();
    let left = 0;
    for (const el of [topLeft, canvas.querySelector('.leaflet-control-scale')]) {
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.bottom <= box.top || r.top >= box.bottom || r.left >= box.right) continue;
      left = Math.max(left, r.right - box.left + 8);
    }
    // Only a panel beside the corner at the right edge counts, not one
    // above or below it (like the altitude timeline it sits on).
    let right = 0;
    const cornerBottom = cornerBR.getBoundingClientRect().bottom;
    const cornerTop = cornerBottom - cornerBR.offsetHeight - 8;
    for (const el of coverElements()) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.bottom <= cornerTop || r.top >= cornerBottom || r.right - box.left < size.x - 80) continue;
      right = Math.max(right, size.x - (r.left - box.left) + 4);
    }
    const style = `${Math.round(left)}|${Math.round(right)}`;
    if (style === cornerStyle) return;
    cornerStyle = style;
    cornerBR.style.left = `${Math.round(left)}px`;
    cornerBR.style.right = `${Math.round(right)}px`;
  }

  // ------------------------------------------------------------------
  // Drawing: lines
  // ------------------------------------------------------------------

  // A dark outline drawn just under a line, so it stands out on bright
  // photos. weight is the width of the line it outlines.
  function haloStyle(weight, extra = {}) {
    return {
      pane: 'fc-halo',
      color: config.HALO_COLOR,
      opacity: config.HALO_OPACITY,
      weight: weight + 2 * config.HALO_WIDTH_PX,
      fill: false,
      interactive: false,
      ...extra,
    };
  }

  function layersFor(rocket) {
    let layers = rocketLayers.get(rocket.id);
    if (!layers) {
      layers = { tail: [], tailKey: '', marker: null, parts: null };
      rocketLayers.set(rocket.id, layers);
    }
    return layers;
  }

  // True when a draw added a trail line, which lands on top of the others.
  let linesAdded = false;

  // The trail: the good positions from the last TRAIL_WINDOW_S seconds up
  // to the marker, as a thin solid line that fades out toward its far end
  // (TRAIL_STEPS lines, each a little stronger than the one before). It
  // breaks wherever the positions do: the GPS had no fix (gapBefore), or no
  // position came for longer than LINK_STALE_S. Nobody measured the path
  // across a break, so nothing is drawn there. Returns true if it drew.
  function drawTrail(rocket, layers, isFocused) {
    const track = rocket.track;
    const end = track.length - 1;
    const key = `${end}|${isFocused}|${track[end]?.t}`;
    if (key === layers.tailKey) return false;
    layers.tailKey = key;
    for (const line of layers.tail) line.remove();
    layers.tail = [];
    if (end < 1) return false;
    const span = TRAIL_WINDOW_S;
    const tEnd = track[end].t;
    const look = {
      color: isFocused ? config.TRACK_COLOR : rocket.profile.color,
      weight: isFocused ? TRAIL_WIDTH_PX : TRAIL_OTHER_WIDTH_PX,
      lineCap: 'butt',
      interactive: false,
    };
    // Back from the marker, one segment at a time. Neighboring segments in
    // the same step of opacity share one line.
    let group = null;
    const groups = [];
    for (let i = end; i >= 1; i--) {
      const a = track[i - 1];
      const b = track[i];
      if (tEnd - b.t >= span) break;
      if (b.gapBefore || b.t - a.t > config.LINK_STALE_S) {
        group = null;
        continue;
      }
      const share = Math.min(1, Math.max(0, 1 - (tEnd - (a.t + b.t) / 2) / span));
      const step = Math.min(TRAIL_STEPS - 1, Math.floor(share * TRAIL_STEPS));
      if (group && group.step === step) group.points.push([a.lat, a.lon]);
      else {
        group = { step, points: [[b.lat, b.lon], [a.lat, a.lon]] };
        groups.push(group);
      }
    }
    for (const { step, points } of groups) {
      const opacity = TRAIL_ALPHA * ((step + 0.5) / TRAIL_STEPS) ** TRAIL_FADE_POWER;
      layers.tail.push(L.polyline(points, { ...look, opacity }).addTo(map));
    }
    return groups.length > 0;
  }

  // Removes every trail. Markers stay, so a seek doesn't restart the
  // pulse rings.
  function clearTracks() {
    for (const layers of rocketLayers.values()) {
      for (const line of layers.tail) line.remove();
      layers.tail = [];
      layers.tailKey = '';
    }
  }

  // Removes everything drawn for the rockets (a new flight, or a new map).
  function clearRocketLayers() {
    clearTracks();
    for (const layers of rocketLayers.values()) layers.marker?.remove();
    rocketLayers.clear();
    for (const pad of padMarkers.values()) pad.marker.remove();
    padMarkers.clear();
  }

  // The KEY says "(demo position)" while the ground station is the config
  // placeholder. The 3D view shows the same KEY, so this runs for both
  // views.
  function updateLegend() {
    const gs = store.getGroundStation();
    for (const row of legendGsRows) {
      if (row.hidden !== !gs) row.hidden = !gs;
    }
    if (gs) setText(legendGsText, gs.source === 'config' ? 'Ground station (demo position)' : 'Ground station');
  }

  function redrawAll() {
    if (mode !== 'leaflet') return;
    clearRocketLayers();
    // Hidden behind the 3D view, the map has no size to draw into. It
    // draws when it is back (showMap).
    if (view === 'map') drawLeaflet();
  }

  // ------------------------------------------------------------------
  // Drawing: markers. Each marker is built once and then only its classes
  // change, so the pulse rings keep running. Screen readers skip them: the
  // readings panel says the same things in words.
  // ------------------------------------------------------------------
  function markerOptions(parts, size, anchor, zIndexOffset) {
    return {
      icon: L.divIcon({ className: 'fc-mk', html: parts.el, iconSize: size, iconAnchor: anchor }),
      interactive: false,
      keyboard: false,
      zIndexOffset,
    };
  }

  function buildRocketIcon() {
    const rings = h('span', { class: 'fc-rkt-rings' }, h('i'), h('i'), h('i'));
    const iconBox = h('span', { class: 'fc-rkt-icon' });
    const el = h('div', { class: 'fc-rkt', 'aria-hidden': 'true' }, rings, iconBox);
    return { el, iconBox, size: null, iconW: 0, iconH: 0 };
  }

  // Sets the board marker's size (the focused rocket's is bigger).
  function sizeRocketIcon(parts, size) {
    if (parts.size === size) return;
    parts.size = size;
    [parts.iconW, parts.iconH] = size;
    parts.iconBox.replaceChildren(iconNode(boardSvg(size)));
    parts.el.style.setProperty('--w', `${size[0]}px`);
    parts.el.style.setProperty('--h', `${size[1]}px`);
  }

  function buildPadIcon() {
    return { el: h('div', { class: 'fc-pad', 'aria-hidden': 'true' }, iconNode(startSvg())) };
  }

  function buildGsIcon() {
    return { el: h('div', { class: 'fc-gs', 'aria-hidden': 'true' }, iconNode(dishSvg())) };
  }

  // ------------------------------------------------------------------
  // Drawing: one pass over everything
  // ------------------------------------------------------------------
  function drawLeaflet() {
    const rockets = store.getRockets();
    const focused = store.getFocused();
    const gs = store.getGroundStation();

    // Ground station (none at all for a board on the bench)
    updateLegend();
    if (!gs) {
      gsMarker?.remove();
      gsMarker = null;
      gsParts = null;
    } else {
      if (!gsMarker) {
        gsParts = buildGsIcon();
        gsMarker = L.marker([gs.lat, gs.lon], markerOptions(gsParts, DISH_SIZE, DISH_ANCHOR, Z_OFFSET.gs)).addTo(map);
      } else {
        gsMarker.setLatLng([gs.lat, gs.lon]);
      }
    }

    for (const rocket of rockets) {
      const isFocused = focused?.id === rocket.id;
      const layers = layersFor(rocket);

      // Launch pad: the last good position before liftoff.
      const pad = padMarkers.get(rocket.id);
      if (rocket.padPosition) {
        const ll = [rocket.padPosition.lat, rocket.padPosition.lon];
        if (!pad) {
          const parts = buildPadIcon();
          padMarkers.set(rocket.id, { parts, marker: L.marker(ll, markerOptions(parts, [START_SIZE, START_SIZE], START_ANCHOR, Z_OFFSET.pad)).addTo(map) });
        } else {
          pad.marker.setLatLng(ll);
        }
      } else if (pad) {
        pad.marker.remove();
        padMarkers.delete(rocket.id);
      }

      if (drawTrail(rocket, layers, isFocused)) linesAdded = true;

      // The board marker at its last good position: the board's blue with
      // pulse rings while the fix is good, hollow without one.
      const fix = rocket.lastGoodFix;
      if (fix) {
        const ll = [fix.lat, fix.lon];
        // The icon's middle is the position, so the marker box has no size.
        const zIndex = isFocused ? Z_OFFSET.focused : Z_OFFSET.rocket;
        if (!layers.marker) {
          layers.parts = buildRocketIcon();
          layers.marker = L.marker(ll, markerOptions(layers.parts, [0, 0], [0, 0], zIndex)).addTo(map);
        } else {
          layers.marker.setLatLng(ll);
          if (layers.marker.options.zIndexOffset !== zIndex) layers.marker.setZIndexOffset(zIndex);
        }
        const parts = layers.parts;
        sizeRocketIcon(parts, isFocused ? BOARD_FOCUSED : BOARD_OTHER);
        parts.el.classList.toggle('fc-rkt--focus', isFocused);
        parts.el.classList.toggle('fc-rkt--nofix', !store.hasFixNow(rocket));
      } else if (layers.marker) {
        layers.marker.remove();
        layers.marker = null;
        layers.parts = null;
      }
    }

    // A new line lands on top, so the focused rocket's trail goes back above
    // the others.
    const focusedLayers = rocketLayers.get(focused?.id);
    if (linesAdded && focusedLayers) {
      for (const line of focusedLayers.tail) line.bringToFront();
    }
    linesAdded = false;

    // Everything below reads sizes and positions (after all the writes
    // above). The map's size is kept up to date by the ResizeObserver.
    const size = map.getSize();
    const covers = coveredRects();
    const target = focused?.lastGoodFix;
    const focusedParts = target ? focusedLayers?.parts ?? null : null;
    // A map squeezed to almost nothing (hidden, or mid-layout) has no view
    // worth fitting or following yet.
    const usable = size.x >= 120 && size.y >= 120;

    // First view: the pad(s), the focused rocket and the ground station,
    // in the part of the map nothing covers
    // (see firstView). With several rockets, their pads can show up one
    // after another, so the view fits again for each new pad until the
    // viewer drags or zooms the map. Follow waits for the next draw, and
    // the first view keeps the focused rocket further from the edges than
    // Follow's margin, so the view stays put until the rocket really heads
    // off.
    let justFitted = false;
    if ((!fitted || (!viewTouched && padMarkers.size > fitPads)) && usable) {
      const view = firstView(target, focusedParts, gs, size, covers);
      if (view) {
        ownMove = true;
        if (view.bounds) {
          map.fitBounds(view.bounds, { paddingTopLeft: view.paddingTopLeft, paddingBottomRight: view.paddingBottomRight, maxZoom: config.FIT_MAX_ZOOM, animate: false });
        } else {
          map.setView(view.center, view.zoom, { animate: false });
        }
        ownMove = false;
        fitted = true;
        fitPads = padMarkers.size;
        justFitted = true;
      }
    }

    // Follow: when the focused rocket gets near the edge of the map or a
    // covered area, pan so it sits well inside the free part. Like the first view, it moves sideways
    // away from the other views' panels, so a panel that is taller a moment
    // later still doesn't cover the rocket. Where it moves them depends on
    // what else stays in sight (see followShift).
    if (follow && target && usable && !justFitted && performance.now() > followPanUntil) {
      const p = map.latLngToContainerPoint([target.lat, target.lon]);
      const m = config.FOLLOW_EDGE_PX;
      const point = { left: p.x, top: p.y, right: p.x, bottom: p.y };
      if (tooClose(point, m, size, covers)) {
        const area = freeArea(size);
        const ins = clearInsets(covers, size, m, area, { sideways: true }) ??
          clearInsets(covers, size, FOLLOW_TIGHT_PX, area, { sideways: true, roomiest: true });
        const shift = followShift(point, ins, size, covers);
        // Already as centered as it gets (a free part too small for the
        // rocket): no pan, so it doesn't pan on the spot.
        if (Math.abs(shift.x) >= 2 || Math.abs(shift.y) >= 2) {
          const newCenter = map.containerPointToLatLng(size.divideBy(2).add(shift));
          const animate = !prefersReducedMotion();
          ownMove = true;
          map.panTo(newCenter, { animate, duration: 0.5 });
          ownMove = false;
          followPanUntil = animate ? performance.now() + FOLLOW_PAN_MS : 0;
        }
      }
    }

    placeCorner(size);
    setText(status, statusText(focused));
  }

  // ------------------------------------------------------------------
  // The first view. Each thing to show (the launch pads, the focused
  // rocket, the ground station) is a point with the room its marker needs
  // around it in px, plus a little air. The view is the closest zoom at
  // which all of that fits inside the part of the map nothing covers.
  // FIT_PADDING_PX of air is kept when that costs at most half a zoom step,
  // otherwise less. Covered areas always count.
  // ------------------------------------------------------------------
  function firstView(target, rocketParts, gs, size, covers) {
    const pads = [...padMarkers.values()];
    if (!pads.length && !target) return null;
    // The focused rocket stays further than Follow's edge margin from every
    // edge, so Follow doesn't pan right after the first view.
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
        out.push({ ll: L.latLng(target.lat, target.lon), l: Math.max(keep, half), r: Math.max(keep, half), u: Math.max(keep, half), d: Math.max(keep, half) });
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

  // How far (map px) Follow moves the view for the rocket (box), with ins
  // the free part. The box always ends up inside the free
  // part. Along the direction it was leaving, it goes about to the middle,
  // and along the other direction it stays where it is. But when another
  // shift keeps more of the ground station and the launch pads on the map
  // and clear of covered areas, that one wins (never closer than a sixth of
  // the way from an edge in the leaving direction, so Follow doesn't nudge
  // the map on every frame).
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

  function statusText(focused) {
    // Before any data at all (nothing connected yet), there is nothing to
    // say about a fix.
    const anyData = store.getRockets().some((r) => r.lastPacketT !== null);
    const noFixAnywhere = anyData && store.getRockets().every((r) => !r.lastGoodFix);
    let focusNote = '';
    const where = view === '3d' ? 'in the 3D view' : 'on the map';
    if (anyData && focused && !focused.lastGoodFix && !noFixAnywhere) {
      if (focused.lastPacketT === null) focusNote = `${focused.profile.name} hasn't sent any data yet, so it isn't ${where}.`;
      else if (focused.sensorGroups.has('gps')) focusNote = `${focused.profile.name} has no GPS fix yet, so it isn't ${where}.`;
      else focusNote = `${focused.profile.name} has sent no GPS data, so it isn't ${where}.`;
    }
    // Each view adds its own notes: the map's backgrounds, or the 3D
    // view's ground heights and imagery.
    const viewNotes = view === '3d' ? globe?.notes() ?? [] : [satelliteNote, labelsNote, noTilesNote];
    return [noFixAnywhere ? words.noFix : '', focusNote, ...viewNotes]
      .filter(Boolean).join(' ');
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
    // Following and the legend mean nothing without a map, so they go away
    // (applyView, through showBody below).
    nomapList = h('ul', { class: 'fc-nomap-list' });
    gsRow = h('li', { class: 'fc-nomap-gs' });
    fallbackRows.clear();
    // After a tile failure, either background can be tried again. The
    // buttons move here from the map's corner, and back when the map returns.
    retryBox = reason === 'tiles'
      ? h('div', { class: 'fc-nomap-retry' }, h('p', { class: 'fc-nomap-note' }, 'Try loading a map background again, or use the 3D view.'))
      : null;
    // Without the map library, the "Map" and "3D" buttons float over the
    // panel's top left corner, so the panel starts below them.
    const panel = h('div', { class: reason === 'library' ? 'fc-nomap fc-nomap--controls' : 'fc-nomap' },
      h('div', { class: 'fc-nomap-head' },
        h('h3', { class: 'fc-nomap-title' }, 'No map'),
        h('p', { class: 'fc-nomap-note' }, `${message} Map tiles need internet. Tracking still works.`),
        retryBox),
      nomapList);
    showBody(panel);
    if (view === 'map') setText(status, '');
    updateLayerControls();
    drawFallback();
  }

  // From the no-map panel: bring the map back with the chosen background.
  function retryMap() {
    if (!L || destroyed) return;
    mode = 'loading';
    fallbackReason = null;
    retryBox = null;
    controls.insertBefore(layerPick, followLabel);
    showBody(canvas);
    startLeaflet(L);
  }

  // A compass with north at the top and an arrow along the bearing from the
  // ground station, in the rocket's color.
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
    const { el, arrow } = compass(rocket.profile.color);
    const position = h('div', { class: 'fc-nomap-line' });
    const range = h('div', { class: 'fc-nomap-line fc-nomap-range' });
    const fixNote = h('div', { class: 'fc-nomap-line fc-nomap-warn' });
    const li = h('li', { class: 'fc-nomap-item' },
      el,
      h('div', { class: 'fc-nomap-name' }, h('span', { class: 'fc-dot', style: { '--dot': rocket.profile.color }, 'aria-hidden': 'true' }), rocket.profile.name),
      position, range, fixNote);
    return { li, arrow, position, range, fixNote };
  }

  function drawFallback() {
    if (!nomapList) return;
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
      let position = words.noGpsData;
      if (fix) position = `${formatNumber(fix.lat, 5)}, ${formatNumber(fix.lon, 5)}`;
      else if (rocket.lastPacketT === null) position = words.noData;
      else if (rocket.sensorGroups.has('gps')) position = 'No GPS fix yet';
      setText(row.position, position);
      setText(row.range, rb ? `${formatRangeBearing(rb)} from the ground station` : MISSING);
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
    if (gs) setText(gsRow, `Ground station at ${formatNumber(gs.lat, 5)}, ${formatNumber(gs.lon, 5)}${gs.source === 'config' ? ' (demo position)' : ''}`);
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------
  const scheduler = createScheduler(() => {
    if (view === '3d') {
      // The 3D view draws itself. Only the notes, the camera buttons and
      // the legend are drawn here.
      setText(status, three === 'ready' ? statusText(store.getFocused()) : '');
      updateCameraButtons();
      updateLegend();
    } else if (mode === 'leaflet') drawLeaflet();
    else if (mode === 'fallback') drawFallback();
  }, { maxFps: config.MAP_MAX_FPS });

  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'clear') {
      if (mode === 'leaflet') clearRocketLayers();
    } else if (change.type === 'reset') {
      // A seek: the tracks are drawn again from the start, the icons stay.
      if (mode === 'leaflet') clearTracks();
    }
    scheduler.schedule();
  });

  // The frame opens on the view the viewer last picked in this visit, or
  // on DEFAULT_VIEW before they have picked one.
  if ((chosenView ?? config.DEFAULT_VIEW) === '3d') openThree();

  return {
    destroy() {
      destroyed = true;
      threeGen += 1;
      cornerObserver?.disconnect();
      unsubscribe();
      scheduler.cancel();
      destroyGlobe();
      removeMap();
    },
  };
}
