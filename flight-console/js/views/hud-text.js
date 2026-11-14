// hud-text.js
// The words the map and the 3D view use for what they're tracking,
// rocketHudLine(), the short status line the map and the 3D view used to
// draw next to a rocket, and hudAge(), the HUD's short ages ("4 S",
// "2 MIN"). Neither view draws that line any more (the HUD says the same
// things), but the bench feed tests still check the age rules through
// rocketHudLine().
//
// Used by: map-view.js, globe-view.js, hud.js and
// test/bench-feed.test.mjs.

import { formatNumber, MISSING } from '../geo.js';

// What the map and the 3D view call the thing they track, its launch pad
// and its track. The camera checkbox is FOLLOW BOARD everywhere, since a
// Dogtooth board is what sends the positions. FLIGHT_WORDS is the default.
// BENCH_WORDS is for a Dogtooth board on a desk, which isn't flying and
// has no launch pad. There the "pad" is the
// spot where the board first sat still with a GPS fix. whole: null leaves
// the "Whole flight" camera button out. marker names the board marker in
// the KEY, and event names the 3D view's event markers there (a board on
// a desk has no flight events, so its KEY has no row for them).
export const FLIGHT_WORDS = Object.freeze({
  follow: 'Follow board',
  whole: 'Whole flight',
  track: 'Rocket track',
  marker: 'Dogtooth board',
  event: 'Flight event, like apogee or landing',
  pad: 'Launch point',
  mapLabel: 'Map of rocket positions',
  globeLabel: '3D view of the flight',
  noFix: 'No GPS fix yet, so there is no rocket to draw.',
  waiting: 'A rocket shows in 3D once its launch pad and the ground height there are known.',
  noGpsData: 'No GPS data from this rocket',
  noData: 'No data from this rocket yet',
});
export const BENCH_WORDS = Object.freeze({
  follow: 'Follow board',
  whole: null,
  track: 'Board track',
  marker: 'Dogtooth board',
  event: null,
  pad: 'Start point',
  mapLabel: 'Map of the board\'s position',
  globeLabel: '3D view of the board\'s position',
  noFix: 'No GPS fix yet, so the board\'s position isn\'t shown.',
  waiting: 'The board shows in 3D a few seconds after its first GPS fix, once the ground height there is known.',
  noGpsData: 'No GPS data from this board',
  noData: 'No data from this board yet',
});

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
