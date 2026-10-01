// map-view.js
// The map: every rocket's track (the focused rocket's in gold, the others
// thinner in their own colors), a rocket icon for each rocket, the launch
// rail on the pad, the ground station tower in teal, and a dashed teal line
// from the ground station to the focused rocket labeled with distance and
// bearing. Only good GPS positions are ever drawn. Across a fix gap, or a
// stretch with no position at all, the track is dashed. Lines and icons get a thin dark outline so they stand
// out on bright photos.
//
// Each icon has a green HUD label next to it. The rocket's says its name,
// height above ground and vertical speed. With no GPS fix (or no recent
// packets at all), the rocket turns grey and hollow at its last good
// position, its sonar rings stop, and the label says why and for how long.
// The distance label then says "Last known" and the teal line dims. The rocket icon always points straight up: no board sends
// orientation data, so it never turns.
//
// Two map backgrounds: Esri satellite imagery (the default, with Esri's
// labels on top unless "Labels" is unchecked) and CARTO's dark map. The
// browser remembers the viewer's choice. If Esri turns the key down or the
// imagery keeps failing, the map shows the dark map and says so. The key
// check is shared with the launcher's map picture (esri.js), so a yes from
// Esri counts for the whole visit.
//
// The readings panel and the altitude tape float over the map (other
// views), and so do this map's own controls and legend. Anything in the
// stage marked data-fc-cover counts as covered, and the first view, Follow
// and the labels all keep clear of covered areas.
//
// If Leaflet didn't load, or the map tiles keep failing, the map is
// replaced by a "No map" panel with each rocket's position, distance and
// bearing, and an arrow. Tracking keeps working either way. After a tile
// failure the panel offers both backgrounds to try again. If Leaflet shows
// up late (slow connection), the real map takes over.
//
// Used by: main.js. Reads the store, never other views.

import { h, svg, setText, setChildren, createScheduler, prefersReducedMotion } from './dom.js';
import { rangeAndBearing, formatRangeBearing, formatAge, formatNumber, MISSING } from '../geo.js';
import { rocketSvg, rocketBox, padSvg, PAD_SIZE, PAD_ANCHOR, towerSvg, TOWER_SIZE, TOWER_ANCHOR, iconNode } from './icons.js';
import { checkEsriKey } from './esri.js';

// The views the switcher offers. Only views that really work are listed.
// A 3D view (CesiumJS) plugs in here later: add it to this list and the
// switcher shows up at the start of the map controls.
const VIEW_MODES = [{ id: 'map', label: 'Map' }];

// The fix-gap line pattern: dash and space lengths in pixels.
const GAP_DASH = '4 8';
// The ground station line pattern.
const GS_DASH = '7 6';

// Leaflet's own separator between credits.
const CREDIT_SEP = ' <span aria-hidden="true">|</span> ';

// Space (px) between an icon and its HUD label.
const LABEL_GAP_PX = 8;
// When neither side has room, a rocket's label goes under (or over) its
// icon, this far (px) from the icon's edge.
const ROCKET_LABEL_BELOW_PX = 4;
// Launch pads closer than this on screen (px) share one "LAUNCH POINT"
// label. Two labels that close would sit on top of each other anyway.
const PAD_LABEL_MERGE_PX = 40;
// The ground station's label, when neither side has room: centered, this
// far (px) under the tower's base point.
const GS_LABEL_BELOW_PX = 6;
// When neither side has room, the launch point's label goes this far (px)
// under the spot, clear of the pad ring and a rocket sitting there.
const PAD_LABEL_BELOW_PX = 18;
// Choosing a label's side: each px² of label off the map or under a
// covered area counts this many times more than a px² on top of another
// label or icon, so a label only leaves the map, or slides under a panel,
// when every other place does too.
const HIDDEN_LABEL_COST = 10;
// Room (px) the first view keeps between a label (or icon) and the map's
// edge or a covered area.
const FIT_ROOM_PX = 12;
// The first view zooms out at most to here to make room for the labels.
const FIT_MIN_ZOOM = 3;
// Follow also pans once the focused rocket's label comes this close (px)
// to the map's edge or a covered area, before it slides under a panel.
const FOLLOW_LABEL_GAP_PX = 8;
// The teal line to the ground station while the focused rocket has no fix
// right now: dimmer, since it ends at an old position.
const GS_LINE_OPACITY = 0.95;
const GS_LINE_STALE_OPACITY = 0.4;
// Leaflet stacks markers by screen height plus this offset. These keep the
// focused rocket on top, then the other rockets, the ground station and
// the pads.
const Z_OFFSET = { pad: 0, gs: 10000, rocket: 20000, focused: 30000 };
// How long (ms) Follow waits after starting a pan before it checks again.
const FOLLOW_PAN_MS = 600;

const isLayer = (value) => value === 'satellite' || value === 'dark';

export function createMapView(root, ctx) {
  const { store, config, libs } = ctx;

  // ------------------------------------------------------------------
  // Page elements
  // ------------------------------------------------------------------
  const followBox = h('input', { type: 'checkbox', checked: true, onchange: () => { follow = followBox.checked; scheduler.schedule(); } });
  const followLabel = h('label', { class: 'fc-map-check' }, followBox, 'Follow rocket');
  // A group of toggle buttons, one per view, only once there is a choice.
  const switcher = VIEW_MODES.length > 1
    ? h('div', { class: 'fc-seg fc-map-views', role: 'group', 'aria-label': 'View' },
      VIEW_MODES.map((m, i) => h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': String(i === 0) }, m.label)))
    : null;
  const canvas = h('div', { class: 'fc-map-canvas', role: 'region', 'aria-label': 'Map of rocket positions' });
  const waitBox = h('div', { class: 'fc-map-wait' }, 'Loading the map...');

  // Map background: two buttons, and a labels switch while Satellite is on.
  const satelliteBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectLayer('satellite') }, 'Satellite');
  const darkBtn = h('button', { type: 'button', class: 'fc-btn fc-btn--sm', 'aria-pressed': 'false', onclick: () => selectLayer('dark') }, 'Dark map');
  const labelsBox = h('input', { type: 'checkbox', checked: true, onchange: () => setLabels(labelsBox.checked) });
  const labelsLabel = h('label', { class: 'fc-map-check' }, labelsBox, 'Labels');
  const layerPick = h('div', { class: 'fc-layer-pick', role: 'group', 'aria-label': 'Map background' },
    h('div', { class: 'fc-seg' }, satelliteBtn, darkBtn), labelsLabel);

  // Top left corner: the controls, with the map's notes under them.
  const controls = h('div', { class: 'fc-map-controls fc-float' }, switcher, layerPick, followLabel);
  const status = h('p', { class: 'fc-map-status', role: 'status' });
  const topLeft = h('div', { class: 'fc-map-topleft' }, controls, status);

  // The legend. Says "(demo position)" while the ground station is the
  // config placeholder. The dashed line covers both kinds of gap: no GPS
  // fix, and no packets at all for a while.
  const legendGsText = h('span', {}, 'Ground station');
  const legend = h('div', { class: 'fc-map-legend fc-float', 'aria-hidden': 'true' },
    legendRow(lineKey(config.TRACK_COLOR, 3, null), 'Rocket track'),
    legendRow(lineKey(config.TRACK_COLOR, 2, '3 4'), 'No GPS position'),
    legendRow(iconNode(padSvg()), 'Launch point'),
    legendRow(iconNode(towerSvg()), legendGsText),
    legendRow(lineKey(config.GROUND_STATION_COLOR, 2, '5 3'), 'Distance to ground station'));
  legend.hidden = true;
  controls.hidden = true;

  // The controls come first, so Tab reaches them before the map (and then
  // Leaflet's zoom buttons and credits). They float above it either way.
  const frame = h('div', { class: 'fc-map-frame' }, topLeft, canvas, waitBox);

  setChildren(root, h('section', { class: 'fc-mapbox', 'aria-labelledby': 'fc-map-title' },
    h('h2', { class: 'sr-only', id: 'fc-map-title' }, 'Map'),
    frame,
    legend));

  // A short sample of a map line for the legend, with the same dark outline.
  function lineKey(color, weight, dash) {
    const line = (stroke, width) => svg('line', {
      x1: 2, y1: 5, x2: 26, y2: 5, stroke, 'stroke-width': width, 'stroke-dasharray': dash, 'stroke-opacity': stroke === color ? 1 : config.HALO_OPACITY,
    });
    return svg('svg', { width: 28, height: 10, viewBox: '0 0 28 10', 'aria-hidden': 'true', focusable: 'false' },
      line(config.HALO_COLOR, weight + 2 * config.HALO_WIDTH_PX), line(color, weight));
  }

  function legendRow(key, text) {
    return h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-key' }, key), text);
  }

  // On wide screens the altitude tape (another view) starts just under
  // these controls and notes. Its top comes from --fc-map-controls-bottom
  // on the stage: their bottom edge, measured from the stage's top, plus a
  // 10 px gap. It is written again whenever they change size (the controls
  // wrap to two rows on a narrow map, and notes come and go). With nothing
  // showing, the stylesheet's default applies.
  const controlsObserver = 'ResizeObserver' in window ? new ResizeObserver(() => updateControlsBottom()) : null;
  controlsObserver?.observe(controls);
  controlsObserver?.observe(status);

  function updateControlsBottom() {
    const stage = root.closest('.fc-stage');
    if (!stage) return;
    let bottom = -Infinity;
    for (const el of [controls, status]) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.height >= 1) bottom = Math.max(bottom, r.bottom);
    }
    const value = Number.isFinite(bottom) ? `${Math.round(bottom - stage.getBoundingClientRect().top + 10)}px` : '';
    if (value === controlsBottom) return;
    controlsBottom = value;
    if (value) stage.style.setProperty('--fc-map-controls-bottom', value);
    else stage.style.removeProperty('--fc-map-controls-bottom');
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
  let gsLine = null;
  let gsLineHalo = null;
  // What the distance label shows now, so it is only changed when needed.
  let gsTip = { text: null, spot: null, stale: null };
  let cornerBR = null;            // Leaflet's bottom right corner (zoom and credits)
  let cornerStyle = '';
  let controlsBottom = null;      // last value written to --fc-map-controls-bottom

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
    setChildren(frame, topLeft, el);
  }

  // ------------------------------------------------------------------
  // Leaflet
  // ------------------------------------------------------------------
  function startLeaflet(leaflet) {
    L = leaflet;
    // The controls and legend show first, so the map starts at its real size
    // (on phones the legend sits under the map and takes some of its height).
    controls.hidden = false;
    legend.hidden = false;
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
      map.setView([gs.lat, gs.lon], config.MAP_DEFAULT_ZOOM);
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
      // After any pan or zoom (Follow's own pans included), place the labels
      // again for the new view, even if playback is paused.
      map.on('moveend', () => scheduler.schedule());
      // Dragging the map means you want to look around: stop following.
      map.on('dragstart', () => {
        viewTouched = true;
        if (!follow) return;
        follow = false;
        followBox.checked = false;
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
          map?.invalidateSize();
          const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
          if (lastSize !== null && size !== lastSize && !viewTouched) fitted = false;
          lastSize = size;
          scheduler.schedule();
        });
        resizeObserver.observe(canvas);
        // The readings panel grows when "More readings" opens, so the
        // labels and Follow look again whenever a covering panel changes size.
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
    gsLine = null;
    gsLineHalo = null;
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
  // map back to try again.
  function selectLayer(which) {
    chosenLayer = which;
    saveLayer(which);
    satelliteNote = '';
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
  // after a satellite failure, with a note saying why).
  function updateLayerControls() {
    const shown = mode === 'leaflet' ? shownLayer : null;
    satelliteBtn.setAttribute('aria-pressed', String(shown === 'satellite'));
    darkBtn.setAttribute('aria-pressed', String(shown === 'dark'));
    labelsLabel.hidden = shown !== 'satellite';
  }

  // ------------------------------------------------------------------
  // Covered areas: the parts of the map hidden under the readings panel,
  // the altitude tape and this map's own controls. Measured on every draw,
  // because they change size (and on phones they sit below the map).
  // ------------------------------------------------------------------
  function coverElements() {
    const stage = root.closest('.fc-stage');
    return stage ? [...stage.querySelectorAll('[data-fc-cover]')] : [];
  }

  // Rectangles in map pixels ({ left, top, right, bottom }) for everything
  // that overlaps the map. Leaflet's zoom buttons, distance scale and credit
  // line count too.
  function coveredRects() {
    if (!map) return [];
    const box = canvas.getBoundingClientRect();
    const leafletBits = ['.leaflet-control-zoom', '.leaflet-control-scale', '.leaflet-control-attribution'].map((sel) => canvas.querySelector(sel));
    const out = [];
    const panels = coverElements();
    for (const el of [...panels, controls, status, legend, ...leafletBits]) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // panel: one of the other views' panels (the readings or the tape).
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
  // It stops short of the legend and scale on the left, and moves left of
  // the readings panel if that panel reaches down to it.
  function placeCorner(size) {
    if (!cornerBR) return;
    const box = canvas.getBoundingClientRect();
    let left = 0;
    for (const el of [legend, canvas.querySelector('.leaflet-control-scale')]) {
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.bottom <= box.top || r.top >= box.bottom || r.left >= box.right) continue;
      left = Math.max(left, r.right - box.left + 8);
    }
    let right = 0;
    const cornerTop = size.y - cornerBR.offsetHeight - 8;
    for (const el of coverElements()) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.bottom - box.top <= cornerTop || r.right - box.left < size.x - 80 || r.top >= box.bottom) continue;
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

  // The look of a rocket's track: gold and thicker for the focused rocket,
  // its own color and thinner for the others. Gap lines stay thin.
  function trackStyle(rocket, isFocused, dashed) {
    const weight = dashed || !isFocused ? config.TRACK_WEIGHT_PX : config.TRACK_WEIGHT_FOCUSED_PX;
    return {
      color: isFocused ? config.TRACK_COLOR : rocket.profile.color,
      weight,
      opacity: isFocused ? 0.95 : 0.8,
    };
  }

  function layersFor(rocket) {
    let layers = rocketLayers.get(rocket.id);
    if (!layers) {
      layers = { drawn: 0, solid: null, solidHalo: null, lines: [], halos: [], marker: null, parts: null, focused: null };
      rocketLayers.set(rocket.id, layers);
    }
    return layers;
  }

  // Adds a track line and its outline. lines[i] and halos[i] go together.
  let linesAdded = false;
  function addLine(layers, line, halo) {
    halo.addTo(map);
    line.addTo(map);
    layers.lines.push(line);
    layers.halos.push(halo);
    linesAdded = true;
  }

  // Removes every track line. Markers stay, so a seek doesn't restart the
  // sonar rings.
  function clearTracks() {
    for (const layers of rocketLayers.values()) {
      for (const line of layers.lines) line.remove();
      for (const halo of layers.halos) halo.remove();
      layers.lines = [];
      layers.halos = [];
      layers.solid = null;
      layers.solidHalo = null;
      layers.drawn = 0;
      layers.focused = null;
    }
  }

  // Removes everything drawn for the rockets (a new flight, or a new map).
  function clearRocketLayers() {
    clearTracks();
    for (const layers of rocketLayers.values()) layers.marker?.remove();
    rocketLayers.clear();
    for (const pad of padMarkers.values()) pad.marker.remove();
    padMarkers.clear();
    gsLine?.remove();
    gsLineHalo?.remove();
    gsLine = null;
    gsLineHalo = null;
  }

  function redrawAll() {
    if (mode !== 'leaflet') return;
    clearRocketLayers();
    drawLeaflet();
  }

  // ------------------------------------------------------------------
  // Drawing: icons and HUD labels. Each icon is built once and then only
  // its classes and text change, so the sonar rings keep running. Screen
  // readers skip them: the readings panel says the same things in words.
  // ------------------------------------------------------------------
  function markerOptions(parts, size, anchor, zIndexOffset) {
    return {
      icon: L.divIcon({ className: 'fc-mk', html: parts.el, iconSize: size, iconAnchor: anchor }),
      interactive: false,
      keyboard: false,
      zIndexOffset,
    };
  }

  function buildRocketIcon(rocket) {
    const rings = h('span', { class: 'fc-rkt-rings' }, h('i'), h('i'), h('i'));
    const iconBox = h('span', { class: 'fc-rkt-icon' });
    const name = h('span', { class: 'fc-hud-name' }, rocket.profile.callsign);
    // The data line: a dim field code before each value, like "AGL 264 M
    // VS ▼6.0 M/S" on a military map display.
    const altKey = h('span', { class: 'fc-hud-key' });
    const alt = h('span', {});
    const speedKey = h('span', { class: 'fc-hud-key' });
    const speed = h('span', {});
    const speedGroup = h('span', { class: 'fc-hud-speed' }, speedKey, speed);
    const line2 = h('span', { class: 'fc-hud-line2' }, h('span', { class: 'fc-hud-alt' }, altKey, alt), speedGroup);
    const label = h('span', { class: 'fc-hud fc-rkt-label' }, name, line2);
    const el = h('div', { class: 'fc-rkt', 'aria-hidden': 'true' }, rings, iconBox, label);
    return { el, iconBox, name, altKey, alt, speedKey, speed, speedGroup, label, iconPx: null, iconW: 0, iconH: 0, side: 'right' };
  }

  // Sets the icon's size (the focused rocket is bigger).
  function sizeRocketIcon(parts, px) {
    if (parts.iconPx === px) return;
    parts.iconPx = px;
    const [w, hgt] = rocketBox(px);
    parts.iconW = w;
    parts.iconH = hgt;
    parts.iconBox.replaceChildren(iconNode(rocketSvg(px)));
    parts.el.style.setProperty('--w', `${w}px`);
    parts.el.style.setProperty('--h', `${hgt}px`);
  }

  // The second line of a rocket's label: height above ground and vertical
  // speed, each after its field code, or why its position is old and for
  // how long: since the last packet of any kind, the last GPS data, or the
  // last good fix, so it agrees with the readings panel.
  function rocketLine2(rocket) {
    const d = rocket.derived;
    if (!store.hasFixNow(rocket)) {
      let why = 'NO GPS FIX';
      let since = rocket.lastGoodFix?.t;
      if (store.isSilent(rocket)) {
        why = 'NO RECENT PACKETS';
        since = rocket.lastPacketT;
      } else if (store.gpsIsQuiet(rocket)) {
        why = 'NO GPS DATA';
        since = rocket.latestByGroup.gps?.t;
      }
      return { altKey: '', alt: `${why} · ${hudAge(store.ageOf(since))}`, speed: '', warn: true };
    }
    const agl = d?.agl;
    if (!Number.isFinite(agl)) return { altKey: 'AGL', alt: `${MISSING} M`, speed: '', warn: false };
    // An old altitude has no live vertical speed, so only the last height shows.
    if (store.altitudeIsOld(rocket)) return { altKey: 'LAST AGL', alt: `${formatNumber(agl, 0)} M`, speed: '', warn: false };
    const v = d.vSpeed;
    let speed = '';
    if (Number.isFinite(v)) {
      const arrow = v >= config.LEVEL_VSPEED_MPS ? '▲' : v <= -config.LEVEL_VSPEED_MPS ? '▼' : '';
      speed = `${arrow}${formatNumber(Math.abs(v), 1)} M/S`;
    }
    return { altKey: 'AGL', alt: `${formatNumber(agl, 0)} M`, speed, warn: false };
  }

  // How old a position is, in whole seconds, or minutes once it is long.
  function hudAge(seconds) {
    if (!Number.isFinite(seconds)) return MISSING;
    const s = Math.round(seconds);
    if (s < 60) return `${s} S`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} MIN` : `${Math.floor(m / 60)} H`;
  }

  function buildPadIcon() {
    const label = h('span', { class: 'fc-hud fc-pad-label' }, h('span', { class: 'fc-hud-name' }, 'LAUNCH POINT'));
    const el = h('div', { class: 'fc-pad', 'aria-hidden': 'true' }, iconNode(padSvg()), label);
    return { el, label, side: 'left', blocked: false };
  }

  function buildGsIcon() {
    const note = h('span', { class: 'fc-hud-line2' }, 'DEMO POSITION');
    const label = h('span', { class: 'fc-hud fc-gs-label' }, h('span', { class: 'fc-hud-name' }, 'GND STATION'), note);
    const el = h('div', { class: 'fc-gs', 'aria-hidden': 'true' }, iconNode(towerSvg()), label);
    return { el, label, note, side: 'right' };
  }

  // ------------------------------------------------------------------
  // Drawing: one pass over everything
  // ------------------------------------------------------------------
  function drawLeaflet() {
    const rockets = store.getRockets();
    const focused = store.getFocused();
    const gs = store.getGroundStation();
    const demoGs = gs.source === 'config';

    // Ground station
    setText(legendGsText, demoGs ? 'Ground station (demo position)' : 'Ground station');
    if (!gsMarker) {
      gsParts = buildGsIcon();
      gsMarker = L.marker([gs.lat, gs.lon], markerOptions(gsParts, TOWER_SIZE, TOWER_ANCHOR, Z_OFFSET.gs)).addTo(map);
    } else {
      gsMarker.setLatLng([gs.lat, gs.lon]);
    }
    // An honesty note: the tower sits at a made-up spot until the real
    // ground station sends its own position.
    gsParts.note.hidden = !demoGs;

    for (const rocket of rockets) {
      const isFocused = focused?.id === rocket.id;
      const layers = layersFor(rocket);

      // Launch pad: the last good position before liftoff.
      const pad = padMarkers.get(rocket.id);
      if (rocket.padPosition) {
        const ll = [rocket.padPosition.lat, rocket.padPosition.lon];
        if (!pad) {
          const parts = buildPadIcon();
          padMarkers.set(rocket.id, { parts, marker: L.marker(ll, markerOptions(parts, PAD_SIZE, PAD_ANCHOR, Z_OFFSET.pad)).addTo(map) });
        } else {
          pad.marker.setLatLng(ll);
        }
      } else if (pad) {
        pad.marker.remove();
        padMarkers.delete(rocket.id);
      }

      // Track: new points since the last draw. A gap starts a dashed line
      // from the last point before it to the first point after it. Two
      // kinds of gap: the GPS had no fix (gapBefore), or no position arrived
      // for longer than LINK_STALE_S (a radio silence). Either way nobody
      // measured the path in between.
      const track = rocket.track;
      for (let i = layers.drawn; i < track.length; i++) {
        const p = track[i];
        const ll = [p.lat, p.lon];
        const gap = i > 0 && (p.gapBefore || p.t - track[i - 1].t > config.LINK_STALE_S);
        if (gap) {
          const prev = track[i - 1];
          const pts = [[prev.lat, prev.lon], ll];
          addLine(layers,
            L.polyline(pts, { ...trackStyle(rocket, isFocused, true), dashArray: GAP_DASH, interactive: false }),
            L.polyline(pts, haloStyle(config.TRACK_WEIGHT_PX, { dashArray: GAP_DASH })));
          layers.solid = null;
          layers.solidHalo = null;
        }
        if (!layers.solid) {
          const look = trackStyle(rocket, isFocused, false);
          layers.solid = L.polyline([ll], { ...look, interactive: false });
          layers.solidHalo = L.polyline([ll], haloStyle(look.weight));
          addLine(layers, layers.solid, layers.solidHalo);
        } else {
          layers.solid.addLatLng(ll);
          layers.solidHalo.addLatLng(ll);
        }
      }
      layers.drawn = track.length;

      // Focus changed: recolor this rocket's lines.
      if (layers.focused !== isFocused) {
        layers.lines.forEach((line, i) => {
          const look = trackStyle(rocket, isFocused, Boolean(line.options.dashArray));
          line.setStyle(look);
          layers.halos[i].setStyle({ weight: look.weight + 2 * config.HALO_WIDTH_PX });
        });
        if (isFocused) {
          for (const halo of layers.halos) halo.bringToFront();
          for (const line of layers.lines) line.bringToFront();
        }
      }

      // The rocket icon at its last good position: off-white with sonar
      // rings while the fix is good, grey and hollow without one.
      const fix = rocket.lastGoodFix;
      if (fix) {
        const ll = [fix.lat, fix.lon];
        // The icon's middle is the position, so the marker box has no size.
        const zIndex = isFocused ? Z_OFFSET.focused : Z_OFFSET.rocket;
        if (!layers.marker) {
          layers.parts = buildRocketIcon(rocket);
          layers.marker = L.marker(ll, markerOptions(layers.parts, [0, 0], [0, 0], zIndex)).addTo(map);
        } else {
          layers.marker.setLatLng(ll);
          if (layers.marker.options.zIndexOffset !== zIndex) layers.marker.setZIndexOffset(zIndex);
        }
        const parts = layers.parts;
        const line2 = rocketLine2(rocket);
        sizeRocketIcon(parts, isFocused ? config.ROCKET_ICON_FOCUSED_PX : config.ROCKET_ICON_PX);
        parts.el.classList.toggle('fc-rkt--focus', isFocused);
        parts.el.classList.toggle('fc-rkt--nofix', line2.warn);
        setText(parts.name, rocket.profile.callsign);
        setText(parts.altKey, line2.altKey);
        setText(parts.alt, line2.alt);
        setText(parts.speedKey, line2.speed ? 'VS' : '');
        setText(parts.speed, line2.speed);
        if (parts.speedGroup.hidden !== !line2.speed) parts.speedGroup.hidden = !line2.speed;
      } else if (layers.marker) {
        layers.marker.remove();
        layers.marker = null;
        layers.parts = null;
      }
      layers.focused = isFocused;
    }

    // A new line lands on top, so the focused rocket's track goes back above
    // the others.
    const focusedLayers = rocketLayers.get(focused?.id);
    if (linesAdded && focusedLayers) {
      for (const line of focusedLayers.lines) line.bringToFront();
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
    // each with room for its label, in the part of the map nothing covers
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
    // covered area, or its label does, pan so the rocket and its label sit
    // well inside the free part. Like the first view, it moves sideways
    // away from the other views' panels, so a panel that is taller a moment
    // later still doesn't cover the rocket. Where it moves them depends on
    // what else stays in sight (see followShift).
    if (follow && target && usable && !justFitted && performance.now() > followPanUntil) {
      const p = map.latLngToContainerPoint([target.lat, target.lon]);
      const m = config.FOLLOW_EDGE_PX;
      const point = { left: p.x, top: p.y, right: p.x, bottom: p.y };
      const labelBox = focusedParts ? rocketLabelBoxes(focusedParts, p)[focusedParts.side] : null;
      if (tooClose(point, m, size, covers) || (labelBox && tooClose(labelBox, FOLLOW_LABEL_GAP_PX, size, covers))) {
        const area = freeArea(size);
        const ins = clearInsets(covers, size, m, area, { sideways: true }) ??
          clearInsets(covers, size, FOLLOW_LABEL_GAP_PX, area, { sideways: true, roomiest: true });
        const shift = followShift(labelBox ? union(point, labelBox) : point, ins, size, covers);
        // Already as centered as it gets (a free part too small for the
        // rocket and its label): no pan, so it doesn't pan on the spot.
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

    // Labels next to the icons (after any pan above), then the distance
    // label, which keeps clear of them.
    const placed = placeLabels(rockets, focused, size, covers);

    // Line from the ground station to the focused rocket.
    if (target) {
      // Short, as in "1.24 km, bearing 58° (NE)". The legend and the ground
      // station's own label say when its position is only a demo. With no
      // fix right now the line ends at the last good position, so the line
      // dims and the label says "Last known" in a muted style.
      const stale = !store.hasFixNow(focused);
      const label = `${stale ? 'Last known ' : ''}${formatRangeBearing(rangeAndBearing(gs, target))}`;
      const pts = [[gs.lat, gs.lon], [target.lat, target.lon]];
      const ends = pts.join('|');
      if (!gsLine) {
        gsLineHalo = L.polyline(pts, haloStyle(2, { dashArray: GS_DASH })).addTo(map);
        gsLine = L.polyline(pts, { color: config.GROUND_STATION_COLOR, weight: 2, opacity: GS_LINE_OPACITY, dashArray: GS_DASH, interactive: false }).addTo(map);
        gsLine.bindTooltip(label, { permanent: true, direction: 'center', className: 'fc-tip fc-tip--gs' });
        gsTip = { text: label, spot: null, stale: null, ends };
      } else if (label !== gsTip.text) {
        gsLine.setTooltipContent(label);
        gsTip.text = label;
      }
      const tip = gsLine.getTooltip();
      const tipEl = tip?.getElement();
      const restyle = stale !== gsTip.stale && tipEl;
      if (restyle) tipEl.classList.toggle('fc-tip--stale', stale);
      // The label's size, read before the lines change below, so the page
      // only has to work out its layout again when the label's text or
      // look just changed.
      const tipSize = tipEl ? { w: tipEl.offsetWidth, h: tipEl.offsetHeight } : null;
      if (ends !== gsTip.ends) {
        gsLine.setLatLngs(pts);
        gsLineHalo.setLatLngs(pts);
        gsTip.ends = ends;
      }
      if (restyle) {
        gsTip.stale = stale;
        gsLine.setStyle({ opacity: stale ? GS_LINE_STALE_OPACITY : GS_LINE_OPACITY });
        gsLineHalo.setStyle({ opacity: stale ? config.HALO_OPACITY * GS_LINE_STALE_OPACITY : config.HALO_OPACITY });
      }
      const spot = labelPoint(gs, target, covers, placed.all, placed.keepClear, tipSize);
      if (spot && !(gsTip.spot && gsTip.spot.equals(spot))) {
        tip?.setLatLng(spot);
        gsTip.spot = spot;
      }
      tipEl?.classList.toggle('fc-tip--away', !spot);
      // A launch point's label under the distance label steps aside.
      if (spot && tipSize) {
        const c = map.latLngToContainerPoint(spot);
        const chip = { left: c.x - tipSize.w / 2, right: c.x + tipSize.w / 2, top: c.y - tipSize.h / 2, bottom: c.y + tipSize.h / 2 };
        for (const { label, box } of placed.padLabels) {
          if (box.right > chip.left && box.left < chip.right && box.bottom > chip.top && box.top < chip.bottom) label.classList.add('fc-hud--blocked');
        }
      }
    } else if (gsLine) {
      gsLine.remove();
      gsLineHalo?.remove();
      gsLine = null;
      gsLineHalo = null;
    }

    placeCorner(size);
    setText(status, statusText(focused));
  }

  // ------------------------------------------------------------------
  // The first view. Each thing to show (the launch pads, the focused
  // rocket, the ground station) is a point with the room it needs around
  // it in px: its icon, its label on its usual side (the launch point's on
  // the left, the others on the right) and a little air. The view is the
  // closest zoom at which all of that fits inside the part of the map
  // nothing covers. FIT_PADDING_PX of air is kept when that costs at most
  // half a zoom step, otherwise less. If even that can't fit (a narrow
  // map), the pads and the ground station give up their label room (their
  // labels can move to another side), then the rocket does too. Covered
  // areas always count.
  // ------------------------------------------------------------------
  function firstView(target, rocketParts, gs, size, covers) {
    const pads = [...padMarkers.values()];
    if (!pads.length && !target) return null;
    // The focused rocket stays further than Follow's edge margin from every
    // edge, so Follow doesn't pan right after the first view.
    const keep = config.FOLLOW_EDGE_PX + 8;
    const items = (air, labels) => {
      const out = [];
      const add = (ll, left, right, up, down) => out.push({ ll, l: left + air, r: right + air, u: up + air, d: down + air });
      // Each label's middle sits a little above its spot (10 px for the
      // launch point, 14 px for the ground station, as in placeLabels).
      for (const pad of pads) {
        const show = labels && !pad.parts.label.hidden;
        const lw = show ? 5 + pad.parts.label.offsetWidth : 0;
        const half = show ? pad.parts.label.offsetHeight / 2 : 0;
        add(pad.marker.getLatLng(), PAD_ANCHOR[0] + lw, PAD_SIZE[0] - PAD_ANCHOR[0],
          Math.max(PAD_ANCHOR[1], 10 + half), Math.max(PAD_SIZE[1] - PAD_ANCHOR[1], half - 10));
      }
      if (gsParts) {
        const lw = labels ? 4 + gsParts.label.offsetWidth : 0;
        const half = labels ? gsParts.label.offsetHeight / 2 : 0;
        add(L.latLng(gs.lat, gs.lon), TOWER_ANCHOR[0], TOWER_SIZE[0] - TOWER_ANCHOR[0] + lw,
          Math.max(TOWER_ANCHOR[1], 14 + half), Math.max(TOWER_SIZE[1] - TOWER_ANCHOR[1], half - 14));
      }
      return out;
    };
    const rocketItem = (air, label) => {
      if (!target) return [];
      const w = rocketParts?.iconW ?? 0;
      const lw = label && rocketParts ? LABEL_GAP_PX + rocketParts.label.offsetWidth : 0;
      const half = Math.max(rocketParts?.iconH ?? 0, rocketParts?.label.offsetHeight ?? 0) / 2 + air;
      return [{ ll: L.latLng(target.lat, target.lon), l: Math.max(keep, w / 2 + air), r: Math.max(keep, w / 2 + lw + air), u: Math.max(keep, half), d: Math.max(keep, half) }];
    };
    const tiers = [
      [...items(config.FIT_PADDING_PX, true), ...rocketItem(config.FIT_PADDING_PX, true)],
      [...items(FIT_ROOM_PX, true), ...rocketItem(FIT_ROOM_PX, true)],
      [...items(FIT_ROOM_PX, false), ...rocketItem(FIT_ROOM_PX, true)],
      [...items(FIT_ROOM_PX, false), ...rocketItem(FIT_ROOM_PX, false)],
    ];
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
    const bounds = L.latLngBounds(tiers[3].map((it) => it.ll));
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

  // How far (map px) Follow moves the view for the rocket and its label
  // (box), with ins the free part. The box always ends up inside the free
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
    if (gsMarker) others.push(iconRect(map.latLngToContainerPoint(gsMarker.getLatLng()), TOWER_ANCHOR, TOWER_SIZE));
    for (const pad of padMarkers.values()) others.push(iconRect(map.latLngToContainerPoint(pad.marker.getLatLng()), PAD_ANCHOR, PAD_SIZE));
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

  const union = (a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });

  // ------------------------------------------------------------------
  // Label sides. A label goes on its usual side unless that would run off
  // the map, under a covered area or into another label, and another side
  // wouldn't. If every side hits something, the one that hides least wins:
  // running off the map or under a covered area counts HIDDEN_LABEL_COST
  // times more than touching another label or icon. Rocket labels go first
  // (focused rocket first), then the launch points and the ground station.
  // A launch point's label that has no clear place at all stays out of
  // sight until it has one (the legend still names the icon). Returns, for
  // the distance label: every label and icon box (all), every icon plus
  // the rocket and ground station labels (keepClear), and the launch point
  // labels on show (padLabels).
  // ------------------------------------------------------------------
  function placeLabels(rockets, focused, size, covers) {
    // The icons themselves count as taken, so no label sits on another icon.
    const taken = [];
    const iconBox = (p, left, top, w, hgt) => ({ left: p.x - left, top: p.y - top, right: p.x - left + w, bottom: p.y - top + hgt });
    for (const layers of rocketLayers.values()) {
      if (!layers.marker) continue;
      const p = map.latLngToContainerPoint(layers.marker.getLatLng());
      taken.push(iconBox(p, layers.parts.iconW / 2, layers.parts.iconH / 2, layers.parts.iconW, layers.parts.iconH));
    }
    for (const pad of padMarkers.values()) {
      taken.push(iconRect(map.latLngToContainerPoint(pad.marker.getLatLng()), PAD_ANCHOR, PAD_SIZE));
    }
    if (gsMarker) taken.push(iconRect(map.latLngToContainerPoint(gsMarker.getLatLng()), TOWER_ANCHOR, TOWER_SIZE));
    const keepClear = [...taken];

    const ordered = [...rockets].sort((a, b) => (b.id === focused?.id) - (a.id === focused?.id));
    for (const rocket of ordered) {
      const layers = rocketLayers.get(rocket.id);
      if (!layers?.marker) continue;
      const parts = layers.parts;
      const p = map.latLngToContainerPoint(layers.marker.getLatLng());
      hideIfOff(parts.el, p, size);
      const boxes = rocketLabelBoxes(parts, p);
      parts.side = pickSide(parts.side, ['right', 'left', 'below', 'above'], boxes, covers, taken, size);
      parts.el.classList.toggle('fc-rkt--left', parts.side === 'left');
      parts.el.classList.toggle('fc-rkt--below', parts.side === 'below');
      parts.el.classList.toggle('fc-rkt--above', parts.side === 'above');
      taken.push(boxes[parts.side]);
      keepClear.push(boxes[parts.side]);
    }

    // Launch points: one label per spot, even with several rockets on it.
    // Usually on the left, so it stays clear of a rocket sitting on the pad.
    const shown = [];
    const padLabels = [];
    for (const rocket of rockets) {
      const pad = padMarkers.get(rocket.id);
      if (!pad) continue;
      const p = map.latLngToContainerPoint(pad.marker.getLatLng());
      hideIfOff(pad.parts.el, p, size);
      const duplicate = shown.some((q) => q.distanceTo(p) < PAD_LABEL_MERGE_PX);
      pad.parts.label.hidden = duplicate;
      if (duplicate) continue;
      shown.push(p);
      // Beside the rail, the label's middle is 10 px above the spot.
      const boxes = labelBoxes(p, pad.parts.label, PAD_SIZE[0] / 2 + 5, PAD_ANCHOR[1] - 11, PAD_LABEL_BELOW_PX);
      pad.parts.side = pickSide(pad.parts.side, ['left', 'right', 'below'], boxes, covers, taken, size);
      pad.parts.el.classList.toggle('fc-pad--right', pad.parts.side === 'right');
      pad.parts.el.classList.toggle('fc-pad--below', pad.parts.side === 'below');
      // Out of sight once a tenth of it would be hidden or on top of
      // something, back once less than a fiftieth would be (so it doesn't
      // blink at the limit).
      const box = boxes[pad.parts.side];
      const share = labelCost(box, covers, taken, size, 1) / Math.max(1, (box.right - box.left) * (box.bottom - box.top));
      pad.parts.blocked = share > (pad.parts.blocked ? 0.02 : 0.1);
      pad.parts.label.classList.toggle('fc-hud--blocked', pad.parts.blocked);
      if (pad.parts.blocked) continue;
      taken.push(box);
      padLabels.push({ label: pad.parts.label, box });
    }

    if (gsMarker) {
      const p = map.latLngToContainerPoint(gsMarker.getLatLng());
      hideIfOff(gsParts.el, p, size);
      const boxes = labelBoxes(p, gsParts.label, TOWER_SIZE[0] / 2 + 4, TOWER_ANCHOR[1] - 16, GS_LABEL_BELOW_PX);
      gsParts.side = pickSide(gsParts.side, ['right', 'left', 'below'], boxes, covers, taken, size);
      gsParts.el.classList.toggle('fc-gs--left', gsParts.side === 'left');
      gsParts.el.classList.toggle('fc-gs--below', gsParts.side === 'below');
      taken.push(boxes[gsParts.side]);
      keepClear.push(boxes[gsParts.side]);
    }
    return { all: taken, keepClear, padLabels };
  }

  // An icon outside the map keeps its label out of sight too, so no stray
  // piece of text pokes in at the edge.
  function hideIfOff(el, p, size) {
    el.classList.toggle('fc-mk-off', p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y);
  }

  // Where a label would sit around an icon at point p. gap is the distance
  // from p to the label's near edge, lift how far above p the label's
  // middle sits, below (if given) how far under p a centered label's top
  // would sit, and above (if given) how far over p its bottom would sit.
  function labelBoxes(p, label, gap, lift, below = null, above = null) {
    const w = label.offsetWidth;
    const hgt = label.offsetHeight;
    const top = p.y - lift - hgt / 2;
    const bottom = top + hgt;
    const boxes = {
      right: { left: p.x + gap, right: p.x + gap + w, top, bottom },
      left: { left: p.x - gap - w, right: p.x - gap, top, bottom },
    };
    if (below !== null) boxes.below = { left: p.x - w / 2, right: p.x + w / 2, top: p.y + below, bottom: p.y + below + hgt };
    if (above !== null) boxes.above = { left: p.x - w / 2, right: p.x + w / 2, top: p.y - above - hgt, bottom: p.y - above };
    return boxes;
  }

  // A rocket's label: right or left of the icon, level with its middle, or
  // centered under or over it.
  function rocketLabelBoxes(parts, p) {
    const off = parts.iconH / 2 + ROCKET_LABEL_BELOW_PX;
    return labelBoxes(p, parts.label, parts.iconW / 2 + LABEL_GAP_PX, 0, off, off);
  }

  // How much of label box b (px²) is off the map (closer than 4 px to its
  // edge counts as off) or under a covered area, times hiddenCost, plus how
  // much of it sits on another label or icon.
  function labelCost(b, covers, taken, size, hiddenCost = HIDDEN_LABEL_COST) {
    const overlap = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) *
      Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
    const frame = { left: 4, top: 4, right: size.x - 4, bottom: size.y - 4 };
    return hiddenCost * ((b.right - b.left) * (b.bottom - b.top) - overlap(b, frame) +
      covers.reduce((sum, c) => sum + overlap(b, c), 0)) +
      taken.reduce((sum, t) => sum + overlap(b, t), 0);
  }

  // sides lists the label's places, usual one first.
  function pickSide(current, sides, boxes, covers, taken, size) {
    const scores = Object.fromEntries(sides.map((side) => [side, labelCost(boxes[side], covers, taken, size)]));
    if (scores[sides[0]] === 0) return sides[0];
    if (scores[current] === 0) return current;
    const best = sides.reduce((a, b) => (scores[b] < scores[a] ? b : a));
    // A clearly better place only, so a label doesn't flicker between two
    // bad ones.
    return !(current in scores) || scores[best] < scores[current] * 0.8 ? best : current;
  }

  // Where the distance label sits on the ground station line: the middle,
  // unless that is off screen, covered or on top of an icon or its label, in
  // which case the visible point closest to the middle (searching toward
  // both ends). If only covered spots are left, it may sit on a launch
  // point's label (which then steps aside), but never on an icon, a
  // rocket's label (the focused rocket's included) or the ground station's
  // label. If no part of the line has room at all, it returns null and the
  // label hides, rather than float away from its line.
  // tipSize is the label's size in px ({ w, h }).
  function labelPoint(gs, target, covers, labels, keepClear, tipSize) {
    const at = (f) => L.latLng(target.lat + (gs.lat - target.lat) * f, target.lon + (gs.lon - target.lon) * f);
    const size = map.getSize();
    // Room for the whole label, which is centered on its point.
    const halfW = (tipSize?.w ?? 140) / 2 + 6;
    const halfH = (tipSize?.h ?? 24) / 2 + 6;
    const fits = (p, boxes) => {
      if (p.x <= halfW || p.x >= size.x - halfW || p.y <= halfH || p.y >= size.y - halfH) return false;
      return !boxes.some((c) => p.x + halfW > c.left && p.x - halfW < c.right && p.y + halfH > c.top && p.y - halfH < c.bottom);
    };
    for (const boxes of [[...covers, ...labels], [...covers, ...keepClear]]) {
      for (let step = 0; step <= 24; step++) {
        for (const f of step === 0 ? [0.5] : [0.5 - step * 0.02, 0.5 + step * 0.02]) {
          const ll = at(f);
          if (fits(map.latLngToContainerPoint(ll), boxes)) return ll;
        }
      }
    }
    return null;
  }

  function statusText(focused) {
    const noFixAnywhere = store.getRockets().every((r) => !r.lastGoodFix);
    let focusNote = '';
    if (focused && !focused.lastGoodFix && !noFixAnywhere) {
      if (focused.lastPacketT === null) focusNote = `${focused.profile.name} hasn't sent any data yet, so it isn't on the map.`;
      else if (focused.sensorGroups.has('gps')) focusNote = `${focused.profile.name} has no GPS fix yet, so it isn't on the map.`;
      else focusNote = `${focused.profile.name} has sent no GPS data, so it isn't on the map.`;
    }
    return [noFixAnywhere ? 'No GPS fix yet, so there is no rocket to draw.' : '', focusNote, satelliteNote, labelsNote, noTilesNote]
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
    // Following and the legend mean nothing without a map, so they go away.
    legend.hidden = true;
    followLabel.hidden = true;
    controls.hidden = !switcher;
    nomapList = h('ul', { class: 'fc-nomap-list' });
    gsRow = h('li', { class: 'fc-nomap-gs' });
    fallbackRows.clear();
    // After a tile failure, either background can be tried again. The
    // buttons move here from the map's corner, and back when the map returns.
    const retry = reason === 'tiles'
      ? h('div', { class: 'fc-nomap-retry' }, h('p', { class: 'fc-nomap-note' }, 'Try loading a map background again.'), layerPick)
      : null;
    layerPick.hidden = reason !== 'tiles';
    const panel = h('div', { class: 'fc-nomap' },
      h('div', { class: 'fc-nomap-head' },
        h('h3', { class: 'fc-nomap-title' }, 'No map'),
        h('p', { class: 'fc-nomap-note' }, `${message} Map tiles need internet. Tracking still works.`),
        retry),
      nomapList);
    showBody(panel);
    setText(status, '');
    updateLayerControls();
    drawFallback();
  }

  // From the no-map panel: bring the map back with the chosen background.
  function retryMap() {
    if (!L || destroyed) return;
    mode = 'loading';
    fallbackReason = null;
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
      const rb = fix ? rangeAndBearing(gs, fix) : null;
      let position = 'No GPS data from this rocket';
      if (fix) position = `${formatNumber(fix.lat, 5)}, ${formatNumber(fix.lon, 5)}`;
      else if (rocket.lastPacketT === null) position = 'No data from this rocket yet';
      else if (rocket.sensorGroups.has('gps')) position = 'No GPS fix yet';
      setText(row.position, position);
      setText(row.range, rb ? `${formatRangeBearing(rb)} from the ground station` : MISSING);
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
    setText(gsRow, `Ground station at ${formatNumber(gs.lat, 5)}, ${formatNumber(gs.lon, 5)}${gs.source === 'config' ? ' (demo position)' : ''}`);
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------
  const scheduler = createScheduler(() => {
    if (mode === 'leaflet') drawLeaflet();
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

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      scheduler.cancel();
      controlsObserver?.disconnect();
      root.closest('.fc-stage')?.style.removeProperty('--fc-map-controls-bottom');
      removeMap();
    },
  };
}
