// hud-text.js
// Two small text helpers for the HUD.
//   hudAge()         the HUD's short ages ("4 S", "2 MIN"). hud.js uses it.
//   rocketHudLine()  the short status line the map and the 3D view used to
//                    draw next to a rocket. No view draws it now (the HUD
//                    says the same things), but the bench feed tests still
//                    check the age rules through it.
//
// Used by: hud.js and test/bench-feed.test.mjs.

import { formatNumber, MISSING } from '../geo.js';

// The old second line of a rocket's label: height above ground and vertical
// speed, each after its field code, or why its position is old and for
// how long: since the last packet of any kind, the last GPS data, or the
// last good fix, so it agrees with the readings panel.
// Returns { altKey, alt, speed, warn }. warn is true when the line says the
// position is old (the label then turns amber).
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
    return { altKey: '', alt: `${why}, ${hudAge(store.ageOf(since))}`, speed: '', warn: true };
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
