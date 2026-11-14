// hud-text.js
// A small text helper for the HUD: hudAge() writes its short ages ("4 S",
// "2 MIN"), as in "PKT 4 S AGO" and "LAST READING 2 S AGO".
//
// Used by: hud.js, and test/bench-feed.test.mjs (which checks the ages the
// HUD would show for a board that goes quiet).

import { MISSING } from '../geo.js';

// How old something is, in whole seconds, or minutes once it is long.
export function hudAge(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.round(seconds);
  if (s < 60) return `${s} S`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} MIN` : `${Math.floor(m / 60)} H`;
}
