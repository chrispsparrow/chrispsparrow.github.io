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
// Everything here reads the store and returns plain values. Nothing is
// drawn here, and nothing here changes the store.
//
//   flightState(store, rocket, { connected })
//     -> { state, phase, sinceT }
//        state    'idle' | 'pad' | 'flight' | 'recovery'
//        phase    the detector's phase ('waiting', 'pad', 'ascent', 'descent',
//                 'drogue', 'main', 'landed'), or null with no data
//        sinceT   data time the state began (liftoff for 'flight', the
//                 landing for 'recovery'), or null
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
//
//   groundSpeed(store, rocket)
//     -> { mps, source }: source is 'board' (the receiver's own ground speed,
//        from the packet), 'fixes' (worked out from the last two good fixes)
//        or null (mps is null too)
//
//   eventCrumb(rocket, event)
//     -> the good crumb (see track.js) where a flight event happened, or
//        null when the event fell in a GPS gap
//
// Used by: the HUD, the map and 3D view, main.js and the tests. No DOM.

import * as config from './config.js';
import { rangeAndBearing, compass16Name, formatClock, formatNumber, MISSING } from './geo.js';

export const STATE = Object.freeze({ IDLE: 'idle', PAD: 'pad', FLIGHT: 'flight', RECOVERY: 'recovery' });

export function flightState(store, rocket = store?.getFocused?.() ?? null, { connected = false } = {}) {
  const d = rocket?.derived ?? null;
  if (!rocket || !d || !rocket.samples.length) {
    return { state: connected ? STATE.PAD : STATE.IDLE, phase: null, sinceT: null };
  }
  if (d.events?.landed) return { state: STATE.RECOVERY, phase: d.phase, sinceT: d.events.landed.t };
  if (d.liftoffT !== null) return { state: STATE.FLIGHT, phase: d.phase, sinceT: d.liftoffT };
  return { state: STATE.PAD, phase: d.phase, sinceT: rocket.samples[0].t };
}

// Packets a second over the last PAD_LINK_WINDOW_S of the store's clock.
export function packetRate(store, rocket, windowS = config.PAD_LINK_WINDOW_S) {
  const now = store.getNow();
  if (!rocket || !Number.isFinite(now)) return null;
  const from = now - windowS;
  let n = 0;
  for (let i = rocket.samples.length - 1; i >= 0 && rocket.samples[i].t > from; i--) n += 1;
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
    linkText = silent
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
  const good = (rocket.crumbs ?? []).filter((c) => c.quality === 'good');
  const b = good[good.length - 1];
  const a = good[good.length - 2];
  if (!a || !b || b.gapBefore || !(b.t > a.t)) return { mps: null, source: null };
  const rb = rangeAndBearing(a, b);
  return rb ? { mps: rb.distanceM / (b.t - a.t), source: 'fixes' } : { mps: null, source: null };
}

export function eventCrumb(rocket, event, maxGapS = config.TRACK_GAP_S) {
  if (!rocket || !event || !Number.isFinite(event.t)) return null;
  let best = null;
  for (const c of rocket.crumbs ?? []) {
    if (c.quality !== 'good') continue;
    if (!best || Math.abs(c.t - event.t) < Math.abs(best.t - event.t)) best = c;
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
  if (!rocket || !landed) return null;

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
