// hud-text.js
// Small helpers for the HUD with no DOM, so the tests can check them:
// hudAge() writes its short ages ("4 S", "2 MIN"), as in "PKT 4 S AGO" and
// "LAST READING 2 S AGO", and gpsLineWarn() says when the GPS line is amber.
//
// Used by: hud.js, test/bench-feed.test.mjs (which checks the ages the HUD
// would show for a board that goes quiet) and test/flight-state.test.mjs.

import { MISSING } from '../geo.js?v=3';

// How old something is, in whole seconds, or minutes once it is long.
export function hudAge(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.round(seconds);
  if (s < 60) return `${s} S`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} MIN` : `${Math.floor(m / 60)} H`;
}

// The GPS line ("4 SAT FIX") is amber with no fix, or with fewer
// satellites than minSats (config.MIN_SATS, half of the map's quality
// gate). sats is null when the count isn't known or isn't current, and
// then only the fix counts.
export function gpsLineWarn(fixNow, sats, minSats) {
  return !fixNow || (Number.isFinite(sats) && sats < minSats);
}
