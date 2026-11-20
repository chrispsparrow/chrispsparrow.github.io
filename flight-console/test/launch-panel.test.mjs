// Tests for the launch panel's logic (js/launch/launch-panel.js): reading a
// ground station position typed in at the field (js/launch/position-input.js),
// the recovery readout's words, which fix it picks and its saved fix
// (js/launch/recovery-fix.js), the store's setGroundStation() (js/store.js),
// and what the HUD calls the ground station on the launch page
// (stationName() in js/flight-state.js).
// The last parts of the file feed receiver lines through the same parser,
// feed and store the page uses: the capture, checked against its own last
// line, then packets a real receiver can send that must never take the
// readout (one far away, one at 0, 0), weak fixes, a real move, one far
// packet after 6, 20 and 100 s without packets (the trail takes those as
// good, the readout holds them back), the first packet after a reload, the
// other rockets' saved fixes, the last fix read back out of a recording
// after a crash, and a recording with only weak fixes, which goes under the
// saved good fix.
// Run with: node --test "flight-console/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePosition, readPair, formatDegrees, roundDegrees } from '../js/launch/position-input.js';
import {
  SAVED_FIX_KEY, SAVED_FIX_VERSION, coordsText, distanceWords, rangeWords, measureFrom, ageWords, clockWords,
  altitudeWords, heightWords, qualityWords, fixState, pickFix, makeSavedFix, readSavedFix, newerRecord, weakUnderGood, lastFixInLines,
  arrivalMs, ageSince, GOOD_STAYS_MS, reachM, isFar, farUnderGood, keepUnder, underFix, readOtherFixes, SAVED_OTHERS_KEY, OTHERS_MAX,
  CONFIRM_FIXES, REACH_SPEED_MPS, REACH_FLOOR_M, REACH_MAX_M,
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

test('a message is worded for the box it shows under', () => {
  // A space after the point used to read as the pair 44 and 825278, and the
  // latitude box then got "Longitude goes from -180 to 180."
  const lat = parsePosition('44. 825278', '-73.171727');
  assert.deepEqual(lat, { ok: false, box: 'lat', message: 'There is a space after the point. Type it as one number, like 44.825278.' });
  const lon = parsePosition('44.825278', '-73. 171727');
  assert.deepEqual(lon, { ok: false, box: 'lon', message: 'There is a space after the point. Type it as one number, like -73.171727.' });
  assert.equal(parsePosition('44. 825278', '').box, 'lat');
  assert.doesNotMatch(parsePosition('44. 825278', '').message, /ongitude/);
  // With a comma or a sign it is a pair, as before.
  assert.deepEqual(parsePosition('44., 73', ''), { ok: true, lat: 44, lon: 73 });
  assert.deepEqual(parsePosition('44. -73.5', ''), { ok: true, lat: 44, lon: -73.5 });

  // A pair that is out of range says the box holds a pair, and which of its
  // numbers is wrong.
  assert.equal(parsePosition('44.825278, -190', '').message,
    'This box was read as a pair, and the pair\'s longitude, -190, is out of range. Longitude goes from -180 to 180.');
  assert.equal(parsePosition('', '95, 10').message,
    'This box was read as a pair, and the pair\'s latitude, 95, is out of range. Latitude goes from -90 to 90.');
  assert.equal(parsePosition('', '95, 10').box, 'lon');
  // One value in each box keeps the short message, under its own box.
  assert.deepEqual(parsePosition('44.8', '-190'), { ok: false, box: 'lon', message: 'Longitude goes from -180 to 180.' });

  // The example is the kind of value the box takes.
  assert.match(parsePosition('abc', '-73.1').message, /like 44\.825278\.$/);
  assert.match(parsePosition('44.8', 'abc').message, /like -73\.171727\.$/);
  assert.match(parsePosition('44.8', '-73 10.304').message, /like -73\.171727\./);
  assert.match(parsePosition('44.8', '-73,17').message, /like -73\.171727\.$/);
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
  // A value that rounds to zero has no minus sign.
  assert.equal(formatDegrees(-0.0000001), '0.000000');
  assert.equal(formatDegrees(-0.0000004), '0.000000');
  assert.equal(formatDegrees(-0.0000006), '-0.000001');
  assert.equal(formatDegrees(-0), '0.000000');
  assert.equal(formatDegrees(0.0000004), '0.000000');
  assert.ok(Object.is(roundDegrees(-0.0000001), 0), 'never -0');
  assert.equal(roundDegrees(-73.1717271234), -73.171727);
  assert.ok(Number.isNaN(roundDegrees(null)));
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
  // Near the equator or the prime meridian: no "-0.000000" on the clipboard,
  // and none in the maps link, which the panel builds from roundDegrees().
  assert.equal(coordsText({ lat: -0.0000001, lon: -0.0000002 }), '0.000000, 0.000000');
  assert.equal(coordsText({ lat: 51.4778, lon: -0.0000003 }), '51.477800, 0.000000');
  assert.equal(mapsUrl({ lat: roundDegrees(-0.0000001), lon: roundDegrees(-73.1717271) }), 'https://www.google.com/maps/search/?api=1&query=0.000000,-73.171727');
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
  assert.equal(qualityWords({ sats: 4, hdop: 5.2 }), '4 SATS, HDOP 5.20');
  assert.equal(qualityWords({ sats: 1, hdop: 12 }), '1 SAT, HDOP 12.00');
  assert.equal(qualityWords({ sats: 7, hdop: null }), '7 SATS');
  assert.equal(qualityWords({ sats: null, hdop: null }), '--');
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

  const saved = fixState({ source: 'reload', fixAgeS: 2 * 3600 + 13 * 60 + 5, unfinished: false });
  assert.equal(saved.old, true);
  assert.equal(saved.why, 'reload');
  assert.equal(saved.headline, 'SAVED FIX, FROM 2:13:05 AGO');
  assert.equal(saved.detail, 'Saved before the page was reloaded. No newer fix has been heard.');
  // While a real recording waits for RECOVER (the page crashed), the page
  // can't know that nothing newer was heard, so it never says so.
  const crashed = fixState({ source: 'reload', fixAgeS: 70, unfinished: true });
  assert.equal(crashed.headline, 'SAVED FIX, FROM 1:10 AGO');
  assert.equal(crashed.detail, 'The page closed suddenly. Press RECOVER to put the flight back on the live view.');
  // Before the browser's storage has said whether one waits, it doesn't say so either.
  const asking = fixState({ source: 'reload', fixAgeS: 70 });
  assert.equal(asking.detail, 'Saved before the page was reloaded.');
  for (const st of [crashed, asking]) assert.doesNotMatch(st.detail, /No newer fix/);
  // No state says it while a recording waits, whatever the source or the fix.
  for (const source of ['live', 'reload', 'earlier', 'tab']) {
    for (const quality of ['good', 'weak']) {
      for (const silent of [false, true]) {
        const st = fixState({ source, quality, silent, fixAgeS: 70, fixNow: !silent, unfinished: true, test: false });
        assert.doesNotMatch(`${st.headline} ${st.detail}`, /No newer fix/, `${source} ${quality}`);
      }
    }
  }
  assert.equal(fixState({ source: 'earlier', fixAgeS: 30, unfinished: true }).detail, 'Saved earlier on this page.');

  // Heard by another launch tab on this laptop.
  const tab = fixState({ source: 'tab', fixAgeS: 2, unfinished: false });
  assert.deepEqual(tab, { old: true, why: 'tab', headline: 'SAVED FIX, FROM 0:02 AGO', detail: 'Heard in another launch tab on this laptop.' });

  const earlier = fixState({ source: 'earlier', fixAgeS: 30 });
  assert.equal(earlier.why, 'earlier');
  assert.equal(earlier.old, true);
  assert.match(earlier.detail, /earlier on this page/);

  // A fix from the test capture says so, whatever its state.
  const testNow = fixState({ source: 'live', fixAgeS: 0.4, silent: false, fixNow: true, staleS: 5, test: true });
  assert.equal(testNow.why, 'current');
  assert.equal(testNow.headline, 'CURRENT FIX');
  assert.equal(testNow.detail, 'This fix came from the test capture.');
  const testSaved = fixState({ source: 'reload', fixAgeS: 30, test: true, unfinished: false });
  assert.equal(testSaved.detail, 'Saved before the page was reloaded. No newer fix has been heard. This fix came from the test capture.');
  assert.equal(fixState({ source: 'reload', fixAgeS: 30, test: false, unfinished: false }).detail, saved.detail);

  // CURRENT FIX needs all three: a fix now, the rocket's newest crumb, and
  // packets arriving.
  assert.equal(fixState({ source: 'live', fixAgeS: 0.4, fixNow: true, newest: true }).why, 'current');
  const notNewest = fixState({ source: 'live', fixAgeS: 3, fixNow: true, newest: false });
  assert.equal(notNewest.why, 'no-fix');
  assert.equal(notNewest.headline, 'OLD FIX, FROM 0:03 AGO');
  // The newest position was left out as an impossible jump.
  const jump = fixState({ source: 'live', fixAgeS: 1, fixNow: true, newest: false, skipped: true });
  assert.deepEqual(jump, { old: true, why: 'jump', headline: 'OLD FIX, FROM 0:01 AGO', detail: 'The newest position is too far from this one to be real, so it is left out.' });
  assert.equal(fixState({ source: 'live', fixAgeS: 60, silent: true, fixNow: false, newest: false, skipped: true }).why, 'no-packets', 'quiet comes first');

  // A weak fix in the main readout is named a weak fix, whatever its state.
  const weakNow = fixState({ source: 'live', fixAgeS: 0.5, fixNow: true, quality: 'weak' });
  assert.deepEqual(weakNow, { old: false, why: 'current', headline: 'CURRENT WEAK FIX', detail: 'No good fix was heard, only this weak one. It may be off.' });
  const weakOld = fixState({ source: 'live', fixAgeS: 95, silent: true, fixNow: false, quality: 'weak' });
  assert.equal(weakOld.headline, 'OLD WEAK FIX, FROM 1:35 AGO');
  assert.equal(weakOld.detail, 'Packets from the rocket have stopped. No good fix was heard, only this weak one. It may be off.');
  const weakSaved = fixState({ source: 'reload', fixAgeS: 95, quality: 'weak', unfinished: true });
  assert.equal(weakSaved.headline, 'SAVED WEAK FIX, FROM 1:35 AGO');
  assert.match(weakSaved.detail, /^The page closed suddenly\. Press RECOVER/);

  for (const st of [current, quiet, noFix, saved, crashed, asking, tab, earlier, testNow, testSaved, notNewest, jump, weakNow, weakOld, weakSaved]) {
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
    quality: 'good',
    sats: 12,
    hdop: 0.98,
    aglM: 13.5,
    aglEstimated: false,
    rocketId: '1',
    rocketName: 'GPS and radio board',
    fixMs: 1795300000000,
    packetMs: 1795300004000,
    weak: null,
    held: null,
    groundStation: { lat: FIELD.lat, lon: FIELD.lon, typed: false },
    test: false,
    savedMs: 1795300004001,
  });
  assert.equal(SAVED_FIX_VERSION, 2);
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

test('the saved fix: a newer weak fix is kept with the good one, and version 1 still reads', () => {
  const good = { lat: 44.83, lon: -73.16, altMsl: 60, sats: 11, hdop: 0.9 };
  const weak = { lat: 44.8302, lon: -73.1597, altMsl: 58, sats: 4, hdop: 5.2, fixMs: 9000 };
  const record = makeSavedFix({ fix: good, weak, rocketId: 1, fixMs: 5000, packetMs: 9000, savedMs: 9001 });
  assert.deepEqual(record.weak, { lat: 44.8302, lon: -73.1597, altMsl: 58, sats: 4, hdop: 5.2, fixMs: 9000 });
  assert.equal(record.quality, 'good');
  assert.deepEqual(readSavedFix(JSON.stringify(record)), record, 'it comes back from storage the same');
  // The newest packet is never older than the weak fix it carried.
  assert.equal(makeSavedFix({ fix: good, weak, fixMs: 5000, packetMs: 6000 }).packetMs, 9000);
  // A weak fix that is older than the good one, or has no time, or no position, is dropped.
  assert.equal(makeSavedFix({ fix: good, weak: { ...weak, fixMs: 4000 }, fixMs: 5000 }).weak, null);
  assert.equal(makeSavedFix({ fix: good, weak: { ...weak, fixMs: undefined }, fixMs: 5000 }).weak, null);
  assert.equal(makeSavedFix({ fix: good, weak: { ...weak, lat: 'x' }, fixMs: 5000 }).weak, null);
  assert.equal(readSavedFix(JSON.stringify({ ...record, weak: 'nonsense' })).weak, null);

  // A weak fix in the main readout: quality says so, and nothing goes under it.
  const only = makeSavedFix({ fix: { lat: 44.83, lon: -73.16, altMsl: null, sats: 3, hdop: 9.9 }, quality: 'weak', weak, fixMs: 5000, savedMs: 5001 });
  assert.equal(only.quality, 'weak');
  assert.equal(only.sats, 3);
  assert.equal(only.hdop, 9.9);
  assert.equal(only.weak, null);
  assert.equal(readSavedFix(JSON.stringify(only)).quality, 'weak');
  assert.equal(readSavedFix(JSON.stringify({ ...only, quality: 'great' })).quality, 'good', 'only "weak" counts as weak');

  // What version 1 of this page saved (no quality, sats, hdop or weak).
  const v1 = '{"v":1,"lat":44.8261,"lon":-73.1702,"altMsl":61.5,"aglM":17.5,"aglEstimated":true,"rocketId":"1","rocketName":"","fixMs":1795300000000,"packetMs":1795300003000,"groundStation":{"lat":44.825278,"lon":-73.171727,"typed":false},"test":false,"savedMs":1795300003001}';
  const old = readSavedFix(v1);
  assert.equal(old.v, SAVED_FIX_VERSION);
  assert.equal(old.lat, 44.8261);
  assert.equal(old.lon, -73.1702);
  assert.equal(old.fixMs, 1795300000000);
  assert.equal(old.packetMs, 1795300003000);
  assert.equal(old.quality, 'good');
  assert.equal(old.weak, null);
  assert.equal(old.sats, null);
  assert.equal(old.aglEstimated, true);
  assert.equal(readSavedFix(v1.replace('"v":1', '"v":3')), null, 'a version from the future is ignored');
});

test('newerRecord: a newer position wins, then a newer packet', () => {
  const make = (fixMs, packetMs, weakMs = null) => makeSavedFix({
    fix: { lat: 1, lon: 2 }, fixMs, packetMs, weak: weakMs === null ? null : { lat: 1, lon: 2, fixMs: weakMs },
  });
  assert.equal(newerRecord(make(2000, 2000), make(1000, 1000)), true);
  assert.equal(newerRecord(make(1000, 1000), make(2000, 2000)), false);
  assert.equal(newerRecord(make(1000, 5000), make(1000, 4000)), true, 'the same fix, a newer packet');
  assert.equal(newerRecord(make(1000, 4000), make(1000, 4000)), false, 'the same record is not newer');
  assert.equal(newerRecord(make(1000, 3000, 3000), make(2000, 2000)), true, 'a weak fix counts as a position');
  assert.equal(newerRecord(make(2000, 2000), make(1000, 3000, 3000)), false);
  assert.equal(newerRecord(make(1000, 1000), null), true, 'anything is newer than nothing');
  assert.equal(newerRecord(null, make(1000, 1000)), false);
  // With a margin, times closer together than that are the same news.
  assert.equal(newerRecord(make(2000, 2000), make(1000, 1000), 500), true);
  assert.equal(newerRecord(make(2000, 2000), make(1500.5, 1500.5), 500), false, 'half a second apart, with a 500 ms margin');
  assert.equal(newerRecord(make(1000, 1000), make(999.9998, 999.9998), 1000), false, 'a rounding apart');
  assert.equal(newerRecord(make(1000, 9000), make(1000.2, 2000), 1000), true, 'the same fix, a packet 7 s newer');
  assert.equal(newerRecord(make(1000, 1000), make(5000, 5000), 1000), false);
});

test('a record with only a weak fix goes under a kept good fix, and never takes its place', () => {
  const T = 1795300000000;
  const station = { lat: FIELD.lat, lon: FIELD.lon, typed: false };
  const good = makeSavedFix({
    fix: { lat: 44.8261, lon: -73.1702, altMsl: 61.5, sats: 12, hdop: 0.9 }, rocketId: 1, rocketName: 'GPS and radio board',
    fixMs: T, packetMs: T + 2000, aglM: 0.4, groundStation: station, savedMs: T + 2000,
  });
  // After a reload the store only has weak fixes from the rocket in the grass.
  const weak = makeSavedFix({
    fix: { lat: 44.8263, lon: -73.1699, altMsl: 58, sats: 4, hdop: 5.2 }, quality: 'weak', rocketId: 1,
    fixMs: T + 90000, packetMs: T + 90000, groundStation: { lat: 44.83, lon: -73.16, typed: true }, savedMs: T + 90001,
  });
  const both = weakUnderGood(good, weak);
  assert.equal(coordsText(both), coordsText(good), 'the good fix is still the main one');
  assert.deepEqual([both.quality, both.fixMs, both.altMsl, both.sats, both.aglM, both.rocketName], ['good', T, 61.5, 12, 0.4, 'GPS and radio board']);
  assert.deepEqual(both.weak, { lat: 44.8263, lon: -73.1699, altMsl: 58, sats: 4, hdop: 5.2, fixMs: T + 90000 });
  assert.equal(both.packetMs, T + 90000, 'the newest packet is the weak fix\'s');
  assert.deepEqual(both.groundStation, { lat: 44.83, lon: -73.16, typed: true }, 'the ground station in use now');
  assert.equal(both.test, false);
  assert.deepEqual(readSavedFix(JSON.stringify(both)), both, 'it goes through storage like any saved fix');
  assert.equal(newerRecord(both, good), true, 'it is newer news than the good fix alone');
  // The next weak fix takes the weak one's place, under the same good fix.
  const next = makeSavedFix({ fix: { lat: 44.8264, lon: -73.1698, sats: 5, hdop: 4.1 }, quality: 'weak', rocketId: 1, fixMs: T + 91000, packetMs: T + 91000 });
  const again = weakUnderGood(both, next);
  assert.equal(coordsText(again), coordsText(good));
  assert.equal(coordsText(again.weak), '44.826400, -73.169800');
  assert.equal(again.weak.fixMs, T + 91000);
  // A good fix that already has a weak one under it: the newer weak one replaces it.
  const goodWithWeak = makeSavedFix({ fix: good, weak: { lat: 1, lon: 2, fixMs: T + 1000 }, rocketId: 1, fixMs: T, packetMs: T + 1000 });
  assert.equal(coordsText(weakUnderGood(goodWithWeak, weak).weak), coordsText(weak));

  // When it does not apply, the answer is null and the caller's own rules decide.
  const goodNext = makeSavedFix({ fix: { lat: 44.83, lon: -73.16 }, rocketId: 1, fixMs: T + 90000, packetMs: T + 90000 });
  assert.equal(weakUnderGood(good, goodNext), null, 'a good fix heard now takes over');
  assert.equal(weakUnderGood(weak, next), null, 'weak after weak: the newest weak one');
  assert.equal(weakUnderGood(null, weak), null);
  assert.equal(weakUnderGood(good, null), null);
  assert.equal(weakUnderGood(good, { ...weak, rocketId: '2' }), null, 'another rocket');
  assert.equal(weakUnderGood(good, { ...weak, test: true }), null, 'a test capture\'s weak fix never joins a real fix');
  assert.equal(weakUnderGood({ ...good, test: true }, weak), null, 'and a real one never joins a test fix');
  assert.equal(weakUnderGood(good, { ...weak, fixMs: T - 1 }), null, 'a weak fix from before the good one');
  // A good fix from another day gives way to a weak fix heard now.
  assert.equal(GOOD_STAYS_MS, 6 * 3600 * 1000);
  assert.notEqual(weakUnderGood(good, { ...weak, fixMs: T + GOOD_STAYS_MS, packetMs: T + GOOD_STAYS_MS }), null);
  assert.equal(weakUnderGood(good, { ...weak, fixMs: T + GOOD_STAYS_MS + 1, packetMs: T + GOOD_STAYS_MS + 1 }), null);

  // The line under the saved fix says what was heard since.
  const reloaded = fixState({ source: 'reload', fixAgeS: 90, unfinished: false, weakSince: true });
  assert.deepEqual(reloaded, { old: true, why: 'reload', headline: 'SAVED FIX, FROM 1:30 AGO', detail: 'Saved before the page was reloaded. Only weak fixes have been heard since.' });
  assert.equal(fixState({ source: 'reload', fixAgeS: 90, weakSince: true }).detail, reloaded.detail, 'also before storage has answered');
  assert.equal(fixState({ source: 'reload', fixAgeS: 90, unfinished: true, weakSince: true }).detail, 'The page closed suddenly. Press RECOVER to put the flight back on the live view.');
  assert.equal(fixState({ source: 'earlier', fixAgeS: 90, weakSince: true }).detail, 'Saved earlier on this page. Only weak fixes have been heard since.');
  assert.equal(fixState({ source: 'earlier', fixAgeS: 90, unfinished: true, weakSince: true }).detail, 'Saved earlier on this page. Only weak fixes have been heard since.');
  assert.equal(fixState({ source: 'tab', fixAgeS: 90, weakSince: true }).detail, 'Heard in another launch tab on this laptop. Only weak fixes have been heard since.');
  for (const source of ['reload', 'earlier', 'tab']) {
    for (const unfinished of [null, false, true]) {
      const st = fixState({ source, fixAgeS: 90, unfinished, weakSince: true });
      assert.doesNotMatch(`${st.headline} ${st.detail}`, /No newer fix|[—;]/, `${source} ${unfinished}`);
    }
  }
});

test('the saved fix: missing parts are null, and a damaged one is ignored', () => {
  const bare = makeSavedFix({ fix: { lat: 1, lon: 2 }, rocketId: '7', fixMs: 1000, savedMs: 1001 });
  assert.equal(bare.altMsl, null);
  assert.equal(bare.aglM, null);
  assert.equal(bare.groundStation, null);
  assert.equal(bare.packetMs, 1000, 'with no packet time, the fix\'s own');
  assert.equal(bare.quality, 'good');
  assert.equal(bare.sats, null);
  assert.equal(bare.hdop, null);
  assert.equal(bare.weak, null);
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

// ------------------------------------------------------------------
// Which fix the readout shows (pickFix), from the crumbs the page's own
// parser, feed and store make
// ------------------------------------------------------------------

// A receiver PKT line, as the radio board receiver prints one.
function pktLine({ seq, t, lat, lon, alt = 80, sats = 12, hdop = 0.9, fix = 'yes', node = 1 }) {
  return `PKT node=${node} seq=${seq} up_s=${t.toFixed(1)} fix=${fix} sats=${sats} hdop=${hdop.toFixed(2)} lat=${lat.toFixed(7)} lon=${lon.toFixed(7)} alt_m=${alt.toFixed(2)} spd_mps=0.10 crs_deg=90.00 utc=12:00:00.000 airborne=no rssi_dbm=-80.0 snr_db=10.00 missed=0`;
}

// The live path in Node: the source detector, the receiver's parser, the
// flight feed and the flight store. send() is the receiver's status line
// and one packet, a second after the last. lines and times are what the
// recorder would have kept of them.
function liveFlight() {
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight, groundStation: typedStation(FIELD) });
  const state = { ms: 1795300000000, seq: 0, t: 100 };
  const feed = createFlightFeed({ store, clock: () => state.ms, every: null });
  const detector = createSourceDetector();
  const lines = [];
  const times = [];
  const push = (line) => {
    lines.push(line);
    times.push(state.ms);
    const source = detector.push(line);
    if (source?.mode === 'flight') {
      feed.noteLine(line);
      feed.push(source.parse(line), state.ms);
    }
  };
  return {
    store,
    lines,
    times,
    get ms() { return state.ms; },
    rocket: (id = '1') => store.getRocket(id),
    send(fields) {
      state.ms += 1000;
      push(`# DEKEL_RX listening good=${state.seq} bad=0 last_good_s_ago=0.9 rx_up_s=${state.t.toFixed(1)}`);
      push(pktLine({ seq: state.seq++, t: state.t++, ...fields }));
      return state.ms;
    },
    // Nothing arrives for a while.
    wait(ms) {
      state.ms += ms;
      feed.tick();
    },
    // The rocket's packets are lost for this many seconds. Its own clock
    // and its packet numbers go on, as they do on a real board.
    gap(seconds) {
      state.ms += seconds * 1000;
      state.t += seconds;
      state.seq += seconds;
      feed.tick();
    },
  };
}

// What the panel's readout says for a rocket, worked out from pickFix() and
// the store the way js/launch/launch-panel.js does.
function readout(flight, rocket = flight.rocket()) {
  const { store } = flight;
  const pick = pickFix(rocket.crumbs);
  if (!pick.main) return { pick, state: null, coords: '' };
  const state = fixState({
    source: 'live',
    fixAgeS: store.ageOf(pick.main.t),
    silent: store.isSilent(rocket),
    fixNow: store.hasFixNow(rocket),
    staleS: config.LINK_STALE_S,
    quality: pick.quality,
    newest: pick.newest,
    skipped: pick.skipped,
    heldNewest: pick.heldNewest,
  });
  return { pick, state, coords: coordsText(pick.main) };
}

const PAD = { lat: 44.8261, lon: -73.1702 };
const WEAK = { sats: 4, hdop: 5.2 };

test('one packet 50 km away never takes the readout', () => {
  const flight = liveFlight();
  for (let i = 0; i < 10; i++) flight.send({ lat: PAD.lat + i * 1e-6, lon: PAD.lon });
  const lastGood = coordsText({ lat: PAD.lat + 9e-6, lon: PAD.lon });
  let r = readout(flight);
  assert.equal(r.state.headline, 'CURRENT FIX');
  assert.equal(r.coords, lastGood);
  assert.deepEqual([r.pick.quality, r.pick.weak, r.pick.newest, r.pick.skipped], ['good', null, true, false]);

  const far = destinationPoint(PAD.lat, PAD.lon, 80, 50000);
  flight.send({ lat: far.lat, lon: far.lon });
  const rocket = flight.rocket();
  // The store's own lastGoodFix takes the far packet, as it always has (the
  // normal page is unchanged). That is why the panel doesn't read it.
  assert.ok(Math.abs(rocket.lastGoodFix.lat - far.lat) < 1e-6);
  assert.equal(rocket.crumbs.at(-1).quality, 'outlier', 'the trail leaves it out, and so does the readout');
  r = readout(flight);
  assert.equal(r.coords, lastGood, 'the readout still shows the last good fix');
  assert.deepEqual([r.pick.newest, r.pick.skipped], [false, true]);
  assert.equal(r.state.old, true, 'and no longer calls it current');
  assert.equal(r.state.why, 'jump');
  assert.equal(r.state.headline, 'OLD FIX, FROM 0:01 AGO');
  // What would be saved is the good fix, never the far one.
  const saved = makeSavedFix({ fix: r.pick.main, quality: r.pick.quality, weak: r.pick.weak, rocketId: 1, fixMs: flight.ms - 1000, packetMs: flight.ms });
  assert.equal(coordsText(saved), lastGood);
  assert.equal(saved.weak, null);

  // The next good packet is current again.
  flight.send({ lat: PAD.lat, lon: PAD.lon });
  r = readout(flight);
  assert.equal(r.state.headline, 'CURRENT FIX');
  assert.equal(r.coords, coordsText(PAD));
});

test('a packet at 0, 0 never takes the readout, later or first', () => {
  const flight = liveFlight();
  for (let i = 0; i < 5; i++) flight.send({ lat: PAD.lat, lon: PAD.lon });
  flight.send({ lat: 0, lon: 0, alt: 0 });
  assert.equal(flight.rocket().lastGoodFix.lat, 0, 'the store took it');
  let r = readout(flight);
  assert.equal(r.coords, coordsText(PAD));
  assert.equal(r.state.why, 'jump');
  // A weak one at 0, 0 doesn't show under the good fix either.
  flight.send({ lat: 0, lon: 0, alt: 0, ...WEAK });
  assert.equal(flight.rocket().crumbs.at(-1).quality, 'weak');
  r = readout(flight);
  assert.equal(r.pick.weak, null);
  assert.equal(r.coords, coordsText(PAD));

  // As the very first packet the trail has nothing to measure it against
  // and grades it good. The readout still leaves it out.
  const fresh = liveFlight();
  fresh.send({ lat: 0, lon: 0, alt: 0 });
  assert.equal(fresh.rocket().crumbs[0].quality, 'good');
  assert.equal(pickFix(fresh.rocket().crumbs).main, null);
  assert.equal(readout(fresh).coords, '');
  // The real fixes that follow are jumps from 0, 0 to the trail, until three agree.
  fresh.send({ lat: PAD.lat, lon: PAD.lon });
  fresh.send({ lat: PAD.lat, lon: PAD.lon });
  assert.equal(pickFix(fresh.rocket().crumbs).main, null, 'two real fixes: still nothing shown, and never 0, 0');
  fresh.send({ lat: PAD.lat, lon: PAD.lon });
  r = readout(fresh);
  assert.equal(r.coords, coordsText(PAD));
  assert.equal(r.state.headline, 'CURRENT FIX');
});

test('a weak fix after good ones shows under the good fix, and is saved with it', () => {
  const flight = liveFlight();
  let goodMs = 0;
  for (let i = 0; i < 5; i++) goodMs = flight.send({ lat: PAD.lat, lon: PAD.lon });
  const spot = destinationPoint(PAD.lat, PAD.lon, 120, 35);
  let weakMs = 0;
  for (let i = 0; i < 3; i++) weakMs = flight.send({ lat: spot.lat, lon: spot.lon, ...WEAK });
  let r = readout(flight);
  assert.equal(r.coords, coordsText(PAD), 'the big readout stays on the good fix');
  assert.equal(r.pick.quality, 'good');
  assert.equal(coordsText(r.pick.weak), coordsText(spot), 'the weak fix goes under it');
  assert.deepEqual([r.pick.newest, r.pick.skipped], [false, false]);
  assert.equal(r.state.why, 'no-fix', 'the good fix is not the newest, so it is not current');
  assert.equal(r.state.headline, 'OLD FIX, FROM 0:03 AGO');
  assert.equal(r.state.detail, 'Packets still arrive, but without a good GPS fix.');
  assert.equal(qualityWords(r.pick.weak), '4 SATS, HDOP 5.20');
  const apart = measureFrom(r.pick.main, r.pick.weak).rangeM;
  assert.ok(Math.abs(apart - 35) < 0.5, `${apart} m from the good fix`);
  assert.equal(`${qualityWords(r.pick.weak)}, ${distanceWords(apart)} FROM THE GOOD FIX`, '4 SATS, HDOP 5.20, 35 M FROM THE GOOD FIX');

  // The saved record keeps both, each with its own time.
  const record = makeSavedFix({
    fix: r.pick.main, quality: r.pick.quality, weak: { ...r.pick.weak, fixMs: weakMs }, rocketId: 1, fixMs: goodMs, packetMs: weakMs, savedMs: weakMs,
  });
  assert.equal(coordsText(record), coordsText(PAD));
  assert.equal(coordsText(record.weak), coordsText(spot));
  assert.deepEqual([record.fixMs, record.weak.fixMs, record.packetMs], [goodMs, weakMs, weakMs]);
  assert.deepEqual([record.weak.sats, record.weak.hdop], [4, 5.2]);
  assert.deepEqual(readSavedFix(JSON.stringify(record)), record);

  // A weak fix is not tested for jumps (the trail doesn't either), so one
  // far away still shows there, with how far it is.
  const far = destinationPoint(PAD.lat, PAD.lon, 80, 50000);
  flight.send({ lat: far.lat, lon: far.lon, ...WEAK });
  r = readout(flight);
  assert.equal(r.coords, coordsText(PAD));
  assert.equal(distanceWords(measureFrom(r.pick.main, r.pick.weak).rangeM), '50.00 KM');

  // A good fix again: it is current, and the weak line goes.
  flight.send({ lat: PAD.lat, lon: PAD.lon + 1e-5 });
  r = readout(flight);
  assert.equal(r.pick.weak, null);
  assert.equal(r.state.headline, 'CURRENT FIX');
  assert.equal(r.coords, coordsText({ lat: PAD.lat, lon: PAD.lon + 1e-5 }));
});

test('with weak fixes only, the newest one takes the main readout, named a weak fix', () => {
  const flight = liveFlight();
  let ms = 0;
  for (let i = 0; i < 4; i++) ms = flight.send({ lat: PAD.lat + i * 1e-5, lon: PAD.lon, ...WEAK });
  let r = readout(flight);
  const newest = coordsText({ lat: PAD.lat + 3e-5, lon: PAD.lon });
  assert.equal(r.coords, newest, 'never "no fix" while a position exists');
  assert.deepEqual([r.pick.quality, r.pick.weak, r.pick.newest], ['weak', null, true]);
  assert.equal(r.state.headline, 'CURRENT WEAK FIX');
  assert.equal(r.state.detail, 'No good fix was heard, only this weak one. It may be off.');
  const record = makeSavedFix({ fix: r.pick.main, quality: r.pick.quality, weak: r.pick.weak, rocketId: 1, fixMs: ms, packetMs: ms });
  assert.equal(record.quality, 'weak');
  assert.equal(coordsText(record), newest, 'COPY COORDINATES and the saved fix use it');
  assert.deepEqual([record.sats, record.hdop, record.weak], [4, 5.2, null]);

  // Packets stop: it stays, as an old weak fix.
  flight.wait(95000);
  r = readout(flight);
  assert.equal(r.coords, newest);
  assert.equal(r.state.headline, 'OLD WEAK FIX, FROM 1:35 AGO');
  assert.match(r.state.detail, /^Packets from the rocket have stopped\./);

  // The first good fix takes the readout over.
  flight.send({ lat: PAD.lat, lon: PAD.lon });
  r = readout(flight);
  assert.deepEqual([r.pick.quality, r.pick.weak], ['good', null]);
  assert.equal(r.coords, coordsText(PAD));
  assert.equal(r.state.headline, 'CURRENT FIX');
});

test('a real move takes over after a few fixes that agree', () => {
  const flight = liveFlight();
  for (let i = 0; i < 5; i++) flight.send({ lat: PAD.lat, lon: PAD.lon });
  const there = destinationPoint(PAD.lat, PAD.lon, 200, 50000);
  flight.send({ lat: there.lat, lon: there.lon });
  assert.equal(readout(flight).coords, coordsText(PAD), 'one far fix: not yet');
  flight.send({ lat: there.lat + 1e-6, lon: there.lon });
  assert.equal(readout(flight).coords, coordsText(PAD), 'two: not yet');
  flight.send({ lat: there.lat + 2e-6, lon: there.lon });
  let r = readout(flight);
  assert.equal(r.coords, coordsText({ lat: there.lat + 2e-6, lon: there.lon }), 'three that agree: the readout moves');
  assert.equal(r.state.headline, 'CURRENT FIX');
  flight.send({ lat: there.lat + 3e-6, lon: there.lon });
  r = readout(flight);
  assert.equal(r.coords, coordsText({ lat: there.lat + 3e-6, lon: there.lon }));
  assert.equal(r.state.headline, 'CURRENT FIX');
});

// ------------------------------------------------------------------
// A position out of reach of the last trusted fix. The trail takes it as
// good after a few seconds without packets (anything under 600 m/s), so
// the readout has its own rule.
// ------------------------------------------------------------------

test('how far a rocket can be from its last fix', () => {
  assert.deepEqual([REACH_SPEED_MPS, REACH_FLOOR_M, REACH_MAX_M, CONFIRM_FIXES], [50, 300, 10000, config.OUTLIER_RESET_FIXES]);
  assert.equal(reachM(1), 300, 'a second apart: the floor');
  assert.equal(reachM(6), 300);
  assert.equal(reachM(7), 350);
  assert.equal(reachM(20), 1000);
  assert.equal(reachM(100), 5000);
  assert.equal(reachM(200), 10000);
  assert.equal(reachM(3600), 10000, 'never more than the cap, however long the silence');
  for (const odd of [0, -5, NaN, null, undefined, Infinity]) assert.equal(reachM(odd), 300, `${odd}`);
  // Over the ground only: a rocket 3 km straight up is not far.
  const up = { lat: PAD.lat, lon: PAD.lon, altMsl: 3080 };
  assert.equal(isFar({ ...PAD, altMsl: 80 }, up, 5), false);
  const east = (m) => destinationPoint(PAD.lat, PAD.lon, 90, m);
  assert.equal(isFar(PAD, east(299), 1), false);
  assert.equal(isFar(PAD, east(301), 1), true);
  assert.equal(isFar(PAD, east(3000), 6), true);
  assert.equal(isFar(PAD, east(3000), 61), false, 'a minute under a parachute in a gale');
  assert.equal(isFar(PAD, east(10001), 3600), true);
});

// What the skeptic sent: good fixes, a stretch with no packets, then one
// packet with fix=yes and 12 satellites that is far away.
for (const [quietS, km] of [[6, 3], [20, 10], [100, 50]]) {
  test(`${quietS} s without packets, then one packet ${km} km away: it never takes the readout`, () => {
    const flight = liveFlight();
    let goodMs = 0;
    for (let i = 0; i < 6; i++) goodMs = flight.send({ lat: PAD.lat, lon: PAD.lon });
    flight.gap(quietS);
    const far = destinationPoint(PAD.lat, PAD.lon, 80, km * 1000);
    const farMs = flight.send({ lat: far.lat, lon: far.lon });
    const rocket = flight.rocket();
    assert.equal(rocket.crumbs.at(-1).quality, 'good', 'the trail takes it: it is under 600 m/s from the last fix');
    let r = readout(flight);
    assert.equal(r.coords, coordsText(PAD), 'the readout stays on the last trusted fix');
    assert.equal(coordsText(r.pick.held), coordsText(far), 'the far one is held, to show under it');
    assert.deepEqual([r.pick.quality, r.pick.newest, r.pick.skipped, r.pick.heldNewest, r.pick.weak], ['good', false, false, true, null]);
    assert.equal(r.state.old, true, 'never CURRENT FIX');
    assert.equal(r.state.why, 'far');
    assert.match(r.state.headline, /^OLD FIX, FROM \d+:\d\d AGO$/);
    assert.equal(r.state.detail, 'The newest position is far from this one. It shows below until the next fixes agree with it.');
    // What is saved: the good fix as the main one, the far one only as held.
    const saved = makeSavedFix({ fix: r.pick.main, quality: r.pick.quality, held: { ...r.pick.held, fixMs: farMs }, rocketId: 1, fixMs: goodMs, packetMs: farMs });
    assert.equal(coordsText(saved), coordsText(PAD));
    assert.equal(coordsText(saved.held), coordsText(far));
    assert.deepEqual([saved.fixMs, saved.held.fixMs, saved.packetMs, saved.weak], [goodMs, farMs, farMs, null]);
    assert.deepEqual(readSavedFix(JSON.stringify(saved)), saved);
    // On the lines under the readout, with how far it is.
    const below = underFix({ weak: null, held: { ...r.pick.held, ms: farMs } });
    assert.equal(below.kind, 'held');
    assert.equal(distanceWords(measureFrom(r.pick.main, below.fix).rangeM), km < 10 ? '3,000 M' : `${km}.00 KM`);

    // Packets stop again: still the good fix, and still not the far one.
    flight.wait(8000);
    r = readout(flight);
    assert.equal(r.coords, coordsText(PAD));
    assert.equal(r.state.why, 'no-packets');

    // The first true packet is current again. The trail calls it an outlier
    // (it measures from the far one), and the readout shows it all the same.
    flight.gap(1);
    flight.send({ lat: PAD.lat, lon: PAD.lon + 1e-5 });
    assert.equal(rocket.crumbs.at(-1).quality, 'outlier');
    r = readout(flight);
    assert.equal(r.coords, coordsText({ lat: PAD.lat, lon: PAD.lon + 1e-5 }), 'one true packet puts it right');
    assert.equal(r.state.headline, 'CURRENT FIX');
    assert.deepEqual([r.pick.held, r.pick.skipped, r.pick.newest], [null, false, true]);
    assert.doesNotMatch(r.state.detail, /too far/);
    // And so are the next ones, while the trail still catches up.
    for (let i = 2; i < 6; i++) {
      flight.send({ lat: PAD.lat, lon: PAD.lon + i * 1e-5 });
      r = readout(flight);
      assert.equal(r.coords, coordsText({ lat: PAD.lat, lon: PAD.lon + i * 1e-5 }), `true packet ${i}`);
      assert.equal(r.state.headline, 'CURRENT FIX', `true packet ${i}`);
    }
    assert.equal(rocket.crumbs.at(-1).quality, 'good', 'the trail is back with it');
  });
}

test('a far position after a gap takes over once three fixes agree, and one within reach at once', () => {
  // The rocket really is there: it came down 3 km away while nothing was heard.
  const flight = liveFlight();
  for (let i = 0; i < 6; i++) flight.send({ lat: PAD.lat, lon: PAD.lon });
  flight.gap(6);
  const there = destinationPoint(PAD.lat, PAD.lon, 80, 3000);
  flight.send({ lat: there.lat, lon: there.lon });
  let r = readout(flight);
  assert.deepEqual([r.coords, coordsText(r.pick.held), r.state.why], [coordsText(PAD), coordsText(there), 'far'], 'one: held');
  flight.send({ lat: there.lat, lon: there.lon + 1e-5 });
  r = readout(flight);
  assert.deepEqual([r.coords, coordsText(r.pick.held), r.state.why], [coordsText(PAD), coordsText({ lat: there.lat, lon: there.lon + 1e-5 }), 'far'], 'two: the newest is held');
  flight.send({ lat: there.lat, lon: there.lon + 2e-5 });
  r = readout(flight);
  assert.equal(r.coords, coordsText({ lat: there.lat, lon: there.lon + 2e-5 }), 'three that agree: the readout moves');
  assert.deepEqual([r.state.headline, r.pick.held, r.pick.agree], ['CURRENT FIX', null, 3]);

  // Two far packets in different places don't back each other.
  const lone = liveFlight();
  for (let i = 0; i < 6; i++) lone.send({ lat: PAD.lat, lon: PAD.lon });
  lone.gap(20);
  const a = destinationPoint(PAD.lat, PAD.lon, 80, 10000);
  const b = destinationPoint(PAD.lat, PAD.lon, 200, 9000);
  for (const p of [a, b, a, b, a, b]) {
    lone.send({ lat: p.lat, lon: p.lon });
    assert.equal(readout(lone).coords, coordsText(PAD));
  }
  lone.send({ lat: PAD.lat, lon: PAD.lon });
  assert.equal(readout(lone).state.headline, 'CURRENT FIX');

  // A weak fix after the held one shows under the readout in its place
  // (the newer of the two), and the held one can still be backed.
  const mixed = liveFlight();
  for (let i = 0; i < 6; i++) mixed.send({ lat: PAD.lat, lon: PAD.lon });
  mixed.gap(6);
  const heldMs = mixed.send({ lat: there.lat, lon: there.lon });
  const weakMs = mixed.send({ lat: PAD.lat, lon: PAD.lon, ...WEAK });
  r = readout(mixed);
  assert.deepEqual([r.coords, coordsText(r.pick.held), coordsText(r.pick.weak), r.pick.heldNewest, r.state.why],
    [coordsText(PAD), coordsText(there), coordsText(PAD), false, 'no-fix']);
  assert.equal(underFix({ weak: { ...r.pick.weak, ms: weakMs }, held: { ...r.pick.held, ms: heldMs } }).kind, 'weak');
  assert.equal(underFix({ weak: { ...r.pick.weak, ms: heldMs - 1 }, held: { ...r.pick.held, ms: heldMs } }).kind, 'held');
  assert.equal(underFix({ weak: null, held: null }), null);
  assert.equal(underFix(null), null);

  // Within reach is trusted at once: a minute of silence under a parachute,
  // 1.5 km downwind.
  const drift = liveFlight();
  for (let i = 0; i < 6; i++) drift.send({ lat: PAD.lat, lon: PAD.lon });
  drift.gap(60);
  const down = destinationPoint(PAD.lat, PAD.lon, 80, 1500);
  drift.send({ lat: down.lat, lon: down.lon });
  r = readout(drift);
  assert.deepEqual([r.coords, r.state.headline, r.pick.held], [coordsText(down), 'CURRENT FIX', null]);
  // And a rocket on the way up, 400 m higher each second, never counts as far.
  const up = liveFlight();
  for (let i = 0; i < 12; i++) {
    up.send({ lat: PAD.lat + i * 1e-4, lon: PAD.lon, alt: 80 + i * 400 });
    assert.equal(readout(up).state.headline, 'CURRENT FIX', `packet ${i}`);
  }
});

test('after a reload, the first fix heard never takes a saved good fix that it is far from', () => {
  const T = 1795300000000;
  const station = { lat: FIELD.lat, lon: FIELD.lon, typed: false };
  const kept = makeSavedFix({
    fix: { lat: PAD.lat, lon: PAD.lon, altMsl: 80, sats: 12, hdop: 0.9 }, rocketId: 1, rocketName: 'GPS and radio board',
    fixMs: T - 9000, packetMs: T - 9000, aglM: 0.4, groundStation: station, savedMs: T - 9000,
  });
  // What the panel makes of a new store's pick (recordOf() in launch-panel.js).
  const fresh = liveFlight();
  const times = new Map();
  const send = (fields) => {
    const ms = fresh.send(fields);
    times.set(fresh.rocket().crumbs.at(-1), ms);
    return ms;
  };
  const record = () => {
    const pick = pickFix(fresh.rocket().crumbs);
    const line = (crumb) => (crumb ? { ...crumb, fixMs: times.get(crumb) } : null);
    return {
      pick,
      record: makeSavedFix({ fix: pick.main, quality: pick.quality, weak: line(pick.weak), held: line(pick.held), rocketId: 1, fixMs: times.get(pick.main), packetMs: fresh.ms, savedMs: fresh.ms }),
    };
  };

  // The first packet after the reload is 50 km away. A new trail has nothing
  // to measure it against and takes it as good.
  const far = destinationPoint(PAD.lat, PAD.lon, 80, 50000);
  const farMs = send({ lat: far.lat, lon: far.lon });
  let now = record();
  assert.deepEqual([coordsText(now.record), now.pick.agree], [coordsText(far), 1]);
  let under = keepUnder(kept, now.record, now.pick.agree);
  assert.equal(coordsText(under), coordsText(PAD), 'the saved fix stays the main one');
  assert.deepEqual([under.quality, under.fixMs, under.altMsl, under.aglM, under.rocketName], ['good', T - 9000, 80, 0.4, 'GPS and radio board']);
  assert.equal(coordsText(under.held), coordsText(far), 'the new one goes under it, not confirmed');
  assert.deepEqual([under.held.fixMs, under.packetMs, under.weak], [farMs, farMs, null]);
  assert.deepEqual(readSavedFix(JSON.stringify(under)), under, 'and that is what storage gets');
  assert.equal(newerRecord(under, kept), true);
  assert.deepEqual(under, farUnderGood(kept, now.record, 1));

  // The rocket lies in the grass and only sends weak fixes, at the true spot.
  let weakMs = 0;
  for (let i = 0; i < 5; i++) weakMs = send({ lat: PAD.lat, lon: PAD.lon + 1e-5, ...WEAK });
  now = record();
  under = keepUnder(under, now.record, now.pick.agree);
  assert.equal(coordsText(under), coordsText(PAD), 'weak fixes never put the far one in the big readout');
  assert.equal(coordsText(under.held), coordsText(far));
  assert.equal(coordsText(under.weak), coordsText({ lat: PAD.lat, lon: PAD.lon + 1e-5 }));
  assert.deepEqual([under.fixMs, under.weak.fixMs, under.packetMs], [T - 9000, weakMs, weakMs]);
  // The weak fix is the newer of the two, so it is the one on the lines below.
  const below = underFix({ weak: { ...under.weak, ms: under.weak.fixMs }, held: { ...under.held, ms: under.held.fixMs } });
  assert.equal(below.kind, 'weak');
  assert.equal(distanceWords(measureFrom(under, below.fix).rangeM), '1 M');

  // Good fixes at the true spot: the trail calls the first two outliers
  // (it measures from the far one). The saved fix stays all the while, and
  // the third takes over as a live fix.
  for (let i = 0; i < 2; i++) {
    send({ lat: PAD.lat, lon: PAD.lon });
    now = record();
    under = keepUnder(under, now.record, now.pick.agree);
    assert.equal(coordsText(under), coordsText(PAD), `true packet ${i + 1}`);
  }
  send({ lat: PAD.lat, lon: PAD.lon });
  now = record();
  assert.deepEqual([coordsText(now.record), now.pick.agree], [coordsText(PAD), 3]);
  assert.equal(keepUnder(under, now.record, now.pick.agree), null, 'within reach of the saved fix: the live fix takes over');

  // When it does not apply.
  const farRecord = makeSavedFix({ fix: { lat: far.lat, lon: far.lon, altMsl: 80, sats: 12, hdop: 0.9 }, rocketId: 1, fixMs: T, packetMs: T });
  assert.notEqual(farUnderGood(kept, farRecord, 1), null);
  assert.notEqual(farUnderGood(kept, farRecord, 2), null);
  assert.equal(farUnderGood(kept, farRecord, 3), null, 'three fixes in a row back it: the rocket is there');
  assert.equal(farUnderGood(kept, { ...farRecord, rocketId: '2' }, 1), null, 'another rocket');
  assert.equal(farUnderGood(kept, { ...farRecord, test: true }, 1), null, 'a test capture\'s fix never joins a real one');
  assert.equal(farUnderGood({ ...kept, test: true }, farRecord, 1), null);
  assert.equal(farUnderGood({ ...kept, quality: 'weak' }, farRecord, 1), null, 'a weak fix holds nothing back');
  assert.equal(farUnderGood(kept, { ...farRecord, fixMs: T - 9001 }, 1), null, 'a fix from before the kept one');
  assert.equal(farUnderGood(null, farRecord, 1), null);
  assert.equal(farUnderGood(kept, null, 1), null);
  // Within reach for the time that passed: 9 s, 300 m and 450 m.
  const at = (m) => {
    const p = destinationPoint(PAD.lat, PAD.lon, 80, m);
    return makeSavedFix({ fix: { lat: p.lat, lon: p.lon }, rocketId: 1, fixMs: T, packetMs: T });
  };
  assert.equal(farUnderGood(kept, at(300), 1), null);
  assert.equal(farUnderGood(kept, at(449), 1), null);
  assert.notEqual(farUnderGood(kept, at(451), 1), null);
  // A good fix from another day holds nothing back.
  assert.notEqual(farUnderGood(kept, { ...farRecord, fixMs: T - 9000 + GOOD_STAYS_MS }, 1), null);
  assert.equal(farUnderGood(kept, { ...farRecord, fixMs: T - 9000 + GOOD_STAYS_MS + 1 }, 1), null);

  // The line under the saved fix says what was heard since.
  const FAR = 'The newest position is far from this one. It shows below until the next fixes agree with it.';
  assert.deepEqual(fixState({ source: 'reload', fixAgeS: 9, unfinished: false, farSince: true }),
    { old: true, why: 'reload', headline: 'SAVED FIX, FROM 0:09 AGO', detail: `Saved before the page was reloaded. ${FAR}` });
  assert.equal(fixState({ source: 'reload', fixAgeS: 9, farSince: true }).detail, `Saved before the page was reloaded. ${FAR}`, 'also before storage has answered');
  assert.equal(fixState({ source: 'reload', fixAgeS: 9, unfinished: false, farSince: true, weakSince: true }).detail,
    'Saved before the page was reloaded. Only weak fixes, and positions far from this one, have been heard since.');
  assert.equal(fixState({ source: 'reload', fixAgeS: 9, unfinished: true, farSince: true }).detail, 'The page closed suddenly. Press RECOVER to put the flight back on the live view.');
  assert.equal(fixState({ source: 'earlier', fixAgeS: 9, unfinished: true, farSince: true }).detail, `Saved earlier on this page. ${FAR}`);
  assert.equal(fixState({ source: 'tab', fixAgeS: 9, farSince: true }).detail, `Heard in another launch tab on this laptop. ${FAR}`);
  for (const source of ['reload', 'earlier', 'tab']) {
    for (const weakSince of [false, true]) {
      const st = fixState({ source, fixAgeS: 9, unfinished: false, farSince: true, weakSince });
      assert.doesNotMatch(`${st.headline} ${st.detail}`, /No newer fix|CURRENT|[—;]/, `${source} ${weakSince}`);
    }
  }
  // Live: quiet and an impossible jump come first, then far, then no fix.
  assert.equal(fixState({ source: 'live', fixAgeS: 9, fixNow: true, newest: false, heldNewest: true }).why, 'far');
  assert.equal(fixState({ source: 'live', fixAgeS: 9, silent: true, fixNow: false, newest: false, heldNewest: true }).why, 'no-packets');
  assert.equal(fixState({ source: 'live', fixAgeS: 9, fixNow: true, newest: false, skipped: true, heldNewest: true }).why, 'jump');
});

test('the saved fix: a fix that is not confirmed is kept under the good one', () => {
  const good = { lat: 44.83, lon: -73.16, altMsl: 60, sats: 11, hdop: 0.9 };
  const held = { lat: 44.9, lon: -72.5, altMsl: 58, sats: 12, hdop: 0.8, fixMs: 9000 };
  const record = makeSavedFix({ fix: good, held, rocketId: 1, fixMs: 5000, packetMs: 6000, savedMs: 9001 });
  assert.deepEqual(record.held, { lat: 44.9, lon: -72.5, altMsl: 58, sats: 12, hdop: 0.8, fixMs: 9000 });
  assert.deepEqual([record.lat, record.quality, record.weak, record.packetMs], [44.83, 'good', null, 9000]);
  assert.deepEqual(readSavedFix(JSON.stringify(record)), record);
  // One that is older than the good fix, or has no time or no position, is dropped.
  assert.equal(makeSavedFix({ fix: good, held: { ...held, fixMs: 4000 }, fixMs: 5000 }).held, null);
  assert.equal(makeSavedFix({ fix: good, held: { ...held, fixMs: undefined }, fixMs: 5000 }).held, null);
  assert.equal(makeSavedFix({ fix: good, held: { ...held, lat: 'x' }, fixMs: 5000 }).held, null);
  assert.equal(readSavedFix(JSON.stringify({ ...record, held: 'nonsense' })).held, null);
  // Nothing goes under a weak main fix.
  assert.equal(makeSavedFix({ fix: good, quality: 'weak', held, fixMs: 5000 }).held, null);
  // A record saved before held existed reads with none.
  const older = { ...record };
  delete older.held;
  assert.equal(readSavedFix(JSON.stringify(older)).held, null);
  // It counts as news of the rocket, like a weak fix does.
  const plain = makeSavedFix({ fix: good, rocketId: 1, fixMs: 5000, packetMs: 6000 });
  assert.equal(newerRecord(record, plain), true);
  assert.equal(newerRecord(plain, record), false);
});

test('two boards: the other rockets\' saved fixes have their own list in storage', () => {
  assert.equal(SAVED_OTHERS_KEY, 'fc-launch-other-fixes');
  assert.notEqual(SAVED_OTHERS_KEY, SAVED_FIX_KEY);
  const make = (rocketId, fixMs, extra = {}) => makeSavedFix({ fix: { lat: 44.8 + Number(rocketId) / 100, lon: -73.1 }, rocketId, fixMs, packetMs: fixMs, savedMs: fixMs, ...extra });
  const list = [make(1, 1000), make(2, 3000), make(3, 2000)];
  assert.deepEqual(readOtherFixes(JSON.stringify(list)).map((r) => r.rocketId), ['2', '3', '1'], 'the newest first');
  assert.deepEqual(readOtherFixes(JSON.stringify(list))[0], list[1], 'each is a saved fix like any other');
  // One for each rocket, the newest. A test capture's fix is never among them.
  const again = [make(1, 1000), make(1, 5000), make(2, 3000), make(4, 9000, { test: true })];
  const read = readOtherFixes(JSON.stringify(again));
  assert.deepEqual(read.map((r) => [r.rocketId, r.fixMs]), [['1', 5000], ['2', 3000]]);
  // Only the newest few.
  const many = [1, 2, 3, 4, 5, 6].map((id) => make(id, id * 1000));
  assert.equal(OTHERS_MAX, 3);
  assert.deepEqual(readOtherFixes(JSON.stringify(many)).map((r) => r.rocketId), ['6', '5', '4']);
  // Missing or damaged text is an empty list, and a damaged record is skipped.
  for (const bad of [null, undefined, '', 'not json [', '{"v":2}', '"text"', '7']) assert.deepEqual(readOtherFixes(bad), []);
  assert.deepEqual(readOtherFixes(JSON.stringify([null, 5, 'x', { v: 99 }, { ...list[0], lat: 'north' }, list[2]])).map((r) => r.rocketId), ['3']);
});

test('pickFix only looks at new crumbs, and starts over when a trail does', () => {
  // Crumb n, a second and about a meter after crumb n - 1. The outlier is
  // one the trail measured against crumb 1 (a jump in height, say).
  const crumb = (quality, n) => ({ t: n, n, lat: 44.8 + n * 1e-5, lon: -73, altMsl: 10, sats: 9, hdop: 1, quality });
  const crumbs = [crumb('good', 1), crumb('weak', 2)];
  assert.equal(pickFix(crumbs).main.n, 1);
  assert.equal(pickFix(crumbs).weak.n, 2);
  crumbs.push(crumb('outlier', 3));
  assert.deepEqual([pickFix(crumbs).main.n, pickFix(crumbs).weak.n, pickFix(crumbs).skipped], [1, 2, true]);
  crumbs.push(crumb('good', 4));
  assert.deepEqual([pickFix(crumbs).main.n, pickFix(crumbs).weak, pickFix(crumbs).newest], [4, null, true]);
  // The trail was emptied and filled again (track.js's reset()).
  crumbs.length = 0;
  crumbs.push(crumb('weak', 5), crumb('weak', 6), crumb('weak', 7), crumb('weak', 8));
  assert.deepEqual([pickFix(crumbs).main.n, pickFix(crumbs).quality], [8, 'weak']);
  // A position that is not on the Earth is never picked.
  crumbs.push({ ...crumb('good', 9), lat: 95 });
  assert.equal(pickFix(crumbs).main.n, 8);
  assert.deepEqual(pickFix(null), { main: null, quality: null, weak: null, held: null, newest: false, skipped: false, heldNewest: false, agree: 0 });
  assert.equal(pickFix([]).main, null);
});

// ------------------------------------------------------------------
// After a crash: the last fix read back out of the recording
// ------------------------------------------------------------------

test('after a crash, the last fix is read out of the recording with its line\'s own time', async () => {
  const flight = liveFlight();
  for (let i = 0; i < 30; i++) flight.send({ lat: PAD.lat + i * 1e-5, lon: PAD.lon, alt: 80 + i });
  const last = { lat: PAD.lat + 29e-5, lon: PAD.lon };
  const station = { lat: FIELD.lat, lon: FIELD.lon, typed: false };
  const record = await lastFixInLines(flight.lines, flight.times, { groundStation: station });
  assert.equal(coordsText(record), coordsText(last));
  assert.equal(record.altMsl, 109);
  assert.equal(record.fixMs, flight.times.at(-1), 'the fix\'s time is when its own line arrived');
  assert.equal(record.packetMs, flight.times.at(-1));
  assert.deepEqual([record.rocketId, record.quality, record.weak, record.test], ['1', 'good', null, false]);
  assert.deepEqual([record.sats, record.hdop], [12, 0.9]);
  assert.deepEqual(record.groundStation, station);
  // It is what the live readout showed.
  assert.equal(coordsText(record), readout(flight).coords);

  // The copy Chrome had put on the disk is from 40 s before the crash (or
  // missing): the recording's fix is newer and takes its place.
  const stale = makeSavedFix({ fix: { lat: PAD.lat, lon: PAD.lon }, rocketId: 1, fixMs: flight.times.at(-1) - 40000, packetMs: flight.times.at(-1) - 40000 });
  assert.equal(newerRecord(record, stale), true);
  assert.equal(newerRecord(record, null), true);
  // The same packet in both: the recording has nothing newer.
  const same = makeSavedFix({ fix: last, rocketId: 1, fixMs: flight.times.at(-1), packetMs: flight.times.at(-1) });
  assert.equal(newerRecord(record, same), false);

  // The same rule as the readout. A far packet at the very end is left out,
  // and the fix keeps its own line's time, not the last packet's.
  const far = destinationPoint(PAD.lat, PAD.lon, 80, 50000);
  const goodMs = flight.times.at(-1);
  const farMs = flight.send({ lat: far.lat, lon: far.lon });
  const afterJump = await lastFixInLines(flight.lines, flight.times);
  assert.equal(coordsText(afterJump), coordsText(last));
  assert.deepEqual([afterJump.fixMs, afterJump.packetMs], [goodMs, farMs]);
  // A weak fix after it is kept next to the good one.
  const spot = destinationPoint(last.lat, last.lon, 300, 20);
  const weakMs = flight.send({ lat: spot.lat, lon: spot.lon, ...WEAK });
  const withWeak = await lastFixInLines(flight.lines, flight.times);
  assert.equal(coordsText(withWeak), coordsText(last));
  assert.equal(coordsText(withWeak.weak), coordsText(spot));
  assert.deepEqual([withWeak.fixMs, withWeak.weak.fixMs, withWeak.packetMs], [goodMs, weakMs, weakMs]);
  assert.equal(coordsText(withWeak), readout(flight).coords);
  assert.equal(coordsText(withWeak.weak), coordsText(readout(flight).pick.weak));
});

test('lastFixInLines reads the end first, and goes further back for a good fix', async () => {
  const flight = liveFlight();
  for (let i = 0; i < 6; i++) flight.send({ lat: PAD.lat, lon: PAD.lon + i * 1e-5 });
  const good = { lat: PAD.lat, lon: PAD.lon + 5e-5 };
  const goodMs = flight.times.at(-1);
  // The rocket lies in the grass: 40 weak fixes, 80 lines.
  for (let i = 0; i < 40; i++) flight.send({ lat: PAD.lat + 2e-4, lon: PAD.lon + i * 1e-6, ...WEAK });
  const weak = { lat: PAD.lat + 2e-4, lon: PAD.lon + 39e-6 };
  const whole = await lastFixInLines(flight.lines, flight.times);
  // The last 10 lines hold only weak fixes, so it reads 40, then 160 (all of it).
  let pauses = 0;
  const fromEnd = await lastFixInLines(flight.lines, flight.times, { tailLines: 10, pause: async () => { pauses += 1; } });
  assert.deepEqual({ ...fromEnd, savedMs: 0 }, { ...whole, savedMs: 0 }, 'the same answer as reading all of it');
  assert.equal(coordsText(fromEnd), coordsText(good));
  assert.equal(fromEnd.fixMs, goodMs);
  assert.equal(coordsText(fromEnd.weak), coordsText(weak));
  assert.equal(fromEnd.weak.fixMs, flight.times.at(-1));
  assert.equal(pauses, 0, 'short recordings never pause');
  // A good fix inside the end is the answer at once.
  flight.send({ lat: PAD.lat, lon: PAD.lon });
  const atOnce = await lastFixInLines(flight.lines, flight.times, { tailLines: 10 });
  assert.equal(coordsText(atOnce), coordsText(PAD));
  assert.equal(atOnce.weak, null);

  // Weak fixes only, all the way back: the newest weak one.
  const grass = liveFlight();
  for (let i = 0; i < 20; i++) grass.send({ lat: PAD.lat, lon: PAD.lon + i * 1e-6, ...WEAK });
  const onlyWeak = await lastFixInLines(grass.lines, grass.times, { tailLines: 4 });
  assert.equal(onlyWeak.quality, 'weak');
  assert.equal(coordsText(onlyWeak), coordsText({ lat: PAD.lat, lon: PAD.lon + 19e-6 }));
  assert.equal(onlyWeak.fixMs, grass.times.at(-1));

  // A long recording hands the page back between pieces.
  const long = liveFlight();
  for (let i = 0; i < 1200; i++) long.send({ lat: PAD.lat, lon: PAD.lon });
  let breaks = 0;
  const longFix = await lastFixInLines(long.lines, long.times, { pause: async () => { breaks += 1; } });
  assert.equal(breaks, 2, '2,400 lines, a pause every 1,000');
  assert.equal(longFix.fixMs, long.times.at(-1));
});

test('lastFixInLines: no fix, no times, two rockets, and the capture file', async () => {
  assert.equal(await lastFixInLines([], []), null);
  assert.equal(await lastFixInLines(null, null), null);
  assert.equal(await lastFixInLines(['# DEKEL_RX listening good=0 bad=0 last_good_s_ago=0.9 rx_up_s=1.0', 'hello'], [1000, 2000]), null);
  // Packets, but none with a fix.
  const blind = liveFlight();
  for (let i = 0; i < 5; i++) blind.send({ lat: PAD.lat, lon: PAD.lon, fix: 'no', sats: 0, hdop: 99.9 });
  assert.equal(await lastFixInLines(blind.lines, blind.times), null);
  // Only a far packet and a 0, 0 packet: nothing to show (never 0, 0).
  const junk = liveFlight();
  junk.send({ lat: 0, lon: 0, alt: 0 });
  assert.equal(await lastFixInLines(junk.lines, junk.times), null);

  // A fix that can't be dated is no use. With a time for the recording, it gets that.
  const flight = liveFlight();
  for (let i = 0; i < 3; i++) flight.send({ lat: PAD.lat, lon: PAD.lon });
  assert.equal(await lastFixInLines(flight.lines, null), null);
  assert.equal((await lastFixInLines(flight.lines, null, { missingMs: 4242 })).fixMs, 4242);
  // A line with no time takes the time of the line before it.
  const holes = flight.times.map((t, i) => (i === flight.times.length - 1 ? null : t));
  assert.equal((await lastFixInLines(flight.lines, holes)).fixMs, flight.times.at(-2));

  // Two rockets on one receiver: the first one heard, or the one asked for.
  const two = liveFlight();
  two.send({ node: 1, lat: PAD.lat, lon: PAD.lon });
  two.send({ node: 2, lat: PAD.lat + 0.001, lon: PAD.lon });
  two.send({ node: 1, lat: PAD.lat, lon: PAD.lon });
  two.send({ node: 2, lat: PAD.lat + 0.001, lon: PAD.lon + 1e-5 });
  const first = await lastFixInLines(two.lines, two.times);
  assert.equal(first.rocketId, '1');
  assert.equal(first.fixMs, two.times.at(-3));
  const second = await lastFixInLines(two.lines, two.times, { prefer: '2' });
  assert.equal(second.rocketId, '2');
  assert.equal(coordsText(second), coordsText({ lat: PAD.lat + 0.001, lon: PAD.lon + 1e-5 }));
  assert.equal(second.fixMs, two.times.at(-1));
  assert.equal((await lastFixInLines(two.lines, two.times, { prefer: '9' })).rocketId, '1', 'a rocket that isn\'t in it falls back');

  // The receiver capture, as a recording: its last PKT line.
  const lines = readFileSync(new URL('./radio-board-rx-capture.log', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
  const times = lines.map((_, i) => 1795300000000 + i * 500);
  const lastPkt = lines.map((l) => l.startsWith('PKT ')).lastIndexOf(true);
  const fromCapture = await lastFixInLines(lines, times, { storeOptions: { groundStation: typedStation(FIELD) } });
  assert.equal(coordsText(fromCapture), '35.123270, -117.123379');
  assert.equal(fromCapture.altMsl, 73.2);
  assert.equal(fromCapture.fixMs, times[lastPkt]);
  assert.equal(fromCapture.packetMs, times[lastPkt]);
});

test('after a crash on a second connection, a recording with only weak fixes keeps the good fix from the first', async () => {
  // Connection 1: the flight, good fixes, then the cable is pulled (its
  // recording is saved). Connection 2 on the same page: the rocket lies in
  // the grass and only weak fixes come in. Then Chrome is killed.
  const flight = liveFlight();
  let goodMs = 0;
  for (let i = 0; i < 6; i++) goodMs = flight.send({ lat: PAD.lat, lon: PAD.lon + i * 1e-5 });
  const good = { lat: PAD.lat, lon: PAD.lon + 5e-5 };
  const secondStarts = flight.lines.length;
  // To 7 decimals, as the receiver prints a position.
  const there = destinationPoint(good.lat, good.lon, 60, 25);
  const spot = { lat: Number(there.lat.toFixed(7)), lon: Number(there.lon.toFixed(7)) };
  let weakMs = 0;
  for (let i = 0; i < 8; i++) weakMs = flight.send({ lat: spot.lat, lon: spot.lon, ...WEAK });
  // What the page saved while it ran (the store kept the first connection's crumbs).
  const live = readout(flight);
  const saved = makeSavedFix({ fix: live.pick.main, quality: live.pick.quality, weak: { ...live.pick.weak, fixMs: weakMs - 3000 }, rocketId: 1, fixMs: goodMs, packetMs: weakMs - 3000 });
  assert.equal(coordsText(saved), coordsText(good));
  // The unfinished recording is the second connection's only.
  const fromRecording = await lastFixInLines(flight.lines.slice(secondStarts), flight.times.slice(secondStarts));
  assert.equal(fromRecording.quality, 'weak', 'the recording itself has no good fix');
  assert.equal(coordsText(fromRecording), coordsText(spot));
  assert.equal(newerRecord(fromRecording, saved), true, 'it is newer, and on its own it would take the good fix\'s place');
  // The panel keeps the good fix and puts the recording's weak fix under it.
  const kept = weakUnderGood(saved, fromRecording);
  assert.equal(coordsText(kept), coordsText(good));
  assert.equal(kept.fixMs, goodMs);
  assert.equal(coordsText(kept.weak), coordsText(spot));
  assert.deepEqual([kept.weak.fixMs, kept.packetMs], [weakMs, weakMs]);
  assert.equal(newerRecord(kept, saved), true);
});
