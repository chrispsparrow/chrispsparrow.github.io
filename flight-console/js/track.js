// track.js
// The breadcrumb trail: one "crumb" for every position fix a board sent,
// with what the map needs to draw it honestly. The store keeps one trail
// per rocket (rocket.crumbs) and feeds it every sample.
//
// A crumb:
//   {
//     t,                  data time in seconds
//     lat, lon,           the raw position. Never smoothed. The dots use it.
//     altMsl,             the raw GPS altitude in meters, or null
//     sats, hdop,         as the board sent them, or null
//     seq,                the packet's sequence number, or null
//     groundSpeedMps,     the receiver's own ground speed (horizontal), or null
//     quality,            'good'     passed the quality gate and the outlier
//                                    test. It gets a solid dot and joins the line.
//                         'weak'     failed the quality gate (see below). A
//                                    hollow grey dot, never on the line.
//                         'outlier'  would mean an impossible jump from the last
//                                    good fix. Not drawn at all.
//     gapBefore,          true when the line must break before this crumb,
//                         never bridge it. On a weak or outlier crumb: packets
//                         were missed (or the fix was lost) since the crumb
//                         before. On a good crumb: that happened at any point
//                         since the previous GOOD crumb, or the previous good
//                         crumb is more than TRACK_GAP_S older. So a map that
//                         joins good crumbs and breaks at gapBefore is right,
//                         and so is one that breaks at every gapBefore.
//     speedMps,           how fast the board was moving here, for the speed
//                         colors, or null when it can't be known. It is the
//                         straight-line speed through the air (height
//                         included) from the previous good crumb. Right after
//                         a gap it is the average speed across the gap, if the
//                         gap is no longer than TRACK_SPEED_GAP_MAX_S. The
//                         first fix, a fix after a longer gap, and every weak
//                         or outlier crumb have null. (The receiver's own
//                         ground speed is horizontal only, so a rocket going
//                         straight up would look still. It is kept in
//                         groundSpeedMps but not used for the colors.)
//     line,               { lat, lon, altMsl }: the smoothed position for the
//                         LINE only, a moving average of the last
//                         LINE_SMOOTH_FIXES good fixes in the same unbroken
//                         run, kept within LINE_SMOOTH_MAX_M of this fix.
//                         null unless quality is 'good'.
//   }
//
// The dots are always raw, and so is the CSV export, which never comes
// through here.
//
// The quality gate. A fix passes when it is a 3D fix, it has at least
// MIN_SATS satellites and its HDOP is at most MAX_HDOP. A missing count or
// HDOP fails, except from a source that sends neither (a plain CSV with
// only positions), where only the 3D fix part applies.
//
// What "a 3D fix" means for each source. The firmware doesn't send the
// receiver's fix type, so it is read from what each source does say
// (hasGoodPosition() in schema.js): the position is fresh, AND the
// altitude is fresh or at least not marked old, AND latitude, longitude
// and altitude are all numbers.
//   Radio packet ("SIM PKT", and later Manta): the "location fresh" flag
//              (bit 0, fix) and the "altitude fresh" flag (bit 1, stale is
//              its opposite). Both must be on.
//   bench_rx text lines ("PKT ..."): only fix= (bit 0) is printed, so the
//              altitude's freshness is unknown and a fix with an altitude
//              counts.
//   USB status block: LOCKED is the firmware's "location fresh" (gpsLocked
//              = fix.locationFresh in main_flight.cpp). The block doesn't
//              say whether the altitude is fresh, so LOCKED with a
//              readable altitude counts (bench-feed.js).
//   CSV and JSON: the fix column, and stale when the file has it.
//
// Gaps. Packets that carry a sequence number (sample.extra.seq, from the
// radio packets) leave a gap whenever a number is skipped (65535 is
// followed by 0). Without one, a gap is more than TRACK_GAP_S between two
// samples with GPS. A sample with GPS but no position (fix lost) is a gap
// too.
//
// Used by: store.js (one trail per rocket), the map and the 3D view (they
// read rocket.crumbs), and the tests. No DOM, so Node can run it too.

import * as config from './config.js';
import { hasGoodPosition } from './schema.js';
import { distanceM } from './geo.js';

export const TRACK_DEFAULTS = Object.freeze({
  MIN_SATS: config.MIN_SATS,
  MAX_HDOP: config.MAX_HDOP,
  OUTLIER_MAX_SPEED_MPS: config.OUTLIER_MAX_SPEED_MPS,
  OUTLIER_MIN_JUMP_M: config.OUTLIER_MIN_JUMP_M,
  OUTLIER_RESET_FIXES: config.OUTLIER_RESET_FIXES,
  TRACK_GAP_S: config.TRACK_GAP_S,
  LINE_SMOOTH_FIXES: config.LINE_SMOOTH_FIXES,
  LINE_SMOOTH_MAX_M: config.LINE_SMOOTH_MAX_M,
  TRACK_SPEED_GAP_MAX_S: config.TRACK_SPEED_GAP_MAX_S,
});

// Sequence numbers are 16 bits, so they count 0 to 65535 and start over.
const SEQ_MODULO = 65536;

// Meters per degree of latitude (close enough everywhere for small steps).
const M_PER_DEG_LAT = 111320;

// True when a sample carries a position at all (good enough or not).
export function hasPosition(sample) {
  const g = sample?.gps;
  return Boolean(g) && g.fix === 1 && Number.isFinite(g.lat) && Number.isFinite(g.lon);
}

// True when a sample's fix counts as a 3D fix (see the top of this file).
export const isThreeDFix = hasGoodPosition;

// Straight-line distance between two fixes in meters, counting height when
// both have one.
export function distance3dM(a, b) {
  const ground = distanceM(a.lat, a.lon, b.lat, b.lon);
  const dAlt = Number.isFinite(a.altMsl) && Number.isFinite(b.altMsl) ? b.altMsl - a.altMsl : 0;
  return Math.hypot(ground, dAlt);
}

// The packet's sequence number, when it has one.
function seqOf(sample) {
  const seq = sample?.extra?.seq;
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

// Does a crumb pass the quality gate? sample is the sample it came from.
export function passesGate(sample, crumb, cfg = TRACK_DEFAULTS) {
  if (!hasGoodPosition(sample)) return false;
  // A source that sends neither a satellite count nor an HDOP: only the 3D
  // fix part of the gate can apply.
  if (crumb.sats === null && crumb.hdop === null) return true;
  return crumb.sats !== null && crumb.sats >= cfg.MIN_SATS &&
    crumb.hdop !== null && crumb.hdop <= cfg.MAX_HDOP;
}

// Moves `point` toward `anchor` so it is at most maxM away (in meters,
// height included). Used to keep the smoothed line close to its fix.
function clampNear(point, anchor, maxM) {
  const kLon = M_PER_DEG_LAT * Math.cos((anchor.lat * Math.PI) / 180);
  const dN = (point.lat - anchor.lat) * M_PER_DEG_LAT;
  const dE = (point.lon - anchor.lon) * kLon;
  const hasAlt = Number.isFinite(point.altMsl) && Number.isFinite(anchor.altMsl);
  const dU = hasAlt ? point.altMsl - anchor.altMsl : 0;
  const off = Math.hypot(dN, dE, dU);
  if (!(off > maxM)) return point;
  const k = maxM / off;
  return {
    lat: anchor.lat + (dN * k) / M_PER_DEG_LAT,
    lon: kLon > 0 ? anchor.lon + (dE * k) / kLon : anchor.lon,
    altMsl: hasAlt ? anchor.altMsl + dU * k : point.altMsl,
  };
}

// Makes one rocket's trail. overrides replaces any of TRACK_DEFAULTS.
//   trail.crumbs        the crumbs so far, oldest first (the same array every time)
//   trail.push(sample)  looks at one sample, in time order. Returns the new
//                       crumb, or null when the sample had no position.
//   trail.reset()       forgets everything
export function createCrumbTrail(overrides = {}) {
  const cfg = { ...TRACK_DEFAULTS, ...overrides };
  const crumbs = [];
  let lastGood = null;       // the last good crumb
  let lastHeardT = null;     // time of the previous sample that had a GPS group
  let lastSeq = null;        // sequence number of the previous sample that had one
  let lastSeqT = null;       // ...and its time
  let gapSinceCrumb = false; // missed packets or a lost fix since the last crumb
  let gapSinceGood = false;  // ...since the last good crumb
  let run = [];              // the good crumbs since the last break, for smoothing
  let outlierRun = [];       // outliers in a row that agree with each other

  // Did packets go missing between the previous sample and this one?
  // Returns 'missed', 'same' (a repeat of the same packet) or 'ok'.
  function checkSequence(sample, t) {
    const seq = seqOf(sample);
    if (seq === null || lastSeq === null) return 'ok';
    const step = (seq - lastSeq + SEQ_MODULO) % SEQ_MODULO;
    if (step === 0 && Math.abs(t - lastSeqT) < 1e-9) return 'same';
    return step === 1 ? 'ok' : 'missed';
  }

  function push(sample) {
    if (!sample || !Number.isFinite(sample.t)) return null;
    const t = sample.t;
    const seq = seqOf(sample);
    const seqState = checkSequence(sample, t);
    if (seqState === 'same') return null;
    if (seq !== null) { lastSeq = seq; lastSeqT = t; }
    if (seqState === 'missed') { gapSinceCrumb = true; gapSinceGood = true; }
    if (!sample.gps) return null;

    // Without sequence numbers, a long silence between GPS samples is a gap.
    if (seq === null && lastHeardT !== null && t - lastHeardT > cfg.TRACK_GAP_S) {
      gapSinceCrumb = true;
      gapSinceGood = true;
    }
    lastHeardT = t;
    if (!hasPosition(sample)) {
      // GPS with no position: the fix is lost, so the line breaks here.
      gapSinceCrumb = true;
      gapSinceGood = true;
      return null;
    }

    const g = sample.gps;
    const crumb = {
      t,
      lat: g.lat,
      lon: g.lon,
      altMsl: Number.isFinite(g.altMsl) ? g.altMsl : null,
      sats: Number.isFinite(g.sats) ? g.sats : null,
      hdop: Number.isFinite(g.hdop) ? g.hdop : null,
      seq,
      groundSpeedMps: Number.isFinite(g.speed) ? g.speed : null,
      quality: 'good',
      gapBefore: crumbs.length > 0 && gapSinceCrumb,
      speedMps: null,
      line: null,
    };

    if (!passesGate(sample, crumb, cfg)) {
      crumb.quality = 'weak';
    } else if (lastGood && isImpossibleHop(lastGood, crumb)) {
      crumb.quality = 'outlier';
      // Outliers that agree with each other mean the last good fix was the
      // wrong one. Enough of them in a row and the trail starts over there.
      const prevOutlier = outlierRun[outlierRun.length - 1];
      if (prevOutlier && isImpossibleHop(prevOutlier, crumb)) outlierRun = [];
      outlierRun.push(crumb);
      if (outlierRun.length >= cfg.OUTLIER_RESET_FIXES) {
        crumb.quality = 'good';
        lastGood = null;      // nothing to measure a speed from
        gapSinceGood = true;  // and the line starts again here
      }
    }

    if (crumb.quality === 'good') {
      outlierRun = [];
      const dt = lastGood ? t - lastGood.t : null;
      const broken = gapSinceGood || (lastGood !== null && dt > cfg.TRACK_GAP_S);
      crumb.gapBefore = crumbs.length > 0 && broken;
      if (lastGood && dt > 0) {
        const speed = distance3dM(lastGood, crumb) / dt;
        if (!crumb.gapBefore || dt <= cfg.TRACK_SPEED_GAP_MAX_S) crumb.speedMps = speed;
      }
      if (crumb.gapBefore) run = [];
      run.push(crumb);
      if (run.length > cfg.LINE_SMOOTH_FIXES) run.shift();
      const avg = (key) => run.reduce((sum, c) => sum + c[key], 0) / run.length;
      const alts = run.filter((c) => c.altMsl !== null);
      const smoothed = {
        lat: avg('lat'),
        lon: avg('lon'),
        altMsl: alts.length ? alts.reduce((sum, c) => sum + c.altMsl, 0) / alts.length : null,
      };
      crumb.line = clampNear(smoothed, crumb, cfg.LINE_SMOOTH_MAX_M);
      lastGood = crumb;
      gapSinceGood = false;
    }
    gapSinceCrumb = false;
    crumbs.push(crumb);
    return crumb;
  }

  // A hop from fix a to fix b that no real board could make.
  function isImpossibleHop(a, b) {
    const dt = b.t - a.t;
    const hop = distance3dM(a, b);
    if (hop <= cfg.OUTLIER_MIN_JUMP_M) return false;
    return !(dt > 0) || hop / dt > cfg.OUTLIER_MAX_SPEED_MPS;
  }

  function reset() {
    crumbs.length = 0;
    lastGood = null;
    lastHeardT = null;
    lastSeq = null;
    lastSeqT = null;
    gapSinceCrumb = false;
    gapSinceGood = false;
    run = [];
    outlierRun = [];
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
