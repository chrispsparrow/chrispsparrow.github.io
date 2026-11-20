// recovery-fix.js: the words and the bookkeeping behind the launch panel's
// recovery readout (js/launch/launch-panel.js). The readout shows the
// rocket's last good GPS fix, so I can walk to it after it lands. This file
// has no DOM, so the tests can check every line of it.
//
// Which fix:
//   pickFix(crumbs)       picks what the readout shows from a rocket's
//                         crumbs (rocket.crumbs, graded good, weak or
//                         outlier by js/track.js, the grades the trail and
//                         the 3D board marker draw by).
//                         { main, quality, weak, held, newest, skipped,
//                           heldNewest, agree }:
//     main      the newest good fix the readout trusts (see below). With
//               none at all, the newest weak crumb. null with neither.
//     quality   'good' or 'weak', what main is, or null
//     weak      a weak crumb newer than a good main, or null
//     held      a newer fix that the trail took as good but that is too
//               far from main to trust yet, or null. It shows under main
//               as not confirmed, never as the main fix.
//     newest    main is the newest crumb of all
//     skipped   the newest crumb is one the readout leaves out
//     heldNewest  the newest crumb is the held one
//     agree     how many fixes in a row back main, main included, up to
//               CONFIRM_FIXES
//               A position that is not on the Earth is never picked, and
//               neither is one at exactly 0, 0.
//     WHICH FIXES IT TRUSTS. The trail only calls a fix an outlier when no
//     board could have covered the distance in the time (600 m/s). After a
//     few seconds without packets that lets through a position kilometers
//     away, and one bad packet would send me to the wrong field. So the
//     readout has a tighter rule of its own. A fix that passed the quality
//     gate is trusted at once when it is within reach of the last trusted
//     one: reachM(), what a rocket covers over the ground in the time
//     between them. One further away, or one the trail left out, has to be
//     backed first. It takes over when CONFIRM_FIXES fixes in a row agree
//     with each other (the trail's own number). Until then the last trusted
//     fix stays. The first fix that is back within reach of it is trusted
//     at once, whatever the trail made of it, so one bad packet costs one
//     packet and no more.
//   reachM(gapS)          how far (m) a rocket can be from its last fix
//                         after gapS seconds
//   isFar(from, to, gapS) true when `to` is further than that from `from`,
//                         over the ground
//   heightAboveGround(rocket, fix)
//                         the fix's height above the ground level the store
//                         worked out, or null when it has none yet
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
//   qualityWords(fix)     '4 SATS, HDOP 5.20', what makes a fix weak
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
//                         { old, why, headline, detail }. A weak fix in the
//                         main readout (view.quality) and a fix from the
//                         test capture (view.test) say so.
//     why 'current'     the newest packet's fix is the one on screen
//         'no-fix'      packets still arrive, but the fix on screen is not
//                       the newest packet's, or is older than staleS
//         'jump'        packets still arrive, and the newest position was
//                       left out as an impossible jump from this one
//         'far'         packets still arrive, and the newest position is
//                       far from this one and not confirmed yet. It shows
//                       under this one.
//         'no-packets'  the rocket has gone quiet
//         'reload'      it was saved before the page closed or reloaded
//         'earlier'     it was heard earlier on this page, and the live
//                       store has no fix now (its data was cleared, or
//                       another board is on the cable)
//         'tab'         another launch tab on this laptop heard it
//
// The saved fix. The newest fix is written to the browser's localStorage
// (SAVED_FIX_KEY) as it changes, so a reloaded page has it at once. It is
// NOT safe from a crash by itself: Chrome puts localStorage on the disk a
// few seconds after a write, and then about once a minute, so after Chrome
// is killed the copy there can be most of a minute old, or missing. The
// flight recording in IndexedDB is written within a quarter of a second and
// does survive, so after a crash the panel reads the last fix out of it
// with lastFixInLines() and saves that.
// A saved fix is one plain object:
//   { v, lat, lon, altMsl, quality, sats, hdop, aglM, aglEstimated,
//     rocketId, rocketName, fixMs, packetMs,
//     weak: { lat, lon, altMsl, sats, hdop, fixMs } | null,
//     held: { lat, lon, altMsl, sats, hdop, fixMs } | null,
//     groundStation: { lat, lon, typed } | null, test, savedMs }
//   quality is 'good' or 'weak' (the main fix, as pickFix() says). weak is
//   a weak fix newer than a good main one. held is a newer fix that is far
//   from a good main one and not confirmed. A record saved before held
//   existed reads with none. fixMs and packetMs are the
//   computer's clock (ms) when the fix's packet and the newest packet
//   arrived. A board's own clock starts over at every power-up, so it can't
//   say how old a fix is after a reload. test is true for a fix heard while
//   the test capture played (js/launch/capture.js), so a fix from the
//   capture is never mistaken for the rocket's.
//   makeSavedFix(parts)   builds one, or null when the position is unusable
//   readSavedFix(text)    reads one back from storage, or null when the
//                         text is missing, damaged or from a version this
//                         code doesn't know. Version 1 (before weak fixes
//                         were kept) still reads, as a good fix.
//   newerRecord(a, b, marginMs)
//                         true when a has newer news of the rocket than b:
//                         a newer position, or the same one and a newer
//                         packet. With a margin, times closer together
//                         than that count as the same.
//   weakUnderGood(kept, next)
//                         for a record that holds only a weak fix, when a
//                         good fix of the same rocket is kept from up to
//                         GOOD_STAYS_MS before it: the record to keep, the
//                         good fix still the main one and the weak fix under
//                         it. null when that is not the case. So a rocket
//                         that lies in the grass and only sends weak fixes
//                         after a reload or a crash never takes the good
//                         fix off the panel or out of storage.
//   farUnderGood(kept, next, agree)
//                         for a record whose good fix is far from a kept
//                         good fix of the same rocket (isFar(), over the
//                         time between the two) and is backed by fewer than
//                         CONFIRM_FIXES fixes (agree, from pickFix()): the
//                         record to keep, the kept fix still the main one
//                         and the new one under it as held. null when that
//                         is not the case. A new store has nothing to
//                         measure its first fix against, so after a reload
//                         or a crash this is what stops one bad packet from
//                         taking the saved fix's place.
//   keepUnder(kept, next, agree)
//                         weakUnderGood() or farUnderGood(), whichever
//                         applies, or null
//   underFix(view)        which of a view's weak and held fixes shows under
//                         the main one, the newer of the two:
//                         { kind: 'weak' | 'held', fix }, or null. Each has
//                         ms, when it arrived.
//   readOtherFixes(text)  reads the saved fixes of the rockets that are not
//                         on show (SAVED_OTHERS_KEY, a list of saved-fix
//                         records): real ones only, one for each rocket,
//                         the newest first. [] when there are none.
//   lastFixInLines(lines, times, options)
//                         the saved fix for the end of a recording: its
//                         lines go through the page's own parser, flight
//                         feed and store, pickFix() picks from the crumbs,
//                         and each time is the line's own arrival time.
//                         Resolves with a record, or null with no fix.
//
// Used by: js/launch/launch-panel.js and test/launch-panel.test.mjs.

import { OUTLIER_RESET_FIXES } from '../config.js?v=3';
import { rangeAndBearing, distanceM, formatBearing, formatClock, formatNumber, MISSING } from '../geo.js?v=3';
import { createStore } from '../store.js?v=5';
import { createFleet } from '../fleet.js?v=3';
import { createFlightFeed } from '../live/flight-feed.js';
import { createSourceDetector } from '../live/sources.js?v=3';
import { LIVE_STORE_OPTIONS } from '../live/bench-feed.js?v=4';
import { formatDegrees } from './position-input.js';

// Where the saved fix is kept (localStorage).
export const SAVED_FIX_KEY = 'fc-launch-last-fix';
// Where the saved fixes of the other rockets are kept, the ones that are
// not on show: a list of the same records. With two boards on the air, one
// rocket's fix never takes another's out of storage.
export const SAVED_OTHERS_KEY = 'fc-launch-other-fixes';
// How many of those are kept and listed, the newest first.
export const OTHERS_MAX = 3;
// The saved fix's format. Version 2 added quality, sats, hdop and weak.
// held came later and is optional, so the version stayed.
export const SAVED_FIX_VERSION = 2;
// The versions readSavedFix() takes.
const READABLE_VERSIONS = [1, 2];
// Distances are written in meters up to here, then in kilometers.
const METERS_UP_TO_M = 10000;
// lastFixInLines() first plays the end of a recording, this many lines of
// it. The receiver prints two lines a second, so that is about half an hour.
const TAIL_LINES = 4000;
// It hands the page back after this many lines, so nothing freezes while a
// long recording is read.
const PAUSE_EVERY_LINES = 1000;
// How long (ms) a kept good fix stays the main one while only weak fixes
// follow it (weakUnderGood). Six hours covers a flight and the walk to the
// rocket. A good fix older than that is from another day, and a weak fix
// heard now is worth more than it.
export const GOOD_STAYS_MS = 6 * 3600 * 1000;
// How far a fix can be from the last one the readout trusts and still be
// trusted at once (reachM). A rocket under a parachute drifts with the
// wind, 20 m/s on a bad day, and on the way up it covers little ground. So
// 50 m/s over the ground, for the time between the two fixes, is further
// than a real one gets. The floor is for fixes a second apart and for GPS
// noise. The cap is further than a whole descent drifts, so after a long
// silence one packet from the next county still has to be backed.
export const REACH_SPEED_MPS = 50;
export const REACH_FLOOR_M = 300;
export const REACH_MAX_M = 10000;
// How many fixes in a row have to agree before a position out of reach
// takes over. The trail's own number for its outliers.
export const CONFIRM_FIXES = OUTLIER_RESET_FIXES;

const usable = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// ------------------------------------------------------------------
// Which fix
// ------------------------------------------------------------------

// A crumb the readout may show: a real place, and not 0, 0. A receiver
// that has no position yet can still say fix=yes and send zeros, and
// nothing I launch comes down in the Gulf of Guinea.
const showable = (crumb) => usable(crumb) && !(crumb.lat === 0 && crumb.lon === 0);

export function reachM(gapS) {
  const drift = Number.isFinite(gapS) && gapS > 0 ? gapS * REACH_SPEED_MPS : 0;
  return Math.min(REACH_MAX_M, Math.max(REACH_FLOOR_M, drift));
}

// Over the ground only. The readout is a place to walk to, and a rocket on
// the way up gains height much faster than it covers ground.
export function isFar(from, to, gapS) {
  return distanceM(from.lat, from.lon, to.lat, to.lon) > reachM(gapS);
}

// What pickFix() found so far in each trail. A trail only ever grows, and a
// crumb's grade never changes, so each call only looks at the new crumbs.
//   n, last     how many crumbs were looked at, and the last of them
//   good        the newest fix the readout trusts
//   agree       how many fixes in a row back it
//   weak        the newest weak crumb since
//   trailGood   the trail's own last good crumb, the one it measures the
//               next crumb against
//   far, farN   the newest fix that is not trusted yet, and how many of
//               them in a row agree with each other
const picks = new WeakMap();   // the crumbs array -> the above

export function pickFix(crumbs) {
  if (!Array.isArray(crumbs)) {
    return { main: null, quality: null, weak: null, held: null, newest: false, skipped: false, heldNewest: false, agree: 0 };
  }
  let seen = picks.get(crumbs);
  // A trail that was emptied and filled again starts over.
  if (!seen || crumbs.length < seen.n || (seen.n > 0 && crumbs[seen.n - 1] !== seen.last)) {
    seen = { n: 0, last: null, good: null, agree: 0, weak: null, trailGood: null, far: null, farN: 0 };
    picks.set(crumbs, seen);
  }
  for (let i = seen.n; i < crumbs.length; i++) judge(seen, crumbs[i]);
  seen.n = crumbs.length;
  const main = seen.good ?? seen.weak;
  const weak = seen.good ? seen.weak : null;
  // Only a fix the trail itself took is shown as not confirmed. One the
  // trail left out is an impossible jump, and stays left out.
  const held = seen.good && seen.far?.quality === 'good' ? seen.far : null;
  return {
    main,
    quality: seen.good ? 'good' : seen.weak ? 'weak' : null,
    weak,
    held,
    newest: main !== null && seen.last === main,
    skipped: main !== null && seen.last !== main && seen.last !== weak && seen.last !== held,
    heldNewest: held !== null && seen.last === held,
    agree: seen.good ? seen.agree : 0,
  };
}

// Looks at one more crumb of a trail (WHICH FIXES IT TRUSTS, at the top).
function judge(seen, crumb) {
  seen.last = crumb;
  // What the trail measured this crumb against.
  const trailRef = seen.trailGood;
  const byTrail = crumb.quality === 'good';
  if (byTrail) seen.trailGood = crumb;
  if (!showable(crumb)) return;
  if (crumb.quality === 'weak') {
    seen.weak = crumb;
    return;
  }
  // Good and outlier crumbs both passed the quality gate.
  if (!byTrail && crumb.quality !== 'outlier') return;
  const { good } = seen;
  const agrees = seen.far !== null && !isFar(seen.far, crumb, crumb.t - seen.far.t);
  let trusted = false;
  let backing = 1;
  if (!good) {
    // Nothing to measure against yet. The trail's word is all there is.
    trusted = byTrail;
    if (agrees) backing += seen.farN;
  } else if (!isFar(good, crumb, crumb.t - good.t)) {
    // Within reach. The trail's outlier grade only counts when the trail
    // measured against the same fix the readout trusts. When it went with
    // a far position that the readout held back, it calls the true ones
    // that follow outliers, and those are the ones to show.
    trusted = byTrail || trailRef !== good;
    backing += seen.agree;
  }
  if (!trusted) {
    seen.farN = agrees ? seen.farN + 1 : 1;
    seen.far = crumb;
    if (!good || seen.farN < CONFIRM_FIXES) return;
    backing = seen.farN;
  }
  seen.good = crumb;
  seen.agree = Math.min(CONFIRM_FIXES, backing);
  seen.weak = null;   // only a weak fix newer than the good one is kept
  seen.far = null;
  seen.farN = 0;
}

export function heightAboveGround(rocket, fix) {
  const d = rocket?.derived;
  if (!d || d.phase === 'waiting' || !Number.isFinite(d.groundRef) || !Number.isFinite(fix?.altMsl)) return null;
  return fix.altMsl - d.groundRef;
}

// ------------------------------------------------------------------
// The words
// ------------------------------------------------------------------

export function coordsText(fix) {
  return usable(fix) ? `${formatDegrees(fix.lat)}, ${formatDegrees(fix.lon)}` : '';
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

// The satellite count and the HDOP, the two numbers the quality gate in
// js/track.js reads. The HDOP has 2 decimals, as the HUD writes it.
export function qualityWords({ sats = null, hdop = null } = {}) {
  const parts = [];
  if (Number.isFinite(sats)) parts.push(`${formatNumber(sats, 0)} ${sats === 1 ? 'SAT' : 'SATS'}`);
  if (Number.isFinite(hdop)) parts.push(`HDOP ${formatNumber(hdop, 2)}`);
  return parts.length ? parts.join(', ') : MISSING;
}

// ------------------------------------------------------------------
// The times
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// The state
// ------------------------------------------------------------------

const WEAK_NOTE = 'No good fix was heard, only this weak one. It may be off.';
const TEST_NOTE = 'This fix came from the test capture.';

// view:
//   source     'live' (the store has this fix), 'reload' (saved before the
//              page closed or reloaded), 'earlier' (heard on this page, and
//              kept by the panel now that the store has no fix) or 'tab'
//              (saved by another launch tab)
//   fixAgeS    the fix's age in seconds
//   silent     the rocket has sent nothing for a while (store.isSilent)
//   fixNow     the newest GPS data had a fix (store.hasFixNow)
//   staleS     how old a fix can be and still count as current
//   quality    'good', or 'weak' for a weak fix in the main readout
//   newest     the fix is the rocket's newest crumb (pickFix)
//   skipped    the newest crumb was left out as an outlier (pickFix)
//   unfinished true while a real recording that a crash or a closed page
//              left behind waits for RECOVER, false when there is none,
//              null while the browser's storage hasn't said yet. While one
//              waits, no line says that no newer fix has been heard.
//   test       the fix came from the test capture, not a flight
//   weakSince  a saved good fix with a weak fix heard on this page since
//              under it (weakUnderGood). The line then says that only weak
//              fixes have been heard since, not that nothing has.
//   heldNewest the newest crumb is far from this fix and not confirmed, and
//              shows under it (pickFix)
//   farSince   a saved good fix, and a position far from it was heard on
//              this page since and is not confirmed (farUnderGood). With
//              weakSince too, the fix on the lines under it is a weak one.
export function fixState({
  source = 'live', fixAgeS = null, silent = false, fixNow = true, staleS = 5, quality = 'good', newest = true, skipped = false,
  unfinished = null, test = false, weakSince = false, heldNewest = false, farSince = false,
} = {}) {
  const weak = quality === 'weak';
  const state = baseFixState({
    source, fixAgeS, silent, fixNow, staleS, newest, skipped, unfinished, weakSince, heldNewest, farSince, what: weak ? 'WEAK FIX' : 'FIX',
  });
  state.detail = [state.detail, weak ? WEAK_NOTE : '', test ? TEST_NOTE : ''].filter(Boolean).join(' ');
  return state;
}

const FAR_NOTE = 'The newest position is far from this one. It shows below until the next fixes agree with it.';

function baseFixState({ source, fixAgeS, silent, fixNow, staleS, newest, skipped, unfinished, weakSince, heldNewest, farSince, what }) {
  const from = `FROM ${ageWords(fixAgeS)} AGO`;
  const heardSince = weakSince || farSince;
  const since = farSince && weakSince ? 'Only weak fixes, and positions far from this one, have been heard since.'
    : farSince ? FAR_NOTE
      : weakSince ? 'Only weak fixes have been heard since.'
        : 'No newer fix has been heard.';
  if (source === 'reload') {
    // While a recording waits for RECOVER, the page can't know that nothing
    // newer was heard: the recording may hold more than the saved copy.
    const detail = unfinished === true ? 'The page closed suddenly. Press RECOVER to put the flight back on the live view.'
      : unfinished === false || heardSince ? `Saved before the page was reloaded. ${since}`
        : 'Saved before the page was reloaded.';
    return { old: true, why: 'reload', headline: `SAVED ${what}, ${from}`, detail };
  }
  if (source === 'earlier') {
    // This page heard it after it opened, so it is newer than anything in a
    // recording left from before. The second sentence is still left out
    // while one waits, so the panel never says it next to RECOVER.
    const detail = unfinished === true && !heardSince ? 'Saved earlier on this page.' : `Saved earlier on this page. ${since}`;
    return { old: true, why: 'earlier', headline: `SAVED ${what}, ${from}`, detail };
  }
  if (source === 'tab') {
    const detail = heardSince ? `Heard in another launch tab on this laptop. ${since}` : 'Heard in another launch tab on this laptop.';
    return { old: true, why: 'tab', headline: `SAVED ${what}, ${from}`, detail };
  }
  if (silent) {
    return { old: true, why: 'no-packets', headline: `OLD ${what}, ${from}`, detail: 'Packets from the rocket have stopped.' };
  }
  if (skipped) {
    return { old: true, why: 'jump', headline: `OLD ${what}, ${from}`, detail: 'The newest position is too far from this one to be real, so it is left out.' };
  }
  if (heldNewest) {
    return { old: true, why: 'far', headline: `OLD ${what}, ${from}`, detail: FAR_NOTE };
  }
  if (!fixNow || !newest || !Number.isFinite(fixAgeS) || fixAgeS > staleS) {
    return { old: true, why: 'no-fix', headline: `OLD ${what}, ${from}`, detail: 'Packets still arrive, but without a good GPS fix.' };
  }
  return { old: false, why: 'current', headline: `CURRENT ${what}`, detail: '' };
}

// ------------------------------------------------------------------
// The saved fix
// ------------------------------------------------------------------

const numberOrNull = (v) => (Number.isFinite(v) ? v : null);

// The weak fix that goes with a good one, or null when it can't be used.
function savedWeak(weak) {
  if (!usable(weak) || !Number.isFinite(weak.fixMs)) return null;
  return {
    lat: weak.lat,
    lon: weak.lon,
    altMsl: numberOrNull(weak.altMsl),
    sats: numberOrNull(weak.sats),
    hdop: numberOrNull(weak.hdop),
    fixMs: weak.fixMs,
  };
}

// fix is the main fix ({ lat, lon, altMsl, sats, hdop }, a crumb will do)
// and quality what it is. weak is a newer weak fix with its own fixMs, and
// held a newer fix that is not confirmed, with its own.
export function makeSavedFix({
  fix, quality = 'good', weak = null, held = null, rocketId, rocketName = '', fixMs, packetMs, aglM = null, aglEstimated = false,
  groundStation = null, test = false, savedMs = Date.now(),
} = {}) {
  if (!usable(fix) || !Number.isFinite(fixMs)) return null;
  const mainIsWeak = quality === 'weak';
  // A weak fix only goes with a good one, and only when it is the newer.
  // The same holds for a fix that is not confirmed.
  const under = (other) => {
    const newer = mainIsWeak ? null : savedWeak(other);
    return newer && newer.fixMs >= fixMs ? newer : null;
  };
  const keptWeak = under(weak);
  const keptHeld = under(held);
  const newestFixMs = Math.max(fixMs, keptWeak?.fixMs ?? -Infinity, keptHeld?.fixMs ?? -Infinity);
  return {
    v: SAVED_FIX_VERSION,
    lat: fix.lat,
    lon: fix.lon,
    altMsl: numberOrNull(fix.altMsl),
    quality: mainIsWeak ? 'weak' : 'good',
    sats: numberOrNull(fix.sats),
    hdop: numberOrNull(fix.hdop),
    aglM: numberOrNull(aglM),
    aglEstimated: Boolean(aglEstimated),
    rocketId: rocketId === null || rocketId === undefined ? '' : String(rocketId),
    rocketName: String(rocketName ?? ''),
    fixMs,
    // The newest packet is never older than a fix it may have carried.
    packetMs: Number.isFinite(packetMs) ? Math.max(packetMs, newestFixMs) : newestFixMs,
    weak: keptWeak,
    held: keptHeld,
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
  if (!raw || typeof raw !== 'object' || !READABLE_VERSIONS.includes(raw.v)) return null;
  return makeSavedFix({
    fix: { lat: raw.lat, lon: raw.lon, altMsl: raw.altMsl, sats: raw.sats, hdop: raw.hdop },
    quality: raw.quality === 'weak' ? 'weak' : 'good',
    weak: raw.weak && typeof raw.weak === 'object' ? raw.weak : null,
    held: raw.held && typeof raw.held === 'object' ? raw.held : null,
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

export function readOtherFixes(text) {
  let raw = null;
  try { raw = typeof text === 'string' ? JSON.parse(text) : null; } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const byRocket = new Map();
  for (const item of raw) {
    const record = item && typeof item === 'object' ? readSavedFix(JSON.stringify(item)) : null;
    // A fix from the test capture is never kept for later.
    if (!record || record.test) continue;
    if (newerRecord(record, byRocket.get(record.rocketId) ?? null)) byRocket.set(record.rocketId, record);
  }
  return [...byRocket.values()].sort((a, b) => newestFixMs(b) - newestFixMs(a)).slice(0, OTHERS_MAX);
}

// When a record's newest position arrived: good, weak or not confirmed.
function newestFixMs(record) {
  return Math.max(record.fixMs, record.weak?.fixMs ?? -Infinity, record.held?.fixMs ?? -Infinity);
}

export function newerRecord(a, b, marginMs = 0) {
  if (!a) return false;
  if (!b) return true;
  const fixA = newestFixMs(a);
  const fixB = newestFixMs(b);
  if (Math.abs(fixA - fixB) > marginMs) return fixA > fixB;
  return a.packetMs - b.packetMs > marginMs;
}

export function weakUnderGood(kept, next) {
  if (!kept || !next || kept.quality !== 'good' || next.quality !== 'weak') return null;
  if (kept.rocketId !== next.rocketId || kept.test !== next.test) return null;
  // The weak fix has to be the newer one, and from the same day's flying.
  const later = next.fixMs - kept.fixMs;
  if (!(later >= 0 && later <= GOOD_STAYS_MS)) return null;
  return makeSavedFix({
    fix: { lat: kept.lat, lon: kept.lon, altMsl: kept.altMsl, sats: kept.sats, hdop: kept.hdop },
    quality: 'good',
    weak: { lat: next.lat, lon: next.lon, altMsl: next.altMsl, sats: next.sats, hdop: next.hdop, fixMs: next.fixMs },
    rocketId: kept.rocketId,
    rocketName: kept.rocketName || next.rocketName,
    fixMs: kept.fixMs,
    packetMs: Math.max(kept.packetMs, next.packetMs),
    aglM: kept.aglM,
    aglEstimated: kept.aglEstimated,
    groundStation: next.groundStation ?? kept.groundStation,
    test: kept.test,
    savedMs: next.savedMs,
  });
}

const fixOf = (record) => ({ lat: record.lat, lon: record.lon, altMsl: record.altMsl, sats: record.sats, hdop: record.hdop });

export function farUnderGood(kept, next, agree) {
  if (!kept || !next || kept.quality !== 'good' || next.quality !== 'good') return null;
  if (kept.rocketId !== next.rocketId || kept.test !== next.test) return null;
  // The new fix has to be the newer one, and from the same day's flying.
  const later = next.fixMs - kept.fixMs;
  if (!(later >= 0 && later <= GOOD_STAYS_MS)) return null;
  if (agree >= CONFIRM_FIXES || !isFar(kept, next, later / 1000)) return null;
  return makeSavedFix({
    fix: fixOf(kept),
    quality: 'good',
    // The newest fix the store has that is not confirmed, and its weak fix.
    held: next.held ?? { ...fixOf(next), fixMs: next.fixMs },
    weak: next.weak ?? kept.weak,
    rocketId: kept.rocketId,
    rocketName: kept.rocketName || next.rocketName,
    fixMs: kept.fixMs,
    packetMs: Math.max(kept.packetMs, next.packetMs),
    aglM: kept.aglM,
    aglEstimated: kept.aglEstimated,
    groundStation: next.groundStation ?? kept.groundStation,
    test: kept.test,
    savedMs: next.savedMs,
  });
}

export function keepUnder(kept, next, agree) {
  return weakUnderGood(kept, next) ?? farUnderGood(kept, next, agree);
}

export function underFix(view) {
  const weak = view?.weak ?? null;
  const held = view?.held ?? null;
  if (weak && held) return held.ms >= weak.ms ? { kind: 'held', fix: held } : { kind: 'weak', fix: weak };
  if (held) return { kind: 'held', fix: held };
  return weak ? { kind: 'weak', fix: weak } : null;
}

// The saved fix for the end of a recording (see the top of this file).
//   lines, times   the recording's lines and when each arrived (ms), as
//                  js/local/flight-db.js gives them
//   options:
//     storeOptions   for the scratch store, on top of the live flight
//                    store's own (the launch page passes its ground station
//                    and detector settings, so the height above ground
//                    comes out as it would live)
//     prefer         the rocket ID to read when the recording has several.
//                    Without it, or when that rocket has no fix, the first
//                    rocket heard that has one.
//     missingMs      the time for lines before the first one that has a time
//     groundStation  kept in the record, like the panel's own
//     pause          () -> promise, awaited every PAUSE_EVERY_LINES lines
//     tailLines      how much of the end to play first (for the tests)
// It plays the end of the recording first. A good fix there is the answer.
// With only a weak fix there, or none, it plays four times as much, and so
// on back to the start, so a good fix from before a long weak stretch is
// still found and the weak one is kept next to it.
export async function lastFixInLines(lines, times = null, {
  storeOptions = {}, prefer = null, missingMs = null, groundStation = null, pause = null, tailLines = TAIL_LINES,
} = {}) {
  const total = Array.isArray(lines) ? lines.length : 0;
  if (!total) return null;
  let span = Math.max(1, Math.min(total, Math.floor(tailLines) || TAIL_LINES));
  for (;;) {
    const found = await playTail(lines, times, total - span, { storeOptions, prefer, missingMs, groundStation, pause });
    if (found?.quality === 'good' || span >= total) return found;
    span = Math.min(total, span * 4);
  }
}

// Plays lines[start...] through a scratch copy of the live path: the source
// detector, the source's parser, the flight feed and a store. Nothing on
// the page sees it. Only a flight source (the receiver) has a parser. A
// Dogtooth board's own USB output has none, so it gives no fix here.
async function playTail(lines, times, start, { storeOptions, prefer, missingMs, groundStation, pause }) {
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight, ...storeOptions });
  const feed = createFlightFeed({ store, every: null });
  const detector = createSourceDetector();
  const arrived = new Map();   // crumb -> when its line arrived (ms)
  let ms = Number.isFinite(missingMs) ? missingMs : null;
  for (let i = start; i < lines.length; i++) {
    if (pause && i > start && (i - start) % PAUSE_EVERY_LINES === 0) await pause();
    const line = lines[i];
    if (Number.isFinite(times?.[i])) ms = times[i];
    const source = detector.push(line);
    // A line with no time at all can't say how old its fix is.
    if (source?.mode !== 'flight' || typeof source.parse !== 'function' || ms === null) continue;
    let result = null;
    try {
      feed.noteLine(line);
      result = source.parse(line);
    } catch {
      continue;   // a line the parser can't handle, as on the live page
    }
    if (!feed.push(result, ms)) continue;
    const crumbs = store.getRocket(result.sample?.rocketId)?.crumbs ?? [];
    const crumb = crumbs[crumbs.length - 1];
    if (crumb && !arrived.has(crumb)) arrived.set(crumb, ms);
  }
  const withFix = store.getRockets().map((rocket) => ({ rocket, pick: pickFix(rocket.crumbs) })).filter((r) => r.pick.main);
  const chosen = withFix.find((r) => prefer !== null && String(r.rocket.id) === String(prefer)) ?? withFix[0] ?? null;
  if (!chosen) return null;
  const { rocket, pick } = chosen;
  return makeSavedFix({
    fix: pick.main,
    quality: pick.quality,
    weak: pick.weak ? { ...pick.weak, fixMs: arrived.get(pick.weak) } : null,
    held: pick.held ? { ...pick.held, fixMs: arrived.get(pick.held) } : null,
    rocketId: rocket.id,
    rocketName: rocket.profile?.name ?? '',
    fixMs: arrived.get(pick.main),
    packetMs: feed.lastArrival(rocket.id),
    aglM: heightAboveGround(rocket, pick.main),
    aglEstimated: rocket.derived?.groundEstimated === true,
    groundStation,
    test: false,
  });
}
