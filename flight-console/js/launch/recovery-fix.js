// recovery-fix.js: the words and the bookkeeping behind the launch panel's
// recovery readout (js/launch/launch-panel.js). The readout shows the
// rocket's last good GPS fix, so I can walk to it after it lands. This file
// has no DOM, so the tests can check every line of it.
//
// The words:
//   coordsText(fix)       '44.825278, -73.171727', what COPY COORDINATES
//                         puts on the clipboard (decimal degrees, 6 places)
//   distanceWords(m)      '1,240 M' under 10 km, '12.35 KM' from there
//   rangeWords(rb)        '1,240 M AT 073° ENE' from { distanceM, bearingDeg }
//   measureFrom(station, fix)
//                         { rangeM, bearingDeg } from the ground station to
//                         the fix, both null when either position is missing.
//                         The math is rangeAndBearing() in js/geo.js.
//   ageWords(seconds)     '0:03', '12:45', '2:13:05', then '2 DAYS 3 H'
//   clockWords(ms, nowMs) 'AT 14:02:11' on the computer's clock, and
//                         'ON NOV 17 AT 14:02:11' when it was another day
//   altitudeWords(altMsl) '73.2 M ABOVE SEA LEVEL'
//   heightWords(aglM, estimated)   '12 M' or '12 M, ESTIMATED'
//
// The times:
//   arrivalMs({ t, newestT, newestMs, ageS, nowMs })
//                         when the packet with the store time t arrived, in
//                         ms on the computer's clock. newestMs is when the
//                         rocket's newest packet (store time newestT)
//                         arrived, from the flight feed's lastArrival(). It
//                         keeps a recovered recording's real arrival times,
//                         so t is counted back from there. Without it (the
//                         bench store has no flight feed), t is counted back
//                         from nowMs by its age on the store's clock (ageS).
//   ageSince(ms, nowMs)   seconds from ms to nowMs, never below 0, or null
//
// The state:
//   fixState(view)        whether the fix on screen is current, and why not:
//                         { old, why, headline, detail }. A fix from the test
//                         capture (view.test) says so in its detail line.
//     why 'current'     the newest packet had a good fix
//         'no-fix'      packets still arrive, but the fix is older than staleS
//         'no-packets'  the rocket has gone quiet
//         'reload'      it was saved before the page was reloaded
//         'earlier'     it was heard earlier on this page, and the live
//                       store has no fix now (its data was cleared, or
//                       another board is on the cable)
//
// The saved fix. The newest good fix is kept in the browser's localStorage
// (SAVED_FIX_KEY) as it changes, so it survives a reload, a crash or a
// closed tab. A saved fix is one plain object:
//   { v, lat, lon, altMsl, aglM, aglEstimated, rocketId, rocketName,
//     fixMs, packetMs, groundStation: { lat, lon, typed } | null, test,
//     savedMs }
//   fixMs and packetMs are the computer's clock (ms) when the fix's packet
//   and the newest packet arrived. A board's own clock starts over at every
//   power-up, so it can't say how old a fix is after a reload. test is true
//   for a fix heard while the test capture played (js/launch/capture.js),
//   so a fix from the capture is never mistaken for the rocket's.
//   makeSavedFix(parts)   builds one, or null when the position is unusable
//   readSavedFix(text)    reads one back from storage, or null when the
//                         text is missing, damaged or from another version
//
// Used by: js/launch/launch-panel.js and test/launch-panel.test.mjs.

import { rangeAndBearing, formatBearing, formatClock, formatNumber, MISSING } from '../geo.js?v=3';

// Where the saved fix is kept (localStorage).
export const SAVED_FIX_KEY = 'fc-launch-last-fix';
// The saved fix's format. A record with another number is ignored.
export const SAVED_FIX_VERSION = 1;
// Distances are written in meters up to here, then in kilometers.
const METERS_UP_TO_M = 10000;

const usable = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

export function coordsText(fix) {
  return usable(fix) ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` : '';
}

export function distanceWords(m) {
  if (!Number.isFinite(m)) return MISSING;
  return Math.round(m) < METERS_UP_TO_M ? `${formatNumber(m, 0)} M` : `${formatNumber(m / 1000, 2)} KM`;
}

// The bearing is formatBearing()'s ('073° (ENE)'), without the brackets.
export function rangeWords(rb) {
  if (!rb || !Number.isFinite(rb.distanceM) || !Number.isFinite(rb.bearingDeg)) return MISSING;
  return `${distanceWords(rb.distanceM)} AT ${formatBearing(rb.bearingDeg).replace(/[()]/g, '')}`;
}

export function measureFrom(station, fix) {
  const rb = usable(station) && usable(fix) ? rangeAndBearing(station, fix) : null;
  return { rangeM: rb ? rb.distanceM : null, bearingDeg: rb ? rb.bearingDeg : null };
}

// How long ago, counting like a clock. Past a day the seconds stop mattering.
export function ageWords(seconds) {
  if (!Number.isFinite(seconds)) return MISSING;
  const s = Math.max(0, seconds);
  if (s < 86400) return formatClock(s);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  return `${formatNumber(days, 0)} ${days === 1 ? 'DAY' : 'DAYS'} ${hours} H`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const two = (n) => String(n).padStart(2, '0');

export function clockWords(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return MISSING;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const now = new Date(nowMs);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `AT ${time}` : `ON ${MONTHS[d.getMonth()]} ${d.getDate()} AT ${time}`;
}

export function altitudeWords(altMsl) {
  return Number.isFinite(altMsl) ? `${formatNumber(altMsl, 1)} M ABOVE SEA LEVEL` : MISSING;
}

export function heightWords(aglM, estimated = false) {
  if (!Number.isFinite(aglM)) return MISSING;
  return `${formatNumber(aglM, 0)} M${estimated ? ', ESTIMATED' : ''}`;
}

export function arrivalMs({ t, newestT = null, newestMs = null, ageS = null, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(t)) return null;
  if (Number.isFinite(newestMs)) {
    // A fix from an older packet than the newest arrived that much earlier.
    const before = Number.isFinite(newestT) ? Math.max(0, newestT - t) : 0;
    return newestMs - before * 1000;
  }
  return nowMs - (Number.isFinite(ageS) ? ageS : 0) * 1000;
}

export function ageSince(ms, nowMs = Date.now()) {
  return Number.isFinite(ms) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - ms) / 1000) : null;
}

// view:
//   source     'live' (the store has this fix), 'reload' (read from storage
//              when the page loaded) or 'earlier' (heard on this page, and
//              kept by the panel now that the store has no fix)
//   fixAgeS    the fix's age in seconds
//   silent     the rocket has sent nothing for a while (store.isSilent)
//   fixNow     the newest GPS data had a good fix (store.hasFixNow)
//   staleS     how old a fix can be and still count as current
//   test       the fix came from the test capture, not a flight
export function fixState({ source = 'live', fixAgeS = null, silent = false, fixNow = true, staleS = 5, test = false } = {}) {
  const state = baseFixState({ source, fixAgeS, silent, fixNow, staleS });
  if (test) state.detail = [state.detail, 'This fix came from the test capture.'].filter(Boolean).join(' ');
  return state;
}

function baseFixState({ source, fixAgeS, silent, fixNow, staleS }) {
  const from = `FROM ${ageWords(fixAgeS)} AGO`;
  if (source === 'reload') {
    return { old: true, why: 'reload', headline: `SAVED FIX, ${from}`, detail: 'Saved before the page was reloaded. No newer fix has been heard.' };
  }
  if (source === 'earlier') {
    return { old: true, why: 'earlier', headline: `SAVED FIX, ${from}`, detail: 'Saved earlier on this page. No newer fix has been heard.' };
  }
  if (silent) {
    return { old: true, why: 'no-packets', headline: `OLD FIX, ${from}`, detail: 'Packets from the rocket have stopped.' };
  }
  if (!fixNow || !Number.isFinite(fixAgeS) || fixAgeS > staleS) {
    return { old: true, why: 'no-fix', headline: `OLD FIX, ${from}`, detail: 'Packets still arrive, but without a good GPS fix.' };
  }
  return { old: false, why: 'current', headline: 'CURRENT FIX', detail: '' };
}

const numberOrNull = (v) => (Number.isFinite(v) ? v : null);

export function makeSavedFix({
  fix, rocketId, rocketName = '', fixMs, packetMs, aglM = null, aglEstimated = false, groundStation = null, test = false,
  savedMs = Date.now(),
} = {}) {
  if (!usable(fix) || !Number.isFinite(fixMs)) return null;
  return {
    v: SAVED_FIX_VERSION,
    lat: fix.lat,
    lon: fix.lon,
    altMsl: numberOrNull(fix.altMsl),
    aglM: numberOrNull(aglM),
    aglEstimated: Boolean(aglEstimated),
    rocketId: rocketId === null || rocketId === undefined ? '' : String(rocketId),
    rocketName: String(rocketName ?? ''),
    fixMs,
    // The newest packet is never older than the fix it may have carried.
    packetMs: Number.isFinite(packetMs) ? Math.max(packetMs, fixMs) : fixMs,
    groundStation: usable(groundStation)
      ? { lat: groundStation.lat, lon: groundStation.lon, typed: Boolean(groundStation.typed) }
      : null,
    test: test === true,
    savedMs,
  };
}

export function readSavedFix(text) {
  let raw = null;
  try { raw = typeof text === 'string' ? JSON.parse(text) : null; } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.v !== SAVED_FIX_VERSION) return null;
  return makeSavedFix({
    fix: { lat: raw.lat, lon: raw.lon, altMsl: raw.altMsl },
    rocketId: raw.rocketId,
    rocketName: raw.rocketName,
    fixMs: raw.fixMs,
    packetMs: raw.packetMs,
    aglM: raw.aglM,
    aglEstimated: raw.aglEstimated,
    groundStation: raw.groundStation,
    test: raw.test,
    savedMs: numberOrNull(raw.savedMs) ?? raw.fixMs,
  });
}
