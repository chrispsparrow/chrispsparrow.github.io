// flight-state.js
// What Track a Rocket should show right now, worked out from the data
// alone. There are no buttons to switch between these. The console has
// four states:
//
//   idle      nothing connected or loaded: the globe
//   pad       data is coming in (or a board is connected) and there is no
//             liftoff yet: the checklist
//   flight    liftoff detected: the full HUD, the camera follows the board
//   recovery  landed: where it is and how to get there
//
// The states follow the detector (detector.js), so they are as hard to
// fool as it is: a board on a desk that wanders tens of meters never
// leaves 'pad'. Going quiet doesn't change the state either. A board
// that stops sending in flight stays in 'flight' (the HUD marks the
// packets as old), and one that landed stays in 'recovery', so the
// recovery position is still there after the ground station is
// unplugged. A replay that seeks backward resets the store and feeds it
// again, so the state simply follows the data to the new time. So does a
// board restart (the live feed resets the store).
//
// Everything here reads the store and returns plain values. Nothing is
// drawn here, and nothing here changes the store.
//
//   flightState(store, rocket, { connected })
//     -> { state, phase, sinceT, silent, startedInFlight }
//        state    'idle' | 'pad' | 'flight' | 'recovery'
//        phase    the detector's phase ('waiting', 'pad', 'ascent', 'descent',
//                 'drogue', 'main', 'landed'), or null with no data
//        sinceT   data time the state began (the first sample for 'pad',
//                 liftoff for 'flight', the touchdown for 'recovery'), or null
//        silent   true when the rocket has sent nothing for LINK_STALE_S
//        startedInFlight  true when the data began with the rocket already
//                 flying (liftoff wasn't seen, T+0 is the first reading)
//     connected: true while a live link is open, so a board that is plugged
//     in but hasn't sent anything yet already counts as 'pad'.
//
//   padChecklist(store, rocket)
//     -> { gps, hdop, link, status }, each { ok, text }
//        gps      GPS LOCK   '12 SAT' with a good fix, 'NO FIX' or 'NO FIX, 4 SAT' without
//        hdop     HDOP       '1.45', or '--'
//        link     LINK       '1 PKT/S', or 'NO PACKETS, 12 S' when they stopped
//        status   STATUS     'READY' when the three above are ok, else 'HOLD'
//     ok false means the line is drawn in amber. Thresholds: PAD_READY_* in config.js.
//
//   recoveryInfo(store, rocket)
//     -> null until the landing is detected, then {
//          position      { lat, lon }: the average of the fixes in the landing
//                        window, never the last fix on its own
//          fixCount      how many fixes went into it
//          lastFixT      data time of the newest good fix
//          lastFixAgeS   its age on the store's clock, in seconds
//          from          'manta' (the ground station's position), 'launch'
//                        (the launch point, when there is no ground station)
//                        or null (neither is known)
//          distanceM     from that point to the recovery position, or null
//          bearingDeg    the same, in degrees from true north, or null
//          text          the HUD's words, ready to show:
//                        { lastFix: '0:12 AGO', distance: '840 M FROM MANTA', bearing: '062° (ENE)' }
//          coordsText    '-8.537473, 119.572459' for COPY COORDINATES
//          mapsUrl       Google Maps at the recovery position, for OPEN IN MAPS
//        }
//        position is null (and the texts '--') when no GPS fix came in the
//        landing window, for example a barometer rocket whose GPS was out.
//
//   groundSpeed(store, rocket)
//     -> { mps, source }: source is 'board' (the receiver's own ground speed,
//        from the packet), 'fixes' (worked out from the last few good fixes)
//        or null (mps is null too)
//
//   eventCrumb(rocket, event)
//     -> the good crumb (see track.js) where a flight event happened, or
//        null when the event fell in a GPS gap
//
//   packetRate(store, rocket)  packets a second over the last PAD_LINK_WINDOW_S
//   formatBearing3(deg)        '062° (ENE)'
//   formatDistanceCaps(m)      '840 M' or '1.24 KM'
//
// Used by: the HUD, the map and 3D view, main.js and the tests. No DOM.

import * as config from './config.js?v=2';
import { rangeAndBearing, compass16Name, formatClock, formatNumber, MISSING } from './geo.js?v=2';

export const STATE = Object.freeze({ IDLE: 'idle', PAD: 'pad', FLIGHT: 'flight', RECOVERY: 'recovery' });

export function flightState(store, rocket = store?.getFocused?.() ?? null, { connected = false } = {}) {
  const d = rocket?.derived ?? null;
  if (!store || !rocket || !d || !rocket.samples?.length) {
    return { state: connected ? STATE.PAD : STATE.IDLE, phase: null, sinceT: null, silent: false, startedInFlight: false };
  }
  const silent = store.isSilent(rocket);
  const startedInFlight = d.startedInFlight === true;
  if (d.events?.landed) return { state: STATE.RECOVERY, phase: d.phase, sinceT: d.events.landed.t, silent, startedInFlight };
  if (d.liftoffT !== null) return { state: STATE.FLIGHT, phase: d.phase, sinceT: d.liftoffT, silent, startedInFlight };
  return { state: STATE.PAD, phase: d.phase, sinceT: rocket.samples[0].t, silent, startedInFlight };
}

// Packets a second over the last PAD_LINK_WINDOW_S of the store's clock.
// Near the start it divides by the time since the first packet (at least
// 1 s) instead, so a board that just started doesn't look slow. null with
// no clock or no rocket.
export function packetRate(store, rocket, windowS = config.PAD_LINK_WINDOW_S) {
  const now = store?.getNow?.();
  if (!rocket || !Number.isFinite(now)) return null;
  const from = now - windowS;
  let n = 0;
  for (let i = rocket.samples.length - 1; i >= 0 && rocket.samples[i].t > from; i--) {
    if (rocket.samples[i].t <= now) n += 1;
  }
  const first = rocket.samples[0]?.t;
  const span = Number.isFinite(first) ? Math.min(windowS, Math.max(1, now - first)) : windowS;
  return n / span;
}

export function padChecklist(store, rocket = store?.getFocused?.() ?? null) {
  const gpsNow = rocket?.latestByGroup?.gps?.values ?? null;
  const fixNow = Boolean(rocket) && store.hasFixNow(rocket);
  const sats = Number.isFinite(gpsNow?.sats) ? gpsNow.sats : null;
  const hdop = Number.isFinite(gpsNow?.hdop) ? gpsNow.hdop : null;
  const silent = Boolean(rocket) && store.isSilent(rocket);
  const rate = rocket ? packetRate(store, rocket) : null;

  const gps = {
    ok: fixNow && sats !== null && sats >= config.PAD_READY_MIN_SATS,
    text: fixNow
      ? (sats !== null ? `${formatNumber(sats, 0)} SAT` : 'LOCKED')
      : (sats !== null && !silent ? `NO FIX, ${formatNumber(sats, 0)} SAT` : 'NO FIX'),
  };
  const hdopLine = {
    ok: fixNow && hdop !== null && hdop <= config.PAD_READY_MAX_HDOP,
    text: hdop !== null && !silent ? formatNumber(hdop, 2) : MISSING,
  };
  let linkText = MISSING;
  if (rocket && Number.isFinite(rocket.lastPacketT)) {
    linkText = silent || rate === null
      ? `NO PACKETS, ${formatNumber(store.ageOf(rocket.lastPacketT), 0)} S`
      : `${formatNumber(rate, rate >= 0.95 || rate === 0 ? 0 : 1)} PKT/S`;
  }
  const link = { ok: !silent && rate !== null && rate >= config.PAD_READY_MIN_PKT_PER_S, text: linkText };
  const ready = gps.ok && hdopLine.ok && link.ok;
  return { gps, hdop: hdopLine, link, status: { ok: ready, text: ready ? 'READY' : 'HOLD' } };
}

export function groundSpeed(store, rocket = store?.getFocused?.() ?? null) {
  if (!rocket || !store.hasFixNow(rocket)) return { mps: null, source: null };
  const fix = rocket.lastGoodFix;
  if (fix && Number.isFinite(fix.speed)) return { mps: fix.speed, source: 'board' };
  // No speed from the receiver (a USB status block has none): the
  // horizontal distance over the last few good fixes in one unbroken run,
  // so the jitter of a single fix doesn't swing it as much.
  const crumbs = rocket.crumbs ?? [];
  const run = [];
  for (let i = crumbs.length - 1; i >= 0 && run.length <= config.LINE_SMOOTH_FIXES; i--) {
    const c = crumbs[i];
    if (c.quality !== 'good') continue;
    run.push(c);
    if (c.gapBefore) break;
  }
  const b = run[0];
  const a = run[run.length - 1];
  if (!a || !b || a === b || !(b.t > a.t)) return { mps: null, source: null };
  const rb = rangeAndBearing(a, b);
  return rb ? { mps: rb.distanceM / (b.t - a.t), source: 'fixes' } : { mps: null, source: null };
}

// The good crumb nearest in time to an event, if one is within maxGapS.
// Crumbs are in time order, so this is a binary search.
export function eventCrumb(rocket, event, maxGapS = config.TRACK_GAP_S) {
  if (!rocket || !event || !Number.isFinite(event.t)) return null;
  const crumbs = rocket.crumbs ?? [];
  let lo = 0;
  let hi = crumbs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (crumbs[mid].t < event.t) lo = mid + 1; else hi = mid;
  }
  // The nearest good crumb on each side of that spot.
  let best = null;
  for (let i = lo; i < crumbs.length; i++) {
    if (crumbs[i].quality === 'good') { best = crumbs[i]; break; }
  }
  for (let i = lo - 1; i >= 0; i--) {
    if (crumbs[i].quality === 'good') {
      if (!best || Math.abs(crumbs[i].t - event.t) < Math.abs(best.t - event.t)) best = crumbs[i];
      break;
    }
  }
  return best && Math.abs(best.t - event.t) <= maxGapS ? best : null;
}

// "062° (ENE)": three digits and a 16-point compass name.
export function formatBearing3(deg) {
  if (!Number.isFinite(deg)) return MISSING;
  const whole = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(whole).padStart(3, '0')}° (${compass16Name(whole)})`;
}

// "840 M" under 1 km, "1.24 KM" from there.
export function formatDistanceCaps(m) {
  if (!Number.isFinite(m)) return MISSING;
  return Math.round(m) < 1000 ? `${formatNumber(m, 0)} M` : `${formatNumber(m / 1000, 2)} KM`;
}

export function recoveryInfo(store, rocket = store?.getFocused?.() ?? null) {
  const d = rocket?.derived ?? null;
  const landed = d?.events?.landed ?? null;
  if (!store || !rocket || !landed) return null;

  // The detector's own landing position (the average over its landing
  // window) when it has one. Otherwise the average of the good fixes from
  // the landing until it was confirmed.
  let position = null;
  let fixCount = 0;
  if (d.landing && Number.isFinite(d.landing.lat) && Number.isFinite(d.landing.lon)) {
    position = { lat: d.landing.lat, lon: d.landing.lon };
    fixCount = d.landing.fixCount ?? 0;
  } else {
    const fixes = (rocket.crumbs ?? []).filter((c) => c.quality === 'good' && c.t >= landed.t - 1e-6 && c.t <= landed.confirmedT + 1e-6);
    if (fixes.length) {
      position = {
        lat: fixes.reduce((sum, c) => sum + c.lat, 0) / fixes.length,
        lon: fixes.reduce((sum, c) => sum + c.lon, 0) / fixes.length,
      };
      fixCount = fixes.length;
    }
  }

  const lastFixT = rocket.lastGoodFix?.t ?? null;
  const lastFixAgeS = store.ageOf(lastFixT);
  // Distance and bearing from Manta when the store has a ground station,
  // from the launch point when it doesn't (data that started in flight
  // has neither).
  const gs = store.getGroundStation();
  const origin = gs ?? rocket.padPosition ?? null;
  const from = !position || !origin ? null : gs ? 'manta' : 'launch';
  const rb = from ? rangeAndBearing(origin, position) : null;
  const fromWords = from === 'manta' ? 'FROM MANTA' : 'FROM LAUNCH POINT';

  return {
    position,
    fixCount,
    lastFixT,
    lastFixAgeS,
    from,
    distanceM: rb ? rb.distanceM : null,
    bearingDeg: rb ? rb.bearingDeg : null,
    text: {
      lastFix: Number.isFinite(lastFixAgeS) ? `${formatClock(lastFixAgeS)} AGO` : MISSING,
      distance: rb ? `${formatDistanceCaps(rb.distanceM)} ${fromWords}` : MISSING,
      bearing: rb ? formatBearing3(rb.bearingDeg) : MISSING,
    },
    coordsText: position ? `${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}` : '',
    mapsUrl: position ? `https://www.google.com/maps/search/?api=1&query=${position.lat.toFixed(6)},${position.lon.toFixed(6)}` : '',
  };
}
