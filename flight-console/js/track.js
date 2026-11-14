// track.js
// The breadcrumb trail: one "crumb" for every position fix a board sent,
// with what the map needs to draw it honestly. The store keeps one trail
// per rocket (rocket.crumbs) and feeds it every sample.
//
// A crumb:
//   {
//     t,                  data time in seconds
//     lat, lon,           the raw position. Never smoothed. The dots use it.
//     altMsl,             the raw GPS altitude in meters, or null (a 2D fix)
//     sats, hdop,         as the board sent them, or null
//     quality,            'good'     passed the quality gate and the outlier
//                                    test. It gets a solid dot and joins the line.
//                         'weak'     failed the quality gate: no 3D fix, fewer
//                                    than MIN_SATS satellites, or an HDOP over
//                                    MAX_HDOP (or unknown). A hollow grey dot,
//                                    never on the line.
//                         'outlier'  would mean an impossible jump from the last
//                                    good fix. Not drawn at all.
//     gapBefore,          true when packets were missed between the previous
//                         received fix and this one (or the fix was lost in
//                         between). The line must break before this crumb,
//                         never bridge the gap.
//     speedMps,           how fast the board was moving here, for the speed
//                         colors, or null when it can't be known (the first
//                         fix, or right after a gap)
//     line,               { lat, lon, altMsl }: the smoothed position for the
//                         LINE only (a moving average of the last
//                         LINE_SMOOTH_FIXES good fixes in the same unbroken
//                         run). null unless quality is 'good'.
//   }
//
// The dots are always raw, and so is the CSV export, which never comes
// through here.
//
// Used by: store.js (one trail per rocket), the map and the 3D view (they
// read rocket.crumbs), and the tests. No DOM, so Node can run it too.

import * as config from './config.js';
import { hasGoodPosition } from './schema.js';
import { distanceM } from './geo.js';

const DEFAULTS = Object.freeze({
  MIN_SATS: config.MIN_SATS,
  MAX_HDOP: config.MAX_HDOP,
  OUTLIER_MAX_SPEED_MPS: config.OUTLIER_MAX_SPEED_MPS,
  OUTLIER_MIN_JUMP_M: config.OUTLIER_MIN_JUMP_M,
  TRACK_GAP_S: config.TRACK_GAP_S,
  LINE_SMOOTH_FIXES: config.LINE_SMOOTH_FIXES,
});

// True when a sample carries a position at all (good enough or not).
export function hasPosition(sample) {
  const g = sample?.gps;
  return Boolean(g) && g.fix === 1 && Number.isFinite(g.lat) && Number.isFinite(g.lon);
}

// Straight-line distance between two fixes in meters, counting height when
// both have one.
export function distance3dM(a, b) {
  const ground = distanceM(a.lat, a.lon, b.lat, b.lon);
  const dAlt = Number.isFinite(a.altMsl) && Number.isFinite(b.altMsl) ? b.altMsl - a.altMsl : 0;
  return Math.hypot(ground, dAlt);
}

// Makes one rocket's trail. overrides replaces any of the settings above.
//   trail.crumbs        the crumbs so far, oldest first (the same array every time)
//   trail.push(sample)  looks at one sample, in time order. Returns the new
//                       crumb, or null when the sample had no position.
//   trail.reset()       forgets everything
export function createCrumbTrail(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const crumbs = [];
  let lastGood = null;      // the last good crumb
  let lastHeardT = null;    // time of the previous sample that had a GPS group
  let lostSince = false;    // a GPS sample with no position came since the last crumb
  let run = [];             // the good crumbs since the last gap, for smoothing

  function push(sample) {
    if (!sample || !sample.gps || !Number.isFinite(sample.t)) return null;
    const t = sample.t;
    const missed = lastHeardT !== null && t - lastHeardT > cfg.TRACK_GAP_S;
    lastHeardT = t;
    if (!hasPosition(sample)) {
      lostSince = true;
      return null;
    }
    const g = sample.gps;
    const gapBefore = crumbs.length > 0 && (missed || lostSince);
    lostSince = false;

    const crumb = {
      t,
      lat: g.lat,
      lon: g.lon,
      altMsl: Number.isFinite(g.altMsl) ? g.altMsl : null,
      sats: Number.isFinite(g.sats) ? g.sats : null,
      hdop: Number.isFinite(g.hdop) ? g.hdop : null,
      quality: 'good',
      gapBefore,
      speedMps: null,
      line: null,
    };

    const gateOk = hasGoodPosition(sample) &&
      crumb.sats !== null && crumb.sats >= cfg.MIN_SATS &&
      crumb.hdop !== null && crumb.hdop <= cfg.MAX_HDOP;
    if (!gateOk) {
      crumb.quality = 'weak';
    } else if (lastGood) {
      const dt = t - lastGood.t;
      const hop = distance3dM(lastGood, crumb);
      if (dt > 0 && hop > cfg.OUTLIER_MIN_JUMP_M && hop / dt > cfg.OUTLIER_MAX_SPEED_MPS) crumb.quality = 'outlier';
      else if (dt > 0 && !gapBefore) crumb.speedMps = hop / dt;
    }

    if (crumb.quality === 'good') {
      if (gapBefore) run = [];
      run.push(crumb);
      if (run.length > cfg.LINE_SMOOTH_FIXES) run.shift();
      const mean = (key) => run.reduce((sum, c) => sum + c[key], 0) / run.length;
      const alts = run.filter((c) => c.altMsl !== null);
      crumb.line = {
        lat: mean('lat'),
        lon: mean('lon'),
        altMsl: alts.length ? alts.reduce((sum, c) => sum + c.altMsl, 0) / alts.length : null,
      };
      lastGood = crumb;
    }
    crumbs.push(crumb);
    return crumb;
  }

  function reset() {
    crumbs.length = 0;
    lastGood = null;
    lastHeardT = null;
    lostSince = false;
    run = [];
  }

  return { crumbs, push, reset, config: Object.freeze({ ...cfg }) };
}

// ------------------------------------------------------------------
// Speed colors: the thermal ramp from slow purple to fast pale yellow.
// The ramp's two darkest stops are left out, since they wouldn't show on
// a dark map.
// ------------------------------------------------------------------
export const TRACK_RAMP = Object.freeze(config.THERMAL_RAMP.slice(2));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A color along a ramp of hex stops. frac is 0 (first stop) to 1 (last).
export function rampColor(frac, stops = TRACK_RAMP) {
  const f = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const k = f - i;
  const mix = a.map((v, j) => Math.round(v + (b[j] - v) * k));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// The color for a speed in m/s. A missing speed gets the slow end.
export function speedColor(speedMps, maxMps = config.TRACK_SPEED_MAX_MPS) {
  if (!Number.isFinite(speedMps) || !(maxMps > 0)) return TRACK_RAMP[0];
  // A square root spreads the slow speeds out, where a descent under
  // parachute spends most of its time.
  return rampColor(Math.sqrt(Math.min(1, Math.max(0, speedMps / maxMps))));
}
