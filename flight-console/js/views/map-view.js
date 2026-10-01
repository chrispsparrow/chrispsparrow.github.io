// map-view.js
// The map: a colored circle and track for every rocket (the focused one
// larger and on top), the launch pad, the ground station in teal, and a
// line from the ground station to the focused rocket labeled with distance
// and bearing. Only good GPS positions are ever drawn. With no fix (or no
// recent packets at all), the marker turns hollow at the last good position
// and says how old it is. Across a fix gap, the track is dashed.
//
// If Leaflet didn't load, or the map tiles keep failing, the map is
// replaced by a "No map" panel with each rocket's position, distance and
// bearing, and an arrow. Tracking keeps working either way. If Leaflet
// shows up late (slow connection), the real map takes over.
//
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { rangeAndBearing, formatRangeBearing, formatAge, formatNumber, MISSING } from '../geo.js';

// The views the switcher offers. A 3D view (CesiumJS) will be added to this
// list in a later phase. Only views that really work are listed.
const VIEW_MODES = [{ id: 'map', label: 'Map' }];

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
  // Says "(demo position)" while the ground station is the config placeholder.
  const legendGsText = h('span', {}, 'Ground station');
  const legend = h('div', { class: 'fc-map-legend', 'aria-hidden': 'true' },
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-line' }), 'Rocket track'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-line fc-legend-line--dash' }), 'Dashed line means no GPS fix'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-ring fc-legend-ring--pad', style: { '--pad': config.PAD_COLOR } }), 'Launch pad'),
    h('div', { class: 'fc-legend-row' }, h('span', { class: 'fc-legend-ring' }), legendGsText));
  legend.hidden = true;
  const frame = h('div', { class: 'fc-map-frame' }, canvas, waitBox, legend);
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
  let tileTimer = null;
  let resizeObserver = null;
  const rocketLayers = new Map(); // rocketId -> layers for that rocket
  let gsMarker = null;
  let gsLine = null;
  let padMarkers = new Map();
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
        setChildren(frame, canvas, legend);
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
      // Tiles go on once main.js knows which key to use (on localhost it
      // first tries js/config.local.js).
      ctx.tileKey.then(({ key, source }) => {
        if (destroyed || mode !== 'leaflet' || !map) return;
        if (key) {
          const tiles = L.tileLayer(config.TILE_URL, {
            key: encodeURIComponent(key),
            maxZoom: config.TILE_MAX_ZOOM,
            attribution: config.TILE_ATTRIBUTION,
          });
          watchTiles(tiles);
          tiles.addTo(map);
          return;
        }
        // No key: don't ask CARTO for tiles that would only say "API key required".
        noTilesNote = source === 'missing-local'
          ? 'On this computer the map background needs the local CARTO key in js/config.local.js, so tracks show on a plain background. Tracking still works.'
          : 'The map background needs a CARTO key that isn\'t set up yet, so tracks show on a plain background. Tracking still works.';
        scheduler.schedule();
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
    legend.hidden = false;
    fitted = false;
    redrawAll();
  }

  // More than TILE_FAIL_COUNT tile errors with no tile loaded within
  // TILE_FAIL_TIMEOUT_MS means the tiles can't be reached (usually no
  // internet), so switch to the no-map panel.
  function watchTiles(tiles) {
    let errors = 0;
    let loads = 0;
    let windowOver = false;
    const check = () => {
      if (mode === 'leaflet' && windowOver && loads === 0 && errors > config.TILE_FAIL_COUNT) {
        showFallback('tiles', 'The map tiles didn\'t load.');
      }
    };
    tiles.on('tileload', () => { loads += 1; });
    tiles.on('tileerror', () => { errors += 1; check(); });
    tileTimer = setTimeout(() => { windowOver = true; check(); }, config.TILE_FAIL_TIMEOUT_MS);
  }

  function removeMap() {
    clearTimeout(tileTimer);
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (map) {
      map.off();
      map.remove();
    }
    map = null;
    rocketLayers.clear();
    padMarkers = new Map();
    gsMarker = null;
    gsLine = null;
  }

  function layersFor(rocket) {
    let layers = rocketLayers.get(rocket.id);
    if (!layers) {
      layers = { drawn: 0, solid: null, lines: [], marker: null, tipMode: null, focused: null };
      rocketLayers.set(rocket.id, layers);
    }
    return layers;
  }

  function clearRocketLayers() {
    for (const layers of rocketLayers.values()) {
      for (const line of layers.lines) line.remove();
      layers.marker?.remove();
    }
    rocketLayers.clear();
    for (const m of padMarkers.values()) m.remove();
    padMarkers.clear();
    gsLine?.remove();
    gsLine = null;
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
      gsMarker = L.circleMarker([gs.lat, gs.lon], {
        radius: 8, color: config.GROUND_STATION_COLOR, weight: 3, fillColor: config.GROUND_STATION_COLOR, fillOpacity: 0.25,
      }).addTo(map);
      gsMarker.bindTooltip(gsText, { className: 'fc-tip fc-tip--gs', direction: 'bottom', offset: [0, 8] });
    } else {
      gsMarker.setLatLng([gs.lat, gs.lon]);
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
          const m = L.circleMarker(ll, { radius: 6, color: config.PAD_COLOR, weight: 2, fillOpacity: 0 }).addTo(map);
          m.bindTooltip(rockets.length > 1 ? `Launch pad of ${rocket.profile.name}` : 'Launch pad', { className: 'fc-tip', direction: 'left', offset: [-8, 0] });
          padMarkers.set(rocket.id, m);
        } else {
          pad.setLatLng(ll);
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
          const dash = L.polyline([[prev.lat, prev.lon], ll], { color, weight: config.TRACK_WEIGHT_PX, opacity: 0.9, dashArray: '4 8', interactive: false }).addTo(map);
          layers.lines.push(dash);
          layers.solid = null;
        }
        if (!layers.solid) {
          layers.solid = L.polyline([ll], { color, weight, opacity: 0.95, interactive: false }).addTo(map);
          layers.lines.push(layers.solid);
        } else {
          layers.solid.addLatLng(ll);
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
        if (!layers.marker) layers.marker = L.circleMarker(ll, style).addTo(map);
        else layers.marker.setLatLng(ll).setStyle(style);

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
        for (const line of layers.lines) if (!line.options.dashArray) line.setStyle({ weight });
        layers.focused = isFocused;
      }
      if (isFocused) {
        for (const line of layers.lines) line.bringToFront();
        layers.marker?.bringToFront();
      }
    }

    const target = focused?.lastGoodFix;
    // The legend covers the top right corner, so fitting and following
    // treat that area like the map's edge.
    const legendBox = legend.hidden ? { w: 0, h: 0 } : { w: legend.offsetWidth + 12, h: legend.offsetHeight + 12 };

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
        // The legend sits in the top right corner. Keeping either the top
        // band or the right band free clears it, so use whichever lets the
        // map zoom in closer (on a phone that is usually the top band).
        const topBand = { paddingTopLeft: [pad, Math.max(pad, legendBox.h)], paddingBottomRight: [pad, pad] };
        const rightBand = { paddingTopLeft: [pad, pad], paddingBottomRight: [Math.max(pad, legendBox.w), pad] };
        const zoomFor = (o) => map.getBoundsZoom(bounds, false, L.point(o.paddingTopLeft).add(o.paddingBottomRight));
        const best = zoomFor(topBand) >= zoomFor(rightBand) ? topBand : rightBand;
        map.fitBounds(bounds, { ...best, maxZoom: config.FIT_MAX_ZOOM, animate: false });
        fitted = true;
        justFitted = true;
      }
    }

    // Follow: pan when the focused rocket gets near the edge of the view,
    // or slips under the legend.
    if (follow && target && !justFitted) {
      const ll = L.latLng(target.lat, target.lon);
      const p = map.latLngToContainerPoint(ll);
      const size = map.getSize();
      const m = config.FOLLOW_EDGE_PX;
      const nearEdge = p.x < m || p.y < m || p.x > size.x - m || p.y > size.y - m;
      const underLegend = legendBox.w > 0 && p.x > size.x - legendBox.w && p.y < legendBox.h;
      if (nearEdge || underLegend) map.panTo(ll, { animate: !reducedMotion, duration: 0.5 });
    }

    // Line from the ground station to the focused rocket.
    if (target) {
      // Short, as in "1.24 km, bearing 58° (NE)". The legend and the ground
      // station's own label say when its position is only a demo.
      const label = formatRangeBearing(rangeAndBearing(gs, target));
      const pts = [[gs.lat, gs.lon], [target.lat, target.lon]];
      if (!gsLine) {
        gsLine = L.polyline(pts, { color: config.GROUND_STATION_COLOR, weight: 2, opacity: 0.9, interactive: false }).addTo(map);
        gsLine.bindTooltip(label, { permanent: true, direction: 'center', className: 'fc-tip fc-tip--gs' });
      } else {
        gsLine.setLatLngs(pts);
        gsLine.setTooltipContent(label);
      }
      gsLine.getTooltip()?.setLatLng(labelPoint(gs, target));
      rocketLayers.get(focused.id)?.marker?.bringToFront();
    } else if (gsLine) {
      gsLine.remove();
      gsLine = null;
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
    return [noFixAnywhere ? 'No GPS fix yet, so there is no rocket to draw.' : '', focusNote, noTilesNote].filter(Boolean).join(' ');
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
    legend.hidden = true;
    // Following means nothing without a map, so the toggle goes away.
    followLabel.hidden = true;
    nomapList = h('ul', { class: 'fc-nomap-list' });
    gsRow = h('li', { class: 'fc-nomap-line' });
    fallbackRows.clear();
    const panel = h('div', { class: 'fc-nomap' },
      h('h3', { class: 'fc-nomap-title' }, 'No map'),
      h('p', { class: 'fc-nomap-note' }, `${message} Map tiles need internet. Tracking still works.`),
      nomapList);
    setChildren(frame, panel);
    setText(status, '');
    drawFallback();
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
