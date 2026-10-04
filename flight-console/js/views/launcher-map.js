// launcher-map.js
// The featured flight card's picture. A flight with a cover in the manifest
// (entry.cover, a picture of the flight in the 3D view) shows that. Any
// other flight, or a cover that didn't load, gets the map picture.
//
// The map picture is the flight track on Esri
// satellite photos, small and not interactive (no dragging, zooming or
// keyboard). It never makes the card wait for the map. A drawn version of
// the same track (an SVG plan on a dark background, in the same Web
// Mercator projection the map uses, with a grid and a distance scale)
// shows at once. The satellite map starts once Leaflet is here and Esri
// accepts the key, and fades in over the plan only after its photos have
// actually loaded. If the key is refused, the photos fail, or Leaflet
// never loads, the drawn version simply stays, so nothing flashes.
// Everything comes from the manifest summary (track, trackGaps, padPoint,
// landingPoint, driftM), never from the flight's data files.
// Used by: launcher.js.

import { h, svg, setChildren, createScheduler } from './dom.js';
import { padSvg, PAD_SIZE, PAD_ANCHOR, iconNode } from './icons.js';
import { formatDistance } from '../geo.js';
import { flightFileUrl } from '../library.js';
import { checkEsriKey } from './esri.js';

// Room (px) kept around the track. The top is bigger because the launch
// rail icon stands above its point.
const FIT_ROOM = Object.freeze({ top: 64, right: 72, bottom: 60, left: 72 });
// Dashes across a stretch with no GPS fix (the console map uses the same).
const GAP_DASH = '4 8';
// The drawn plan's grid: the smallest of these spacings (m) that leaves at
// least GRID_MIN_PX between lines. The scale bar shows the same distance.
const GRID_STEPS_M = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
const GRID_MIN_PX = 64;
// Web Mercator: the whole world is 256 px wide at zoom 0, as in Leaflet.
const TILE_PX = 256;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
// Landing marker size (px). Its middle is the landing point.
const LANDING_PX = 18;
// The credit line's separator, the same as the console map's.
const CREDIT_SEP = ' <span aria-hidden="true">|</span> ';

// entry is the featured manifest entry. Returns null when there is no cover
// and the summary has no points at all (the card then leaves the picture
// out), otherwise { el, refresh(), destroy() }. refresh() re-fits after the
// launcher was hidden, in case the window changed size meanwhile.
export function createFlightPicture(entry, options) {
  return entry.cover ? createCoverPicture(entry, options) : createMapPicture(entry, options);
}

// The gold corner marks on every picture.
function cornerMarks() {
  return ['tl', 'tr', 'bl', 'br'].map((c) => h('span', { class: `hero-corner ${c}`, 'aria-hidden': 'true' }));
}

// ------------------------------------------------------------------
// The cover picture
// ------------------------------------------------------------------

// The flight's cover from its own folder, with the credit line its imagery
// needs. The flight-console.css rules for .fc-pic-cover keep the middle of
// the picture in view at every card size. If the file doesn't load, the map
// picture takes its place.
function createCoverPicture(entry, options) {
  const { file, alt, credit } = entry.cover;
  let dead = false;
  let fallback = null;   // the map picture, made only if the cover failed

  const img = h('img', { class: 'fc-pic-cover', src: flightFileUrl(entry.id, file), alt, decoding: 'async' });
  // One line until it is hovered or tapped, like the map's credit line.
  const creditLine = credit ? h('p', { class: 'fc-pic-credit' }, credit) : null;
  creditLine?.addEventListener('click', () => creditLine.classList.toggle('fc-credit-open'));
  const el = h('div', { class: 'fc-pic fc-pic--cover' }, img, creditLine, cornerMarks());

  img.addEventListener('error', () => {
    if (dead || fallback) return;
    console.warn(`Flight Console: the cover picture ${file} did not load, so the map picture shows instead.`);
    fallback = createMapPicture(entry, options);
    if (fallback) {
      el.replaceWith(fallback.el);
    } else {
      // No track to draw either: the picture area stays, empty.
      img.remove();
      creditLine?.remove();
    }
  });

  return {
    el,
    refresh() { fallback?.refresh(); },
    destroy() {
      dead = true;
      fallback?.destroy();
    },
  };
}

// ------------------------------------------------------------------
// The map picture
// ------------------------------------------------------------------
function createMapPicture(entry, { config, libs }) {
  const s = entry.summary ?? {};
  const track = s.track ?? [];
  const gaps = new Set(s.trackGaps ?? []);
  const pad = s.padPoint ?? null;
  const landing = s.landingPoint ?? null;
  const points = [...track, pad, landing].filter(Boolean);
  if (!points.length) return null;

  const plan = h('div', { class: 'fc-pic-plan', 'aria-hidden': 'true' });
  const mapBox = h('div', { class: 'fc-pic-map' });
  const el = h('div', { class: 'fc-pic' },
    plan,
    mapBox,
    h('p', { class: 'sr-only' }, describe(s, track, pad)),
    cornerMarks());

  let L = null;
  let map = null;
  let shownLive = false;   // the satellite map has replaced the drawn plan
  let dead = false;
  let failTimer = null;
  let lastSize = '';

  const redraw = createScheduler(() => {
    const w = Math.round(el.clientWidth);
    const hgt = Math.round(el.clientHeight);
    // Hidden (the console is open), or not laid out yet.
    if (!w || !hgt) return;
    const size = `${w}x${hgt}`;
    if (size === lastSize) return;
    lastSize = size;
    if (!shownLive) drawPlan(w, hgt);
    if (map) {
      map.invalidateSize({ animate: false });
      fitMap();
    }
  }, { maxFps: 15 });
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(() => redraw.schedule()) : null;
  resizeObserver?.observe(el);
  // Draw once the card is on the page (render() adds it right after this).
  redraw.schedule();

  // The map starts once the map library is here (it may arrive late, or
  // never) and Esri has said it accepts the key, the same check the console
  // map makes (esri.js, which remembers a yes for the rest of the visit).
  // Until then, or if either never happens, the plan shows.
  const keyOk = checkEsriKey(config);
  const startWhenKeyOk = (lib) => keyOk.then((ok) => { if (ok) startMap(lib); });
  libs?.leaflet?.ready?.then((lib) => {
    if (lib) startWhenKeyOk(lib);
    else libs.leaflet.late?.then(startWhenKeyOk);
  });

  // ------------------------------------------------------------------
  // The drawn plan
  // ------------------------------------------------------------------
  function drawPlan(w, hgt) {
    const view = fitView(points, w, hgt, config);
    const place = (p) => view.toPx(p);
    const style = trackStyle(config);

    // A grid at a round distance, lined up with the launch point.
    const mPerPx = EARTH_CIRCUMFERENCE_M * Math.cos(view.centerLat * Math.PI / 180) / (TILE_PX * view.scale);
    const stepM = GRID_STEPS_M.find((m) => m / mPerPx >= GRID_MIN_PX) ?? GRID_STEPS_M[GRID_STEPS_M.length - 1];
    const stepPx = stepM / mPerPx;
    const [ox, oy] = place(pad ?? points[0]);
    let grid = '';
    for (let x = ox - Math.ceil(ox / stepPx) * stepPx; x <= w; x += stepPx) grid += `M${x.toFixed(1)} 0V${hgt}`;
    for (let y = oy - Math.ceil(oy / stepPx) * stepPx; y <= hgt; y += stepPx) grid += `M0 ${y.toFixed(1)}H${w}`;

    const { solid, dashed } = trackPieces(track, gaps);
    const line = (pts) => pts.map((p, i) => {
      const [x, y] = place(p);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join('');
    const halo = { fill: 'none', stroke: style.haloColor, 'stroke-opacity': style.haloOpacity, 'stroke-width': style.haloWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const gold = { fill: 'none', stroke: style.color, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

    const drawing = svg('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, focusable: 'false' },
      svg('path', { class: 'fc-pic-grid', d: grid }),
      solid.map((run) => svg('path', { ...halo, d: line(run) })),
      dashed.map((pair) => svg('path', { ...halo, 'stroke-dasharray': GAP_DASH, d: line(pair) })),
      solid.map((run) => svg('path', { ...gold, d: line(run) })),
      dashed.map((pair) => svg('path', { ...gold, 'stroke-dasharray': GAP_DASH, d: line(pair) })));
    if (landing) {
      const [x, y] = place(landing);
      const icon = iconNode(landingSvg(config));
      icon.setAttribute('x', (x - LANDING_PX / 2).toFixed(1));
      icon.setAttribute('y', (y - LANDING_PX / 2).toFixed(1));
      drawing.append(icon);
    }
    if (pad) {
      // The bottom middle of the blast plate sits on the pad point.
      const [x, y] = place(pad);
      const icon = iconNode(padSvg());
      icon.setAttribute('x', (x - PAD_ANCHOR[0]).toFixed(1));
      icon.setAttribute('y', (y - PAD_ANCHOR[1]).toFixed(1));
      drawing.append(icon);
    }
    setChildren(plan, drawing,
      h('div', { class: 'fc-pic-scale' }, h('div', { class: 'fc-pic-scale-line', style: { width: `${Math.round(stepPx)}px` } }, scaleText(stepM))));
  }

  // ------------------------------------------------------------------
  // The satellite map
  // ------------------------------------------------------------------
  function startMap(lib) {
    if (dead || map || !lib || !config.ESRI_API_KEY) return;
    L = lib;
    try {
      map = L.map(mapBox, {
        zoomControl: false,
        attributionControl: true,
        dragging: false,
        touchZoom: false,
        doubleClickZoom: false,
        scrollWheelZoom: false,
        boxZoom: false,
        keyboard: false,
        // Any zoom, so the map fits exactly like the drawn plan underneath.
        zoomSnap: 0,
        // The whole map fades in at once (the launcher part of flight-console.css), so the photos don't
        // fade one by one (half-faded photos show light seams).
        fadeAnimation: false,
        zoomAnimation: false,
        markerZoomAnimation: false,
        maxZoom: config.TILE_MAX_ZOOM,
      });
      map.attributionControl.setPrefix(false);
      // The credit line opens in full when tapped, like the console map's.
      const creditBox = map.attributionControl.getContainer();
      creditBox.addEventListener('click', (e) => {
        if (!e.target.closest('a')) creditBox.classList.toggle('fc-credit-open');
      });
      L.control.scale({ imperial: false, maxWidth: 100, position: 'bottomleft' }).addTo(map);
      fitMap();
      drawTrack();

      const tiles = L.tileLayer(config.SATELLITE_URL, {
        key: encodeURIComponent(config.ESRI_API_KEY),
        maxZoom: config.TILE_MAX_ZOOM,
        maxNativeZoom: config.SATELLITE_MAX_NATIVE_ZOOM,
        className: 'fc-sat-tiles',
        attribution: `${config.ESRI_POWERED_BY}${CREDIT_SEP}${config.SATELLITE_ATTRIBUTION}`,
      });
      watchTiles(tiles);
      tiles.addTo(map);
    } catch (err) {
      console.warn('Flight Console: the launcher map picture could not start, so the drawn version stays.', err);
      removeMap();
    }
  }

  function fitMap() {
    if (!map) return;
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [FIT_ROOM.left, FIT_ROOM.top],
      paddingBottomRight: [FIT_ROOM.right, FIT_ROOM.bottom],
      maxZoom: config.FIT_MAX_ZOOM,
      animate: false,
    });
  }

  function drawTrack() {
    const style = trackStyle(config);
    const halo = { color: style.haloColor, opacity: style.haloOpacity, weight: style.haloWidth, interactive: false };
    const gold = { color: style.color, opacity: 1, weight: style.width, interactive: false };
    const { solid, dashed } = trackPieces(track, gaps);
    for (const run of solid) L.polyline(run, halo).addTo(map);
    for (const pair of dashed) L.polyline(pair, { ...halo, dashArray: GAP_DASH }).addTo(map);
    for (const run of solid) L.polyline(run, gold).addTo(map);
    for (const pair of dashed) L.polyline(pair, { ...gold, dashArray: GAP_DASH }).addTo(map);
    if (landing) {
      L.marker(landing, {
        icon: L.divIcon({ html: landingSvg(config), iconSize: [LANDING_PX, LANDING_PX], iconAnchor: [LANDING_PX / 2, LANDING_PX / 2], className: '' }),
        interactive: false,
        keyboard: false,
      }).addTo(map);
    }
    if (pad) {
      L.marker(pad, {
        icon: L.divIcon({ html: padSvg(), iconSize: PAD_SIZE, iconAnchor: PAD_ANCHOR, className: '' }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 100,
      }).addTo(map);
    }
  }

  // The map only replaces the plan once every photo in view has loaded.
  // No photo at all (errors only), or nothing finished within
  // TILE_FAIL_TIMEOUT_MS, means the photos aren't coming: the map goes away
  // and the plan stays.
  function watchTiles(tiles) {
    let loads = 0;
    let errors = 0;
    tiles.on('tileload', () => { loads += 1; });
    tiles.on('tileerror', () => { errors += 1; });
    tiles.on('load', () => {
      if (shownLive) return;
      if (loads > 0 && errors === 0) showLive();
      else if (loads === 0) giveUp();
    });
    failTimer = setTimeout(() => { if (!shownLive) giveUp(); }, config.TILE_FAIL_TIMEOUT_MS);
  }

  function showLive() {
    if (dead) return;
    clearTimeout(failTimer);
    shownLive = true;
    el.classList.add('fc-pic--live');
  }

  // Waits for the current Leaflet event to finish first: removing the map
  // from inside the tile layer's own "load" event breaks Leaflet.
  function giveUp() {
    clearTimeout(failTimer);
    failTimer = setTimeout(removeMap, 0);
  }

  function removeMap() {
    if (dead) return;
    if (map) {
      try { map.remove(); } catch { /* already gone */ }
    }
    map = null;
    mapBox.replaceChildren();
    el.classList.remove('fc-pic--live');
    shownLive = false;
    // The plan may have skipped a resize while the map was showing.
    lastSize = '';
    redraw.schedule();
  }

  return {
    el,
    refresh() {
      lastSize = '';
      redraw.schedule();
    },
    destroy() {
      dead = true;
      clearTimeout(failTimer);
      redraw.cancel();
      resizeObserver?.disconnect();
      if (map) {
        try { map.remove(); } catch { /* already gone */ }
      }
      map = null;
    },
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

// The text alternative for the picture.
function describe(s, track, pad) {
  if (!track.length) return pad ? 'Map of the launch point.' : 'Map of the landing point.';
  const drift = Number.isFinite(s.driftM) ? ` The rocket landed ${formatDistance(s.driftM)} from the pad.` : '';
  return `Map of the flight track.${drift}`;
}

// The track split at GPS gaps: solid runs, and the two points either side
// of each gap (drawn dashed). trackGaps lists i where there was no fix
// between point i - 1 and point i.
function trackPieces(track, gaps) {
  const solid = [];
  const dashed = [];
  let run = track.length ? [track[0]] : [];
  for (let i = 1; i < track.length; i++) {
    if (gaps.has(i)) {
      if (run.length > 1) solid.push(run);
      dashed.push([track[i - 1], track[i]]);
      run = [track[i]];
    } else {
      run.push(track[i]);
    }
  }
  if (run.length > 1) solid.push(run);
  return { solid, dashed };
}

// The gold track with its dark outline, as the console map draws the
// focused rocket.
function trackStyle(config) {
  return {
    color: config.TRACK_COLOR,
    width: config.TRACK_WEIGHT_FOCUSED_PX,
    haloColor: config.HALO_COLOR,
    haloOpacity: config.HALO_OPACITY,
    haloWidth: config.TRACK_WEIGHT_FOCUSED_PX + 2 * config.HALO_WIDTH_PX,
  };
}

// A small target where the rocket landed: an off-white ring with a gold
// middle, outlined in dark so it shows on photos. Built from config colors
// only, never from data.
function landingSvg(config) {
  const c = LANDING_PX / 2;
  return `<svg class="fc-pic-landing" viewBox="0 0 ${LANDING_PX} ${LANDING_PX}" width="${LANDING_PX}" height="${LANDING_PX}" aria-hidden="true" focusable="false">` +
    `<circle cx="${c}" cy="${c}" r="6.2" fill="none" stroke="${config.HALO_COLOR}" stroke-opacity="0.8" stroke-width="4"/>` +
    `<circle cx="${c}" cy="${c}" r="6.2" fill="none" stroke="${config.PAD_COLOR}" stroke-width="1.6"/>` +
    `<circle cx="${c}" cy="${c}" r="2.6" fill="${config.TRACK_COLOR}" stroke="${config.HALO_COLOR}" stroke-width="1"/>` +
    '</svg>';
}

// Web Mercator position of [lat, lon] in world pixels at zoom 0.
function project([lat, lon]) {
  const sin = Math.sin(lat * Math.PI / 180);
  return [
    TILE_PX * (lon + 180) / 360,
    TILE_PX * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  ];
}

// The same fit Leaflet's fitBounds makes with FIT_ROOM as padding and
// FIT_MAX_ZOOM as the closest zoom: the points' box, centered in the room
// left inside the padding, as large as fits.
function fitView(points, w, hgt, config) {
  const xy = points.map(project);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const roomW = Math.max(1, w - FIT_ROOM.left - FIT_ROOM.right);
  const roomH = Math.max(1, hgt - FIT_ROOM.top - FIT_ROOM.bottom);
  // A flat box (all points in a line) only limits the other direction.
  const fitX = maxX > minX ? roomW / (maxX - minX) : Infinity;
  const fitY = maxY > minY ? roomH / (maxY - minY) : Infinity;
  const scale = Math.min(fitX, fitY, 2 ** config.FIT_MAX_ZOOM);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const lats = points.map((p) => p[0]);
  return {
    scale,
    centerLat: (Math.min(...lats) + Math.max(...lats)) / 2,
    toPx(p) {
      const [x, y] = project(p);
      return [FIT_ROOM.left + roomW / 2 + (x - cx) * scale, FIT_ROOM.top + roomH / 2 + (y - cy) * scale];
    },
  };
}

// "500 m", "2 km"
function scaleText(m) {
  return m < 1000 ? `${m} m` : `${m / 1000} km`;
}
