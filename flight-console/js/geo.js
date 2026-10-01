// geo.js
// Distance and direction between two GPS positions, compass names, and the
// small formatting helpers every view uses for numbers, times and units.
// Used by: store.js, the views, and tools/add_flight.mjs. No DOM.

import { FEET_PER_METER } from './config.js';

// Mean radius of the Earth in meters (the same value the firmware's
// simulator uses).
const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Great-circle distance in meters (the haversine formula).
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial bearing from point 1 to point 2, in degrees clockwise from true
// north (0 to 360).
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// The point reached by going distanceM meters from a start point on a
// bearing. Used to place the demo ground station.
export function destinationPoint(lat, lon, bearing, distance) {
  const d = distance / EARTH_RADIUS_M;
  const b = toRad(bearing);
  const lat1 = toRad(lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = toRad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

// Eight compass directions: 58 degrees is "NE".
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassName(deg) {
  if (!Number.isFinite(deg)) return '';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// Distance and bearing between two {lat, lon} points, or null if either is
// missing.
export function rangeAndBearing(from, to) {
  if (!from || !to || ![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) return null;
  return {
    distanceM: distanceM(from.lat, from.lon, to.lat, to.lon),
    bearingDeg: bearingDeg(from.lat, from.lon, to.lat, to.lon),
  };
}

// ------------------------------------------------------------------
// Formatting. Every function returns "--" for a missing value, never 0.
// ------------------------------------------------------------------

export const MISSING = '--';

// 3000 -> "3,000". decimals sets the digits after the point.
export function formatNumber(value, decimals = 0) {
  if (!Number.isFinite(value)) return MISSING;
  // Round first, then turn -0 into 0, so -0.3 shows as "0", not "-0".
  let rounded = Number(value.toFixed(decimals));
  if (rounded === 0) rounded = 0;
  return rounded.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Rounded to the nearest 10 m, as event messages use: 2994 -> "2,990".
export function formatRounded10(value) {
  if (!Number.isFinite(value)) return MISSING;
  return formatNumber(Math.round(value / 10) * 10 + 0, 0);
}

// Meters to feet.
export function metersToFeet(m) {
  return Number.isFinite(m) ? m * FEET_PER_METER : null;
}

// "850 m" under 1 km, "1.24 km" from 1 km up.
export function formatDistance(m) {
  if (!Number.isFinite(m)) return MISSING;
  if (Math.round(m) < 1000) return `${formatNumber(m, 0)} m`;
  return `${formatNumber(m / 1000, 2)} km`;
}

// "58° (NE)"
export function formatBearing(deg) {
  if (!Number.isFinite(deg)) return MISSING;
  const whole = Math.round(deg) % 360;
  return `${whole}° (${compassName(whole)})`;
}

// "1.24 km, bearing 58° (NE)"
export function formatRangeBearing(rb) {
  if (!rb) return MISSING;
  return `${formatDistance(rb.distanceM)}, bearing ${formatBearing(rb.bearingDeg)}`;
}

// Whole seconds as "m:ss", for example 83 -> "1:23". Hours when needed.
export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  // The tiny extra keeps 17.999999999999996 (38.3 - 20.3 in floating point)
  // counting as 18, the same as formatFlightSeconds.
  const s = Math.max(0, Math.floor(seconds + 1e-9));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Flight time as "T+1:23". Negative flight time (before liftoff) gives "T-0:05".
export function formatFlightClock(flightT) {
  if (!Number.isFinite(flightT)) return MISSING;
  return flightT < 0 ? `T-${formatClock(-flightT + 0.999)}` : `T+${formatClock(flightT)}`;
}

// Short flight time for event messages: "T+25 s". Whole seconds are
// counted like a clock (rounded down), so a message always agrees with the
// T+ time shown next to it in the log.
export function formatFlightSeconds(flightT) {
  if (!Number.isFinite(flightT)) return MISSING;
  const whole = Math.floor(flightT + 1e-9);
  return whole < 0 ? `T-${-whole} s` : `T+${whole} s`;
}

// How long ago something happened: "4 s ago", "2 min 5 s ago".
export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

// A duration: "3 min 5 s", "45 s".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}
