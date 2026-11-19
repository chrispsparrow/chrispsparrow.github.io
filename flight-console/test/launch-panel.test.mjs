// Tests for the launch panel's logic (js/launch/launch-panel.js): reading a
// ground station position typed in at the field (js/launch/position-input.js),
// the recovery readout's words and its saved fix (js/launch/recovery-fix.js),
// the store's setGroundStation() (js/store.js), and what the HUD calls the
// ground station on the launch page (stationName() in js/flight-state.js).
// The last part of the file feeds the receiver capture through the same
// parser, feed and store the page uses, and checks the readout's numbers
// against the capture's own last line.
// Run with: node --test "flight-console/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePosition, readPair, formatDegrees } from '../js/launch/position-input.js';
import {
  SAVED_FIX_KEY, SAVED_FIX_VERSION, coordsText, distanceWords, rangeWords, measureFrom, ageWords, clockWords,
  altitudeWords, heightWords, fixState, makeSavedFix, readSavedFix, arrivalMs, ageSince,
} from '../js/launch/recovery-fix.js';
import { validPosition, launchGroundStation, hub } from '../js/launch/launch-mode.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { createStoreSwitch } from '../js/store-switch.js';
import { recoveryInfo, rangeReading, stationName, mapsUrl } from '../js/flight-state.js';
import { destinationPoint, distanceM, bearingDeg } from '../js/geo.js';
import { createSourceDetector } from '../js/live/sources.js';
import { createFlightFeed } from '../js/live/flight-feed.js';
import { LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { makeSample } from './synthetic.mjs';
import * as config from '../js/config.js';

const FIELD = { lat: 44.825278, lon: -73.171727 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------
// Typed positions
// ------------------------------------------------------------------

test('a value in each box: decimal degrees, with or without a sign', () => {
  assert.deepEqual(parsePosition('44.825278', '-73.171727'), { ok: true, lat: 44.825278, lon: -73.171727 });
  assert.deepEqual(parsePosition('  44.825278 ', '\t-73.171727\n'), { ok: true, lat: 44.825278, lon: -73.171727 });
  assert.deepEqual(parsePosition('+44.5', '73'), { ok: true, lat: 44.5, lon: 73 });
  assert.deepEqual(parsePosition('-8.537473', '119.572459'), { ok: true, lat: -8.537473, lon: 119.572459 });
  assert.deepEqual(parsePosition('0', '0'), { ok: true, lat: 0, lon: 0 });
  assert.deepEqual(parsePosition('.5', '-.25'), { ok: true, lat: 0.5, lon: -0.25 });
  assert.deepEqual(parsePosition('90', '-180'), { ok: true, lat: 90, lon: -180 }, 'the edges are allowed');
  // A minus sign copied from a web page is often not the keyboard's.
  assert.deepEqual(parsePosition('44.825278', '−73.171727'), { ok: true, lat: 44.825278, lon: -73.171727 });
  assert.deepEqual(parsePosition('44.825278°', '-73.171727 °'), { ok: true, lat: 44.825278, lon: -73.171727 });
});

test('a pair pasted into either box wins over the other box', () => {
  const want = { ok: true, lat: 44.825278, lon: -73.171727 };
  assert.deepEqual(parsePosition('44.825278, -73.171727', ''), want);
  assert.deepEqual(parsePosition('44.825278, -73.171727', '-100.5'), want, 'the old longitude is still in its box');
  assert.deepEqual(parsePosition('12.5', '44.825278, -73.171727'), want);
  assert.deepEqual(parsePosition('', '44.825278,-73.171727'), want);
  assert.deepEqual(parsePosition('44.825278 -73.171727', ''), want);
  assert.deepEqual(parsePosition('44.825278\t-73.171727', ''), want);
  assert.deepEqual(parsePosition('44.825278; -73.171727', ''), want);
  assert.deepEqual(parsePosition('(44.825278, -73.171727)', ''), want);
  assert.deepEqual(parsePosition('lat 44.825278, lon -73.171727', ''), want);
  assert.deepEqual(parsePosition('44.825278, -73.171727', 'garbage'), want, 'a whole pair doesn\'t need the other box');
  // The same pair in both boxes is fine. Two different pairs are not.
  assert.deepEqual(parsePosition('44.825278, -73.171727', '44.825278, -73.171727'), want);
  const two = parsePosition('44.825278, -73.171727', '44.9, -73.2');
  assert.equal(two.ok, false);
  assert.equal(two.box, 'both');
  // What COPY COORDINATES copies reads straight back.
  assert.deepEqual(parsePosition(coordsText(FIELD), ''), want);
});

test('N, S, E and W, before or after the number', () => {
  const want = { ok: true, lat: 44.825278, lon: -73.171727 };
  assert.deepEqual(parsePosition('44.825278N', '73.171727W'), want);
  assert.deepEqual(parsePosition('n 44.825278', 'w73.171727'), want);
  assert.deepEqual(parsePosition('44.825278 N', '73.171727 w'), want);
  assert.deepEqual(parsePosition('44.825278N 73.171727W', ''), want);
  assert.deepEqual(parsePosition('44.825278N, 73.171727W', ''), want);
  assert.deepEqual(parsePosition('N44.825278 W73.171727', ''), want);
  assert.deepEqual(parsePosition('N 44.825278, W 73.171727', ''), want);
  assert.deepEqual(parsePosition('44.825278 N, 73.171727 W', ''), want);
  assert.deepEqual(parsePosition('44.825278 W73.171727', ''), want, 'a letter goes with the number it touches');
  assert.deepEqual(parsePosition('44.825278N -73.171727', ''), want, 'a letter on one and a sign on the other');
  // With letters on both, the longitude may come first.
  assert.deepEqual(parsePosition('73.171727W 44.825278N', ''), want);
  assert.deepEqual(parsePosition('W73.171727, N44.825278', ''), want);
  assert.deepEqual(parsePosition('8.537473 S', '119.572459 E'), { ok: true, lat: -8.537473, lon: 119.572459 });
});

test('a bad value is refused with a plain message and the box it is in', () => {
  const refused = (latText, lonText, box, words) => {
    const r = parsePosition(latText, lonText);
    assert.equal(r.ok, false, `"${latText}" and "${lonText}" should be refused`);
    assert.equal(r.box, box, `"${latText}" and "${lonText}": ${r.message}`);
    assert.match(r.message, words);
    assert.equal(r.lat, undefined);
    // The console's writing rules: no em dashes or semicolons in what a person reads.
    assert.doesNotMatch(r.message, /[—;]/);
  };
  refused('', '-73.171727', 'lat', /Type a latitude/);
  refused('44.825278', '', 'lon', /Type a longitude/);
  refused('   ', '   ', 'lat', /Type a latitude/);
  refused('abc', '-73.171727', 'lat', /can't be read/);
  refused('44.825278', 'west', 'lon', /can't be read/);
  refused('44.82.5278', '-73.171727', 'lat', /can't be read/);
  refused('91', '-73.171727', 'lat', /Latitude goes from -90 to 90/);
  refused('-90.0001', '0', 'lat', /Latitude/);
  refused('44.825278', '180.5', 'lon', /Longitude goes from -180 to 180/);
  refused('44.825278', '-181', 'lon', /Longitude/);
  refused('73.171727W', '44.825278', 'lat', /E and W are for longitude/);
  refused('44.825278', '44.825278N', 'lon', /N and S are for latitude/);
  refused('-44.825278S', '-73.171727', 'lat', /minus sign or a letter/);
  refused('44.825278', '-73.171727W', 'lon', /minus sign or a letter/);
  refused('44°49\'31"N', '73°10\'18"W', 'lat', /decimal degrees/);
  // Degrees and decimal minutes look like a pair. They are refused, never
  // read as latitude 44 and longitude 49.517.
  refused('44 49.517', '', 'lat', /degrees and minutes/);
  refused('44 49.517', '-73 10.304', 'lat', /degrees and minutes/);
  refused('44.825278', '-73 10.304', 'lon', /degrees and minutes/);
  refused('44 49.517 N', '', 'lat', /degrees and minutes/);
  refused('44 49 31', '', 'lat', /too many numbers/);
  refused('44,825278', '-73,171727', 'lat', /point for decimals/);
  refused('44.8, -73.1, 12', '', 'lat', /too many numbers/);
  refused('44.8N 73.1N', '', 'lat', /one latitude .* and one longitude/);
  refused('91, -73.171727', '', 'lat', /Latitude/);
  refused('44.825278, -190', '', 'lat', /Longitude/);
  refused('NaN', 'Infinity', 'lat', /can't be read/);
  // One letter between two numbers could belong to either.
  refused('1e5', '2', 'lat', /can't be read/);
  refused('44N73', '', 'lat', /can't be read/);
});

test('a pair that only looks like degrees and minutes is still read', () => {
  // A comma, a sign on the second number or a letter on each says it is a pair.
  assert.deepEqual(parsePosition('44, 49.517', ''), { ok: true, lat: 44, lon: 49.517 });
  assert.deepEqual(parsePosition('44 -73', ''), { ok: true, lat: 44, lon: -73 });
  assert.deepEqual(parsePosition('44N 49E', ''), { ok: true, lat: 44, lon: 49 });
  assert.deepEqual(parsePosition('44.825278N73.171727W', ''), { ok: true, lat: 44.825278, lon: -73.171727 }, 'no space at all, a letter on each');
  assert.deepEqual(parsePosition('long -73.171727 lat 44.825278', '').ok, true);
});

test('readPair splits a pasted position, and leaves anything else alone', () => {
  assert.deepEqual(readPair('44.825278, -73.171727'), { lat: 44.825278, lon: -73.171727 });
  assert.deepEqual(readPair('44.825278N 73.171727W'), { lat: 44.825278, lon: -73.171727 });
  assert.equal(readPair('44.825278'), null, 'one value is not a pair');
  assert.equal(readPair('-73.171727'), null);
  assert.equal(readPair('hello'), null);
  assert.equal(readPair(''), null);
  assert.equal(readPair('95, 10'), null, 'a pair out of range is left for SET to refuse');
  assert.equal(formatDegrees(44.825278), '44.825278');
  assert.equal(formatDegrees(-73.1717271234), '-73.171727');
  assert.equal(formatDegrees(-73), '-73.000000');
  assert.equal(formatDegrees(null), '');
});

// ------------------------------------------------------------------
// The readout's words
// ------------------------------------------------------------------

test('COPY COORDINATES: decimal degrees, 6 places, a comma and a space', () => {
  assert.equal(coordsText({ lat: 44.825278, lon: -73.171727 }), '44.825278, -73.171727');
  assert.equal(coordsText({ lat: 35.1232697, lon: -117.1233786 }), '35.123270, -117.123379');
  assert.equal(coordsText({ lat: -8.5, lon: 119 }), '-8.500000, 119.000000');
  assert.equal(coordsText(null), '');
  assert.equal(coordsText({ lat: NaN, lon: 1 }), '');
  assert.equal(coordsText({ lat: 91, lon: 1 }), '');
});

test('range and bearing: meters under 10 km, then km, degrees true with the compass point', () => {
  assert.equal(distanceWords(0), '0 M');
  assert.equal(distanceWords(1240.4), '1,240 M');
  assert.equal(distanceWords(9999.4), '9,999 M');
  assert.equal(distanceWords(9999.6), '10.00 KM');
  assert.equal(distanceWords(12345), '12.35 KM');
  assert.equal(distanceWords(3912450), '3,912.45 KM');
  assert.equal(distanceWords(NaN), '--');
  assert.equal(rangeWords({ distanceM: 1240, bearingDeg: 73.2 }), '1,240 M AT 073° ENE');
  assert.equal(rangeWords({ distanceM: 840, bearingDeg: 359.7 }), '840 M AT 000° N');
  assert.equal(rangeWords({ distanceM: 15000, bearingDeg: 225 }), '15.00 KM AT 225° SW');
  assert.equal(rangeWords(null), '--');
  assert.equal(rangeWords({ distanceM: null, bearingDeg: 10 }), '--');

  // From the field center to a spot 1,240 m away on a bearing of 73 degrees.
  const fix = destinationPoint(FIELD.lat, FIELD.lon, 73, 1240);
  const m = measureFrom(FIELD, fix);
  assert.ok(near(m.rangeM, 1240, 0.01));
  assert.ok(near(m.bearingDeg, 73, 0.01));
  assert.equal(rangeWords({ distanceM: m.rangeM, bearingDeg: m.bearingDeg }), '1,240 M AT 073° ENE');
  assert.deepEqual(measureFrom(null, fix), { rangeM: null, bearingDeg: null }, 'no ground station, nothing to measure');
  assert.deepEqual(measureFrom(FIELD, null), { rangeM: null, bearingDeg: null });
});

test('ages count like a clock, and a time on another day says which day', () => {
  assert.equal(ageWords(0), '0:00');
  assert.equal(ageWords(3.9), '0:03');
  assert.equal(ageWords(135), '2:15');
  assert.equal(ageWords(2 * 3600 + 13 * 60 + 5), '2:13:05');
  assert.equal(ageWords(86400 + 6 * 3600 + 59), '1 DAY 6 H');
  assert.equal(ageWords(2 * 86400 + 3 * 3600), '2 DAYS 3 H');
  assert.equal(ageWords(-5), '0:00', 'a clock set back never gives a negative age');
  assert.equal(ageWords(null), '--');

  const now = new Date(2026, 10, 21, 15, 30, 0).getTime();
  assert.equal(clockWords(new Date(2026, 10, 21, 14, 2, 11).getTime(), now), 'AT 14:02:11');
  assert.equal(clockWords(new Date(2026, 10, 21, 0, 0, 5).getTime(), now), 'AT 00:00:05');
  assert.equal(clockWords(new Date(2026, 10, 17, 9, 5, 0).getTime(), now), 'ON NOV 17 AT 09:05:00');
  assert.equal(clockWords(new Date(2025, 10, 21, 14, 2, 11).getTime(), now), 'ON NOV 21 AT 14:02:11', 'the same date a year back is another day');
  assert.equal(clockWords(null, now), '--');
  assert.equal(clockWords(NaN, now), '--');
});

test('arrival times count back from the newest packet\'s real arrival, or from the store\'s clock without it', () => {
  const now = 1795300100000;
  // The flight feed knows when the newest packet arrived.
  assert.equal(arrivalMs({ t: 50, newestT: 50, newestMs: 1795300000000, ageS: 0, nowMs: now }), 1795300000000,
    'the newest packet arrived when the feed says, whatever the store\'s clock');
  assert.equal(arrivalMs({ t: 47, newestT: 50, newestMs: 1795300000000, ageS: 0, nowMs: now }), 1795299997000,
    'a fix 3 s older than the newest packet arrived 3 s before it');
  assert.equal(arrivalMs({ t: 52, newestT: 50, newestMs: 1795300000000, nowMs: now }), 1795300000000, 'never after the newest packet');
  // No feed (the bench store): the store's age, back from now. The old way.
  assert.equal(arrivalMs({ t: 50, newestT: 50, newestMs: null, ageS: 4, nowMs: now }), now - 4000);
  assert.equal(arrivalMs({ t: 50, ageS: null, nowMs: now }), now);
  assert.equal(arrivalMs({ t: null, newestMs: 1795300000000 }), null);
  assert.equal(arrivalMs({ t: NaN, ageS: 2 }), null);

  assert.equal(ageSince(now - 12500, now), 12.5);
  assert.equal(ageSince(now + 3000, now), 0, 'a clock set back never gives a negative age');
  assert.equal(ageSince(null, now), null);
  assert.equal(ageSince(NaN, now), null);
});

test('a recovered recording played back keeps its real arrival times for LAST PACKET and the saved fix', () => {
  // RECOVER after a crash: js/launch/flight-log.js plays the recording's
  // lines back into the flight feed in one go, each with the time it first
  // arrived. The panel stamps a time when it first sees it, from inside the
  // store's change event, the way launch-panel.js does.
  const lines = readFileSync(new URL('./radio-board-rx-capture.log', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 40);
  const firstMs = 1795300000000;
  const times = lines.map((_, i) => firstMs + i * 500);
  const lastPktIndex = lines.map((l) => l.startsWith('PKT ')).lastIndexOf(true);
  const realLastMs = times[lastPktIndex];
  const restoreMs = realLastMs + 20000;   // RECOVER is pressed 20 s after the last packet

  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight, groundStation: { ...FIELD, altMsl: null, source: 'launch-mode' } });
  let clock = restoreMs;
  const feed = createFlightFeed({ store, clock: () => clock, every: null });
  const stamps = { packetMs: null, fixMs: null, oldWayPacketMs: null };
  const seen = { packetT: null, fixT: null };
  store.subscribe(() => {
    const rocket = store.getFocused();
    if (!rocket) return;
    const newestMs = feed.lastArrival(rocket.id);
    if (rocket.lastPacketT !== seen.packetT) {
      seen.packetT = rocket.lastPacketT;
      stamps.packetMs = arrivalMs({ t: rocket.lastPacketT, newestT: rocket.lastPacketT, newestMs, ageS: store.ageOf(rocket.lastPacketT), nowMs: clock });
      stamps.oldWayPacketMs = clock - (store.ageOf(rocket.lastPacketT) ?? 0) * 1000;
    }
    const fixT = rocket.lastGoodFix?.t ?? null;
    if (fixT !== seen.fixT) {
      seen.fixT = fixT;
      stamps.fixMs = arrivalMs({ t: fixT, newestT: rocket.lastPacketT, newestMs, ageS: store.ageOf(fixT), nowMs: clock });
    }
  });
  const detector = createSourceDetector();
  let source = null;
  lines.forEach((line, i) => {
    source = detector.push(line) ?? source;
    if (source?.mode === 'flight') {
      feed.noteLine(line);
      feed.push(source.parse(line), times[i]);
    }
  });
  const rocket = store.getFocused();
  assert.equal(feed.lastArrival(rocket.id), realLastMs, 'the feed keeps the line\'s own time');
  assert.equal(feed.lastArrival('no such rocket'), null);
  assert.equal(stamps.packetMs, realLastMs, 'LAST PACKET is when the packet came in');
  assert.equal(stamps.fixMs, realLastMs, 'every packet in the capture has a fix, so the fix came with the last one');
  assert.equal(stamps.oldWayPacketMs, restoreMs, 'the old way gave the moment it was put back on screen');

  // The ages count on the computer's clock from the real arrival, and keep counting.
  assert.equal(ageSince(feed.lastArrival(rocket.id), clock), 20);
  clock += 7000;
  feed.tick();
  assert.equal(ageSince(feed.lastArrival(rocket.id), clock), 27);
  assert.equal(clockWords(stamps.packetMs, clock), clockWords(realLastMs, clock));
  // The packets stopped long ago: an old fix, with its real age.
  const st = fixState({ source: 'live', fixAgeS: ageSince(stamps.fixMs, clock), silent: ageSince(feed.lastArrival(rocket.id), clock) > config.LINK_STALE_S, fixNow: false, staleS: config.LINK_STALE_S });
  assert.equal(st.why, 'no-packets');
  assert.equal(st.headline, 'OLD FIX, FROM 0:27 AGO');
  assert.equal(st.detail, 'Packets from the rocket have stopped.');

  // What goes into localStorage has the real times too.
  const saved = readSavedFix(JSON.stringify(makeSavedFix({ fix: rocket.lastGoodFix, rocketId: rocket.id, fixMs: stamps.fixMs, packetMs: stamps.packetMs, savedMs: clock })));
  assert.equal(saved.fixMs, realLastMs);
  assert.equal(saved.packetMs, realLastMs);

  // CONNECT carries the flight on: a packet that arrives now takes over,
  // and LAST PACKET counts from now.
  clock += 1000;
  const lastPkt = lines[lastPktIndex];
  const upS = Number(/\bup_s=([\d.]+)/.exec(lastPkt)[1]) + 28;
  const seq = Number(/\bseq=(\d+)/.exec(lastPkt)[1]) + 28;
  const next = lastPkt.replace(/\bseq=\d+/, `seq=${seq}`).replace(/\bup_s=[\d.]+/, `up_s=${upS.toFixed(1)}`);
  assert.equal(feed.push(source.parse(next), clock), true);
  assert.equal(feed.lastArrival(rocket.id), clock);
  assert.equal(stamps.packetMs, clock);
  assert.equal(stamps.fixMs, clock);
  assert.equal(ageSince(feed.lastArrival(rocket.id), clock), 0);
});

test('the altitude says which altitude it is', () => {
  assert.equal(altitudeWords(73.2), '73.2 M ABOVE SEA LEVEL');
  assert.equal(altitudeWords(1234.56), '1,234.6 M ABOVE SEA LEVEL');
  assert.equal(altitudeWords(null), '--');
  assert.equal(heightWords(12.4), '12 M');
  assert.equal(heightWords(-0.3), '0 M');
  assert.equal(heightWords(250, true), '250 M, ESTIMATED');
  assert.equal(heightWords(null), '--');
});

test('the fix is current, old or saved, and the line says why', () => {
  const current = fixState({ source: 'live', fixAgeS: 0.4, silent: false, fixNow: true, staleS: 5 });
  assert.deepEqual(current, { old: false, why: 'current', headline: 'CURRENT FIX', detail: '' });

  const quiet = fixState({ source: 'live', fixAgeS: 135, silent: true, fixNow: false, staleS: 5 });
  assert.equal(quiet.old, true);
  assert.equal(quiet.why, 'no-packets');
  assert.equal(quiet.headline, 'OLD FIX, FROM 2:15 AGO');
  assert.match(quiet.detail, /Packets from the rocket have stopped/);

  const noFix = fixState({ source: 'live', fixAgeS: 42, silent: false, fixNow: false, staleS: 5 });
  assert.equal(noFix.why, 'no-fix');
  assert.equal(noFix.headline, 'OLD FIX, FROM 0:42 AGO');
  assert.match(noFix.detail, /without a good GPS fix/);
  // Packets with a fix flag but no usable position for a while: old too.
  assert.equal(fixState({ source: 'live', fixAgeS: 5.1, silent: false, fixNow: true, staleS: 5 }).why, 'no-fix');
  assert.equal(fixState({ source: 'live', fixAgeS: 5, silent: false, fixNow: true, staleS: 5 }).why, 'current');

  const saved = fixState({ source: 'reload', fixAgeS: 2 * 3600 + 13 * 60 + 5 });
  assert.equal(saved.old, true);
  assert.equal(saved.why, 'reload');
  assert.equal(saved.headline, 'SAVED FIX, FROM 2:13:05 AGO');
  assert.match(saved.detail, /before the page was reloaded/);

  const earlier = fixState({ source: 'earlier', fixAgeS: 30 });
  assert.equal(earlier.why, 'earlier');
  assert.equal(earlier.old, true);
  assert.match(earlier.detail, /earlier on this page/);

  // A fix from the test capture says so, whatever its state.
  const testNow = fixState({ source: 'live', fixAgeS: 0.4, silent: false, fixNow: true, staleS: 5, test: true });
  assert.equal(testNow.why, 'current');
  assert.equal(testNow.headline, 'CURRENT FIX');
  assert.equal(testNow.detail, 'This fix came from the test capture.');
  const testSaved = fixState({ source: 'reload', fixAgeS: 30, test: true });
  assert.equal(testSaved.detail, 'Saved before the page was reloaded. No newer fix has been heard. This fix came from the test capture.');
  assert.equal(fixState({ source: 'reload', fixAgeS: 30, test: false }).detail, saved.detail);

  for (const st of [current, quiet, noFix, saved, earlier, testNow, testSaved]) {
    assert.doesNotMatch(`${st.headline} ${st.detail}`, /[—;]/);
  }
});

// ------------------------------------------------------------------
// The saved fix
// ------------------------------------------------------------------

test('the saved fix: what goes into storage comes back the same', () => {
  const record = makeSavedFix({
    fix: { t: 932, lat: 35.1232697, lon: -117.1233786, altMsl: 73.2, sats: 12, hdop: 0.98 },
    rocketId: 1,
    rocketName: 'GPS and radio board',
    fixMs: 1795300000000,
    packetMs: 1795300004000,
    aglM: 13.5,
    aglEstimated: false,
    groundStation: { lat: FIELD.lat, lon: FIELD.lon, typed: false },
    savedMs: 1795300004001,
  });
  assert.deepEqual(record, {
    v: SAVED_FIX_VERSION,
    lat: 35.1232697,
    lon: -117.1233786,
    altMsl: 73.2,
    aglM: 13.5,
    aglEstimated: false,
    rocketId: '1',
    rocketName: 'GPS and radio board',
    fixMs: 1795300000000,
    packetMs: 1795300004000,
    groundStation: { lat: FIELD.lat, lon: FIELD.lon, typed: false },
    test: false,
    savedMs: 1795300004001,
  });
  assert.deepEqual(readSavedFix(JSON.stringify(record)), record);
  assert.equal(coordsText(readSavedFix(JSON.stringify(record))), '35.123270, -117.123379');
  assert.equal(SAVED_FIX_KEY, 'fc-launch-last-fix');

  // A fix from the test capture keeps its mark through storage. Only true
  // counts: anything else stored there reads back as a real fix.
  const test = makeSavedFix({ fix: { lat: 1, lon: 2 }, fixMs: 1000, test: true, savedMs: 1001 });
  assert.equal(test.test, true);
  assert.equal(readSavedFix(JSON.stringify(test)).test, true);
  assert.equal(readSavedFix(JSON.stringify({ ...test, test: 'yes' })).test, false);
  const older = { ...test };
  delete older.test;
  assert.equal(readSavedFix(JSON.stringify(older)).test, false, 'a record saved before the mark existed');
});

test('the saved fix: missing parts are null, and a damaged one is ignored', () => {
  const bare = makeSavedFix({ fix: { lat: 1, lon: 2 }, rocketId: '7', fixMs: 1000, savedMs: 1001 });
  assert.equal(bare.altMsl, null);
  assert.equal(bare.aglM, null);
  assert.equal(bare.groundStation, null);
  assert.equal(bare.packetMs, 1000, 'with no packet time, the fix\'s own');
  assert.equal(makeSavedFix({ fix: { lat: 1, lon: 2 }, fixMs: 5000, packetMs: 4000 }).packetMs, 5000, 'the newest packet is never older than the fix');
  assert.equal(makeSavedFix({ fix: { lat: 1, lon: 2 }, fixMs: 5000 }).rocketId, '');

  assert.equal(makeSavedFix({ fix: null, fixMs: 1 }), null);
  assert.equal(makeSavedFix({ fix: { lat: 95, lon: 0 }, fixMs: 1 }), null);
  assert.equal(makeSavedFix({ fix: { lat: 1, lon: 2 } }), null, 'a fix with no time can\'t say how old it is');

  assert.equal(readSavedFix(null), null);
  assert.equal(readSavedFix(''), null);
  assert.equal(readSavedFix('not json {'), null);
  assert.equal(readSavedFix('"a string"'), null);
  assert.equal(readSavedFix('[1,2]'), null);
  assert.equal(readSavedFix(JSON.stringify({ ...bare, v: 99 })), null, 'another version');
  assert.equal(readSavedFix(JSON.stringify({ ...bare, lat: 'north' })), null);
  assert.equal(readSavedFix(JSON.stringify({ ...bare, fixMs: null })), null);
  // A ground station that didn't survive is dropped, the fix is kept.
  const odd = readSavedFix(JSON.stringify({ ...bare, groundStation: { lat: 'x' }, altMsl: 'high' }));
  assert.equal(odd.groundStation, null);
  assert.equal(odd.altMsl, null);
  assert.equal(odd.lat, 1);
});

// ------------------------------------------------------------------
// The store's ground station
// ------------------------------------------------------------------

const typedStation = (p) => ({ lat: p.lat, lon: p.lon, altMsl: null, source: 'launch-mode' });

test('setGroundStation moves the station at once and tells the views', () => {
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight, groundStation: typedStation(FIELD) });
  assert.deepEqual(store.getGroundStation(), { lat: FIELD.lat, lon: FIELD.lon, altMsl: null, source: 'launch-mode', t: null });
  const changes = [];
  store.subscribe((c) => changes.push(c.type));

  const pad = { lat: 44.8301, lon: -73.1652 };
  assert.equal(store.setGroundStation(typedStation(pad)), true);
  assert.deepEqual(store.getGroundStation(), { lat: pad.lat, lon: pad.lon, altMsl: null, source: 'launch-mode', t: null });
  assert.deepEqual(changes, ['station']);

  // It replaces the position the store was made with, so starting over keeps it.
  store.reset();
  assert.equal(store.getGroundStation().lat, pad.lat);
  store.clearAll();
  assert.equal(store.getGroundStation().lon, pad.lon);

  // A bad position changes nothing.
  assert.equal(store.setGroundStation({ lat: 'x', lon: 1 }), false);
  assert.equal(store.getGroundStation().lat, pad.lat);
  // null takes the station away.
  assert.equal(store.setGroundStation(null), true);
  assert.equal(store.getGroundStation(), null);
});

test('setGroundStation reaches the views through the store switch', () => {
  const store = createStore({ fleet: createFleet(), groundStation: typedStation(FIELD) });
  const stage = createStoreSwitch(store);
  const seen = [];
  stage.subscribe((c) => seen.push(c.type));
  stage.setGroundStation(typedStation({ lat: 44.83, lon: -73.16 }));
  assert.equal(stage.getGroundStation().lat, 44.83);
  assert.deepEqual(seen, ['station']);
});

test('a store made the normal way is unchanged: the demo position, called Manta', () => {
  const store = createStore({ fleet: createFleet() });
  assert.equal(store.getGroundStation().source, 'config');
  assert.equal(store.getGroundStation().lat, config.GROUND_STATION.lat);
  assert.equal(stationName(store.getGroundStation()), 'MANTA');
  assert.equal(stationName({ lat: 1, lon: 2, source: 'flight library' }), 'MANTA');
  assert.equal(stationName({ lat: 1, lon: 2, source: 'ground station GPS' }), 'MANTA');
  assert.equal(stationName(null), 'MANTA');
  assert.equal(stationName(typedStation(FIELD)), 'GROUND STATION');
});

test('launch mode is off in Node: the hub answers, and nothing starts', () => {
  assert.equal(hub.LAUNCH, false);
  assert.equal(hub.groundStation.get(), null, 'no field settings and nothing typed');
  assert.equal(launchGroundStation(), null);
  assert.equal(hub.online.get(), false);
  assert.equal(validPosition({ lat: 44.8, lon: -73.1 }), true);
  assert.equal(validPosition({ lat: 144.8, lon: -73.1 }), false);
});

// A flight that lands 840 m from the ground station, the way
// test/flight-state.test.mjs builds one.
function landedStore(station) {
  const store = createStore({ fleet: createFleet(), groundStation: station });
  const P = { lat: station.lat + 0.01, lon: station.lon };
  const Q = destinationPoint(station.lat, station.lon, 62, 840);
  let seq = 0;
  const push = (t, lat, lon, agl, speed) => store.addSample(makeSample({ t, seq: seq++, fix: 1, sats: 12, hdop: 1.2, stale: 0, lat, lon, altMsl: 100 + agl, speed }));
  for (let t = 0; t < 30; t++) push(t, P.lat, P.lon, 0, 0);
  for (let k = 1; k <= 40; k++) push(29 + k, P.lat, P.lon, 25 * k, 0.2);
  for (let k = 1; k <= 40; k++) {
    const f = k / 40;
    push(69 + k, P.lat + (Q.lat - P.lat) * f, P.lon + (Q.lon - P.lon) * f, 1000 - 25 * k, 12.5);
  }
  for (let k = 1; k <= 60; k++) push(109 + k, Q.lat, Q.lon, 0, 0);
  return { store, Q };
}

test('the HUD\'s recovery block names a typed-in position GROUND STATION, and Manta stays Manta', () => {
  const typed = landedStore(typedStation(FIELD));
  const info = recoveryInfo(typed.store);
  assert.ok(info, 'the flight landed');
  assert.equal(info.from, 'manta', 'the key still means the store\'s ground station');
  assert.equal(info.text.distance, '840 M FROM GROUND STATION');
  assert.equal(info.text.bearing, '062° (ENE)');
  assert.equal(info.mapsUrl, mapsUrl(info.position));
  assert.deepEqual(rangeReading(typed.store), { from: 'manta', demo: false, recovery: true, distanceM: info.distanceM, bearingDeg: info.bearingDeg });

  // Moving the ground station moves the HUD's numbers with it, at once.
  const moved = destinationPoint(typed.Q.lat, typed.Q.lon, 180, 300);
  typed.store.setGroundStation(typedStation(moved));
  const after = recoveryInfo(typed.store);
  assert.equal(after.text.distance, '300 M FROM GROUND STATION');
  assert.equal(after.text.bearing, '000° (N)');

  // The same flight with a flight library position (the normal page).
  const manta = landedStore({ lat: FIELD.lat, lon: FIELD.lon, altMsl: 2 });
  assert.equal(recoveryInfo(manta.store).text.distance, '840 M FROM MANTA');
  assert.equal(mapsUrl(null), '');
  assert.equal(mapsUrl({ lat: 44.825278, lon: -73.171727 }), 'https://www.google.com/maps/search/?api=1&query=44.825278,-73.171727');
});

// ------------------------------------------------------------------
// The receiver capture, through the page's own parser, feed and store
// ------------------------------------------------------------------

test('the capture\'s last line is the last good fix, and the range is a great circle from the field', () => {
  const lines = readFileSync(new URL('./radio-board-rx-capture.log', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
  const lastPkt = [...lines].reverse().find((l) => l.startsWith('PKT '));
  const field = (name) => Number(new RegExp(`\\b${name}=(-?[\\d.]+)`).exec(lastPkt)[1]);
  const want = { lat: field('lat'), lon: field('lon'), altM: field('alt_m') };

  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight, groundStation: typedStation(FIELD) });
  let clock = 1795300000000;
  const feed = createFlightFeed({ store, clock: () => clock, every: null });
  const detector = createSourceDetector();
  for (const line of lines) {
    const source = detector.push(line);
    if (source?.mode === 'flight') {
      feed.noteLine(line);
      feed.push(source.parse(line), clock);
    }
    clock += 500;
  }
  const rocket = store.getFocused();
  const fix = rocket.lastGoodFix;
  assert.equal(fix.lat, want.lat);
  assert.equal(fix.lon, want.lon);
  assert.equal(fix.altMsl, want.altM);
  assert.equal(coordsText(fix), `${want.lat.toFixed(6)}, ${want.lon.toFixed(6)}`);
  assert.equal(coordsText(fix), '35.123270, -117.123379');
  assert.equal(altitudeWords(fix.altMsl), '73.2 M ABOVE SEA LEVEL');

  // An independent great circle, on a sphere of the same radius: the
  // spherical law of cosines for the distance, and the bearing from the
  // tangent of the half angles. geo.js uses the haversine and atan2.
  const rad = (d) => d * Math.PI / 180;
  const R = 6371000;
  const p1 = rad(FIELD.lat); const p2 = rad(want.lat); const dl = rad(want.lon - FIELD.lon);
  const central = Math.acos(Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl));
  const expectM = R * central;
  const expectDeg = ((Math.atan2(Math.sin(dl), Math.cos(p1) * Math.tan(p2) - Math.sin(p1) * Math.cos(dl)) * 180 / Math.PI) + 360) % 360;
  const m = measureFrom(store.getGroundStation(), fix);
  assert.ok(Math.abs(m.rangeM - expectM) < 1, `range ${m.rangeM} against ${expectM}`);
  assert.ok(Math.abs(m.bearingDeg - expectDeg) < 0.1, `bearing ${m.bearingDeg} against ${expectDeg}`);
  // Vermont to the Mojave. Worked out a third way outside this repo (the
  // atan2 form of the great circle, in Python): 3,846,380.59 m at 269.29°.
  assert.ok(Math.abs(m.rangeM - 3846380.59) < 1, `range ${m.rangeM}`);
  assert.ok(Math.abs(m.bearingDeg - 269.29) < 0.1, `bearing ${m.bearingDeg}`);
  assert.equal(rangeWords({ distanceM: m.rangeM, bearingDeg: m.bearingDeg }), '3,846.38 KM AT 269° W');

  // A ground station typed in a few hundred meters from the fix.
  const close = destinationPoint(want.lat, want.lon, 250, 340);
  store.setGroundStation(typedStation(close));
  const near340 = measureFrom(store.getGroundStation(), fix);
  assert.ok(Math.abs(near340.rangeM - 340) < 0.01);
  assert.ok(Math.abs(near340.bearingDeg - bearingDeg(close.lat, close.lon, want.lat, want.lon)) < 1e-9);
  assert.ok(Math.abs(near340.rangeM - distanceM(close.lat, close.lon, want.lat, want.lon)) < 1e-9);
  assert.equal(rangeWords({ distanceM: near340.rangeM, bearingDeg: near340.bearingDeg }), '340 M AT 070° ENE');

  // The fix is current while packets arrive, and old once they stop. The
  // coordinates never change.
  const state = () => fixState({
    source: 'live', fixAgeS: store.ageOf(fix.t), silent: store.isSilent(rocket), fixNow: store.hasFixNow(rocket), staleS: config.LINK_STALE_S,
  });
  assert.equal(state().why, 'current');
  clock += 135000;
  feed.tick();
  assert.equal(state().why, 'no-packets');
  assert.match(state().headline, /^OLD FIX, FROM 2:1\d AGO$/);
  assert.equal(coordsText(store.getFocused().lastGoodFix), '35.123270, -117.123379');
});
