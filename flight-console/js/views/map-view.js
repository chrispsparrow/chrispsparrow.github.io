// map-view.js
// The map: a colored circle and track for every rocket (the focused one
// larger and on top), the launch pad, the ground station in teal, and a
// line from the ground station to the focused rocket labeled with distance
// and bearing. Only good GPS positions are ever drawn. With no fix (or no
// recent packets at all), the marker turns hollow at the last good position
// and says how old it is. Across a fix gap, the track is dashed. Lines and
// rings get a thin dark outline so they stand out on bright photos.
//
// Two map backgrounds: Esri satellite imagery (the default, with Esri's
// labels on top unless "Labels" is unchecked) and CARTO's dark map. The
// browser remembers the viewer's choice. If Esri turns the key down or the
// imagery keeps failing, the map shows the dark map and says so.
//
// If Leaflet didn't load, or the map tiles keep failing, the map is
// replaced by a "No map" panel with each rocket's position, distance and
// bearing, and an arrow. Tracking keeps working either way. After a tile
// failure the panel offers both backgrounds to try again. If Leaflet shows
// up late (slow connection), the real map takes over.
//
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { rangeAndBearing, formatRangeBearing, formatAge, formatNumber, MISSING } from '../geo.js';

// The views the switcher offers. A 3D view (CesiumJS) will be added to this
// list in a later phase. Only views that really work are listed.
const VIEW_MODES = [{ id: 'map', label: 'Map' }];

// The fix-gap line pattern: dash and space lengths in pixels.
const GAP_DASH = '4 8';

// Leaflet's own separator between credits.
const CREDIT_SEP = ' <span aria-hidden="true">|</span> ';

const isLayer = (value) => value === 'satellite' || value === 'dark';

export function createMapView(root, ctx) {
  const { store, config, libs } = ctx;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ------------------------------------------------------------------
  // Page elements
  // ------------------------------------------------------------------
  const followBox = h('input', { type: 'checkbox', checked: true, onchange: () => { follow = followBox.checked; scheduler.schedule(); } });
  const followLabel = h('label', { class: 'fc-follow' }, followBox, 'Follow rocket');
  // A group of toggle buttons, one per view. Only "Map" exists for now.
  const switcher = h('div', { class: 'fc-seg', role: 'group', 'aria-label': 'View' },
    VIEW_MODES.map((m, i) => h('button', { type: 'button', class: 'fc-btn', 'aria-pressed': String(i === 0) }, m.label)));
  const canvas = h('div', { class: 'fc-map-canvas', role: 'region', 'aria-label': 'Map of rocket positions' });
  const waitBox = h('div', { class: 'fc-map-wait' }, 'Loading the map...');

  // Map background: two buttons, and a labels switch while Satellite is on.
  const satelliteBtn = h('button', { type: 'button', class: 'fc-btn', 'aria-pressed': 'false', onclick: () => selectLayer('satellite') }, 'Satellite');
  const darkBtn = h('button', { type: 'button', class: 'fc-btn', 'aria-pressed': 'false', onclick: () => selectLayer('dark') }, 'Dark map');
  const labelsBox = h('input', { type: 'checkbox', checked: true, onchange: () => setLabels(labelsBox.checked) });
  const labelsLabel = h('label', { class: 'fc-labels-toggle' }, labelsBox, 'Labels');
  const layerPick = h('div', { class: 'fc-layer-pick', role: 'group', 'aria-label': 'Map background' },
    h('div', { class: 'fc-seg' }, satelliteBtn, darkBtn), labelsLabel);

  // Says "(demo position)" while the ground station is the config placeholder.
  const legendGsText = h('span', {}, 'Ground station');
  const legend = h('div', { class: 'fc-map-legend', 'aria-hidden': 'true' },
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-line' }), 'Rocket track'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-line fc-legend-line--dash' }), 'Dashed line means no GPS fix'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-ring fc-legend-ring--pad', style: { '--pad': config.PAD_COLOR } }), 'Launch pad'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-ring' }), legendGsText));
  // The background buttons and the legend share the top right corner.
  const mapPanel = h('div', { class: 'fc-map-panel' }, layerPick, legend);
  mapPanel.hidden = true;
  const frame = h('div', { class: 'fc-map-frame' }, canvas, waitBox, mapPanel);
  const status = h('p', { class: 'fc-map-status', role: 'status' });

  setChildren(root, h('section', { class: 'fc-mapbox', 'aria-labelledby': 'fc-map-title' },
    h('h2', { class: 'sr-only', id: 'fc-map-title' }, 'Map'),
    h('div', { class: 'fc-map-toolbar' }, switcher, followLabel),
    frame,
    status));

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let mode = 'loading';     // 'loading', 'leaflet' or 'fallback'
  let fallbackReason = null; // 'library' or 'tiles' while in the fallback
  let follow = true;
  let destroyed = false;
  let L = null;
  let map = null;
  let fitted = false;
  let resizeObserver = null;
  const rocketLayers = new Map(); // rocketId -> layers for that rocket
  let gsMarker = null;
  let gsMarkerHalo = null;
  let gsLine = null;
  let gsLineHalo = null;
  let padMarkers = new Map();
  let padHalos = new Map();

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
  let esriKeyOk = false;   // Esri accepted the key earlier in this visit
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
        setChildren(frame, canvas, mapPanel);
        followLabel.hidden = false;
        startLeaflet(late);
      }
    });
  });

  // ------------------------------------------------------------------
  // Leaflet
  // ------------------------------------------------------------------
  function startLeaflet(leaflet) {
    L = leaflet;
    try {
      const gs = store.getGroundStation();
      map = L.map(canvas, { zoomControl: true, attributionControl: true, zoomSnap: 0.5, maxZoom: config.TILE_MAX_ZOOM });
      map.setView([gs.lat, gs.lon], config.MAP_DEFAULT_ZOOM);
      // A distance scale, useful for recovery with or without tiles.
      L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      // Esri's labels sit above the photos and below everything drawn here.
      // The dark outlines get their own layer just under the lines and rings.
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
        if (!follow) return;
        follow = false;
        followBox.checked = false;
      });
      if ('ResizeObserver' in window) {
        resizeObserver = new ResizeObserver(() => map && map.invalidateSize());
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
    mapPanel.hidden = false;
    fitted = false;
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
    if (map) {
      map.off();
      map.remove();
    }
    map = null;
    baseTiles = null;
    labelTiles = null;
    shownLayer = null;
    credit = null;
    rocketLayers.clear();
    padMarkers = new Map();
    padHalos = new Map();
    gsMarker = null;
    gsMarkerHalo = null;
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
    checkEsriKey().then((ok) => {
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

  // Asks Esri whether it accepts the key from this site. A yes is kept for
  // the rest of the visit. A no, or no answer in time, means no satellite
  // this time, and the next try asks again.
  function checkEsriKey() {
    if (esriKeyOk) return Promise.resolve(true);
    const url = config.ESRI_KEY_CHECK_URL.replace('{key}', encodeURIComponent(config.ESRI_API_KEY));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.TILE_FAIL_TIMEOUT_MS);
    return fetch(url, { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : null))
      // Esri can also report a rejected key inside a normal reply.
      .then((body) => {
        esriKeyOk = Boolean(body && !body.error);
        return esriKeyOk;
      })
      .catch(() => false)
      .finally(() => clearTimeout(timer));
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
  // Drawing
  // ------------------------------------------------------------------

  // A dark outline drawn just under a line or ring, so it stands out on
  // bright photos. weight is the width of the line it outlines.
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
      layers = { drawn: 0, solid: null, solidHalo: null, lines: [], halos: [], marker: null, markerHalo: null, tipMode: null, focused: null };
      rocketLayers.set(rocket.id, layers);
    }
    return layers;
  }

  // Adds a track line and its outline. lines[i] and halos[i] go together.
  function addLine(layers, line, halo) {
    halo.addTo(map);
    line.addTo(map);
    layers.lines.push(line);
    layers.halos.push(halo);
  }

  function clearRocketLayers() {
    for (const layers of rocketLayers.values()) {
      for (const line of layers.lines) line.remove();
      for (const halo of layers.halos) halo.remove();
      layers.marker?.remove();
      layers.markerHalo?.remove();
    }
    rocketLayers.clear();
    for (const m of padMarkers.values()) m.remove();
    for (const m of padHalos.values()) m.remove();
    padMarkers.clear();
    padHalos.clear();
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

  function drawLeaflet() {
    const rockets = store.getRockets();
    const focused = store.getFocused();
    const gs = store.getGroundStation();

    // Ground station
    const gsText = gs.source === 'config' ? 'Ground station (demo position)' : 'Ground station';
    setText(legendGsText, gsText);
    if (!gsMarker) {
      gsMarkerHalo = L.circleMarker([gs.lat, gs.lon], haloStyle(3, { radius: 8 })).addTo(map);
      gsMarker = L.circleMarker([gs.lat, gs.lon], {
        radius: 8, color: config.GROUND_STATION_COLOR, weight: 3, fillColor: config.GROUND_STATION_COLOR, fillOpacity: 0.25,
      }).addTo(map);
      gsMarker.bindTooltip(gsText, { className: 'fc-tip fc-tip--gs', direction: 'bottom', offset: [0, 8] });
    } else {
      gsMarker.setLatLng([gs.lat, gs.lon]);
      gsMarkerHalo.setLatLng([gs.lat, gs.lon]);
      gsMarker.setTooltipContent(gsText);
    }

    for (const rocket of rockets) {
      const color = rocket.profile.color;
      const isFocused = focused?.id === rocket.id;
      const layers = layersFor(rocket);
      const weight = isFocused ? config.TRACK_WEIGHT_FOCUSED_PX : config.TRACK_WEIGHT_PX;

      // Launch pad: the last good position before liftoff.
      if (rocket.padPosition) {
        const pad = padMarkers.get(rocket.id);
        const ll = [rocket.padPosition.lat, rocket.padPosition.lon];
        if (!pad) {
          padHalos.set(rocket.id, L.circleMarker(ll, haloStyle(2, { radius: 6 })).addTo(map));
          const m = L.circleMarker(ll, { radius: 6, color: config.PAD_COLOR, weight: 2, fillOpacity: 0 }).addTo(map);
          m.bindTooltip(rockets.length > 1 ? `Launch pad of ${rocket.profile.name}` : 'Launch pad', { className: 'fc-tip', direction: 'left', offset: [-8, 0] });
          padMarkers.set(rocket.id, m);
        } else {
          pad.setLatLng(ll);
          padHalos.get(rocket.id)?.setLatLng(ll);
        }
      }

      // Track: new points since the last draw. A gap starts a dashed line
      // from the last point before it to the first point after it.
      const track = rocket.track;
      for (let i = layers.drawn; i < track.length; i++) {
        const p = track[i];
        const ll = [p.lat, p.lon];
        if (p.gapBefore && i > 0) {
          const prev = track[i - 1];
          const pts = [[prev.lat, prev.lon], ll];
          addLine(layers,
            L.polyline(pts, { color, weight: config.TRACK_WEIGHT_PX, opacity: 0.9, dashArray: GAP_DASH, interactive: false }),
            L.polyline(pts, haloStyle(config.TRACK_WEIGHT_PX, { dashArray: GAP_DASH })));
          layers.solid = null;
          layers.solidHalo = null;
        }
        if (!layers.solid) {
          layers.solid = L.polyline([ll], { color, weight, opacity: 0.95, interactive: false });
          layers.solidHalo = L.polyline([ll], haloStyle(weight));
          addLine(layers, layers.solid, layers.solidHalo);
        } else {
          layers.solid.addLatLng(ll);
          layers.solidHalo.addLatLng(ll);
        }
      }
      layers.drawn = track.length;

      // Marker at the last good position: filled with a fix right now,
      // hollow without one (or when the rocket has gone quiet).
      const fix = rocket.lastGoodFix;
      if (fix) {
        const ll = [fix.lat, fix.lon];
        const fixNow = store.hasFixNow(rocket);
        const radius = isFocused ? config.MARKER_RADIUS_FOCUSED_PX : config.MARKER_RADIUS_PX;
        const style = fixNow
          ? { radius, color: '#F4F2ED', weight: 2, fillColor: color, fillOpacity: 1 }
          : { radius, color, weight: 3, fillColor: color, fillOpacity: 0 };
        const haloLook = { radius, weight: style.weight + 2 * config.HALO_WIDTH_PX };
        if (!layers.marker) {
          layers.markerHalo = L.circleMarker(ll, haloStyle(style.weight, { radius })).addTo(map);
          layers.marker = L.circleMarker(ll, style).addTo(map);
        } else {
          layers.markerHalo.setLatLng(ll).setStyle(haloLook);
          layers.marker.setLatLng(ll).setStyle(style);
        }

        // The label opens toward the middle of the map, so it isn't cut
        // off at the edge.
        const side = map.latLngToContainerPoint(ll).x > map.getSize().x / 2 ? 'left' : 'right';
        const tipMode = `${fixNow ? 'name' : 'nofix'}:${side}`;
        const tipText = fixNow ? rocket.profile.name : `Last good fix ${formatAge(store.ageOf(fix.t))}`;
        if (layers.tipMode !== tipMode) {
          layers.marker.unbindTooltip();
          layers.marker.bindTooltip(tipText, { className: 'fc-tip', direction: side, offset: [side === 'left' ? -12 : 12, 0], permanent: !fixNow });
          layers.tipMode = tipMode;
        } else {
          layers.marker.setTooltipContent(tipText);
        }
      }

      // Focused rocket: thicker and on top.
      if (layers.focused !== isFocused) {
        layers.lines.forEach((line, i) => {
          if (line.options.dashArray) return;
          line.setStyle({ weight });
          layers.halos[i].setStyle({ weight: weight + 2 * config.HALO_WIDTH_PX });
        });
        layers.focused = isFocused;
      }
      if (isFocused) {
        for (const halo of layers.halos) halo.bringToFront();
        for (const line of layers.lines) line.bringToFront();
        layers.markerHalo?.bringToFront();
        layers.marker?.bringToFront();
      }
    }

    const target = focused?.lastGoodFix;
    // The background buttons and the legend cover the top right corner, so
    // fitting and following treat that area like the map's edge.
    const panelBox = mapPanel.hidden ? { w: 0, h: 0 } : { w: mapPanel.offsetWidth + 12, h: mapPanel.offsetHeight + 12 };

    // First view: fit the pad(s) and the ground station. Follow waits for
    // the next draw, and its edge margin is smaller than the fit padding,
    // so the fitted view stays put until the rocket really heads off.
    let justFitted = false;
    if (!fitted) {
      const pts = [...padMarkers.values()].map((m) => m.getLatLng());
      if (!pts.length && focused?.lastGoodFix) pts.push(L.latLng(focused.lastGoodFix.lat, focused.lastGoodFix.lon));
      if (pts.length) {
        pts.push(L.latLng(gs.lat, gs.lon));
        const pad = config.FIT_PADDING_PX;
        const bounds = L.latLngBounds(pts);
        // The panel sits in the top right corner. Keeping either the top
        // band or the right band free clears it, so use whichever lets the
        // map zoom in closer (on a phone that is usually the top band).
        const topBand = { paddingTopLeft: [pad, Math.max(pad, panelBox.h)], paddingBottomRight: [pad, pad] };
        const rightBand = { paddingTopLeft: [pad, pad], paddingBottomRight: [Math.max(pad, panelBox.w), pad] };
        const zoomFor = (o) => map.getBoundsZoom(bounds, false, L.point(o.paddingTopLeft).add(o.paddingBottomRight));
        const best = zoomFor(topBand) >= zoomFor(rightBand) ? topBand : rightBand;
        map.fitBounds(bounds, { ...best, maxZoom: config.FIT_MAX_ZOOM, animate: false });
        fitted = true;
        justFitted = true;
      }
    }

    // Follow: pan when the focused rocket gets near the edge of the view,
    // or slips under the panel.
    if (follow && target && !justFitted) {
      const ll = L.latLng(target.lat, target.lon);
      const p = map.latLngToContainerPoint(ll);
      const size = map.getSize();
      const m = config.FOLLOW_EDGE_PX;
      const nearEdge = p.x < m || p.y < m || p.x > size.x - m || p.y > size.y - m;
      const underPanel = panelBox.w > 0 && p.x > size.x - panelBox.w && p.y < panelBox.h;
      if (nearEdge || underPanel) map.panTo(ll, { animate: !reducedMotion, duration: 0.5 });
    }

    // Line from the ground station to the focused rocket.
    if (target) {
      // Short, as in "1.24 km, bearing 58° (NE)". The legend and the ground
      // station's own label say when its position is only a demo.
      const label = formatRangeBearing(rangeAndBearing(gs, target));
      const pts = [[gs.lat, gs.lon], [target.lat, target.lon]];
      if (!gsLine) {
        gsLineHalo = L.polyline(pts, haloStyle(2)).addTo(map);
        gsLine = L.polyline(pts, { color: config.GROUND_STATION_COLOR, weight: 2, opacity: 0.9, interactive: false }).addTo(map);
        gsLine.bindTooltip(label, { permanent: true, direction: 'center', className: 'fc-tip fc-tip--gs' });
      } else {
        gsLine.setLatLngs(pts);
        gsLineHalo.setLatLngs(pts);
        gsLine.setTooltipContent(label);
      }
      gsLine.getTooltip()?.setLatLng(labelPoint(gs, target));
      rocketLayers.get(focused.id)?.marker?.bringToFront();
    } else if (gsLine) {
      gsLine.remove();
      gsLineHalo?.remove();
      gsLine = null;
      gsLineHalo = null;
    }

    setText(status, statusText(focused));
  }

  // Where the distance label sits on the ground station line: the middle,
  // unless that is off screen, in which case the visible point closest to
  // the middle (searching toward both ends). If no point fits, the label is
  // kept inside the map frame.
  function labelPoint(gs, target) {
    const at = (f) => L.latLng(target.lat + (gs.lat - target.lat) * f, target.lon + (gs.lon - target.lon) * f);
    const size = map.getSize();
    // Room for the whole label, which is centered on its point.
    const el = gsLine?.getTooltip()?.getElement();
    const halfW = (el?.offsetWidth ?? 140) / 2 + 6;
    const halfH = (el?.offsetHeight ?? 24) / 2 + 6;
    const inside = (ll) => {
      const p = map.latLngToContainerPoint(ll);
      return p.x > halfW && p.x < size.x - halfW && p.y > halfH && p.y < size.y - halfH;
    };
    for (let step = 0; step <= 9; step++) {
      for (const f of step === 0 ? [0.5] : [0.5 - step * 0.05, 0.5 + step * 0.05]) {
        const ll = at(f);
        if (inside(ll)) return ll;
      }
    }
    // Nothing fits: clamp the middle point into the frame.
    const mid = map.latLngToContainerPoint(at(0.5));
    const x = Math.min(Math.max(mid.x, halfW), size.x - halfW);
    const y = Math.min(Math.max(mid.y, halfH), size.y - halfH);
    return map.containerPointToLatLng(L.point(x, y));
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
    mapPanel.hidden = true;
    // Following means nothing without a map, so the toggle goes away.
    followLabel.hidden = true;
    nomapList = h('ul', { class: 'fc-nomap-list' });
    gsRow = h('li', { class: 'fc-nomap-line' });
    fallbackRows.clear();
    // After a tile failure, either background can be tried again. The
    // buttons move here from the map's corner, and back when the map returns.
    const retry = reason === 'tiles'
      ? h('div', { class: 'fc-nomap-retry' }, h('p', { class: 'fc-nomap-note' }, 'Try loading a map background again.'), layerPick)
      : null;
    const panel = h('div', { class: 'fc-nomap' },
      h('h3', { class: 'fc-nomap-title' }, 'No map'),
      h('p', { class: 'fc-nomap-note' }, `${message} Map tiles need internet. Tracking still works.`),
      retry,
      nomapList);
    setChildren(frame, panel);
    setText(status, '');
    updateLayerControls();
    drawFallback();
  }

  // From the no-map panel: bring the map back with the chosen background.
  function retryMap() {
    if (!L || destroyed) return;
    mode = 'loading';
    fallbackReason = null;
    mapPanel.prepend(layerPick);
    setChildren(frame, canvas, mapPanel);
    followLabel.hidden = false;
    startLeaflet(L);
  }

  function fallbackRow(rocket) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '-30 -30 60 60');
    svg.setAttribute('class', 'fc-arrow');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('r', '26');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'rgba(244,242,237,0.35)');
    ring.setAttribute('stroke-width', '2');
    const north = document.createElementNS(ns, 'text');
    north.setAttribute('y', '-17');
    north.setAttribute('text-anchor', 'middle');
    north.setAttribute('font-size', '9');
    north.setAttribute('fill', '#D2CEC5');
    north.textContent = 'N';
    // An arrow pointing along the bearing, with north at the top.
    const arrow = document.createElementNS(ns, 'g');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M0 -22 L8 -6 L2.5 -6 L2.5 18 L-2.5 18 L-2.5 -6 L-8 -6 Z');
    path.setAttribute('fill', rocket.profile.color);
    arrow.append(path);
    svg.append(ring, north, arrow);

    const position = h('div', { class: 'fc-nomap-line' });
    const range = h('div', { class: 'fc-nomap-line' });
    const fixNote = h('div', { class: 'fc-nomap-line fc-fix-no' });
    const li = h('li', { class: 'fc-nomap-item' },
      svg,
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
    if (change.type === 'reset' || change.type === 'clear') {
      if (mode === 'leaflet') clearRocketLayers();
      scheduler.schedule();
      return;
    }
    if (change.type === 'focus' && mode === 'leaflet') {
      // Redraw lines so the new focused rocket is thicker and on top.
      for (const layers of rocketLayers.values()) layers.focused = null;
    }
    scheduler.schedule();
  });

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      scheduler.cancel();
      removeMap();
    },
  };
}
