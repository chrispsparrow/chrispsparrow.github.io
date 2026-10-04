// hud-text.js
// The words on a rocket's green label, shared by the map and the 3D view so
// both always say the same thing.
//
// Used by: map-view.js and globe-view.js.

import { formatNumber, MISSING } from '../geo.js';

// The second line of a rocket's label: height above ground and vertical
// speed, each after its field code, or why its position is old and for
// how long: since the last packet of any kind, the last GPS data, or the
// last good fix, so it agrees with the readings panel.
// Returns { altKey, alt, speed, warn }. warn is true when the line says the
// position is old (the label then turns coral).
export function rocketHudLine(store, config, rocket) {
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
export function hudAge(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.round(seconds);
  if (s < 60) return `${s} S`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} MIN` : `${Math.floor(m / 60)} H`;
}
