// Checks the radio board receiver end to end, without a page: the source
// detector (js/live/sources.js), its parser, and the flight feed
// (js/live/flight-feed.js) that puts the samples in the store and keeps
// the store's clock moving.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/radio-board-rx.test.mjs
//
// THE SESSION BELOW IS HAND-BUILT, not captured from a board. It follows
// the print code in DEKEL_RX_FIRMWARE's src/main_rx.cpp line for line
// (which prints the same PKT and BAD lines as DOGTOOTH_V1_FIRMWARE's
// src/main_bench_rx.cpp), because the receiver firmware had not run on
// hardware when this was written (2026-11-16). After the first real
// session, save its raw output and swap it in here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, RECEIVER_MARKER, createSourceDetector } from '../js/live/sources.js';
import { createFlightFeed, readReceiverStatus, waitingNote, CLOCK_JUMP_S } from '../js/live/flight-feed.js';
import { LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import * as config from '../js/config.js';

const RECEIVER = SOURCES.find((s) => s.id === 'radio-board-rx');
const DOGTOOTH = SOURCES.find((s) => s.id === 'dogtooth-usb');

// ------------------------------------------------------------------
// The receiver's lines
// ------------------------------------------------------------------

// What the receiver prints each time the page opens the port.
const HEADER = [
  '',
  '# DEKEL_RX_FIRMWARE receiver for Dogtooth telemetry (receive only)',
  '# Board: RadioB_V1_Dekel (ATSAMD51J19A + SX1262)',
  '# Built: Nov 16 2026 22:41:07',
  '# Radio settings: 909.000 MHz, BW 125.0 kHz, SF9, CR 4/7, sync 0x12, preamble 8, CRC on, explicit header',
  '# Radio status: listening',
];

const STATUS_NO_PACKETS = '# DEKEL_RX listening good=0 bad=0 rx_up_s=5.0';
const STATUS_LISTENING = '# DEKEL_RX listening good=12 bad=3 last_good_s_ago=0.4 rx_up_s=73.0';
const STATUS_FAILED = '# DEKEL_RX radio-failed error=-2 good=0 bad=0 rx_up_s=5.0';

// One PKT line the way printPacket() writes it. `over` swaps values in.
function pktLine(over = {}) {
  const v = {
    node: 1, seq: 42, up_s: '12.3', fix: 'yes', sats: 9, hdop: '0.95',
    lat: '42.3386255', lon: '-71.0896268', alt_m: '17.30', spd_mps: '0.00', crs_deg: '0.00',
    utc: '12:34:56.780', airborne: 'yes', rssi_dbm: '-97.5', snr_db: '6.25', missed: 0,
    ...over,
  };
  const rebooted = v.REBOOTED ? ' REBOOTED' : '';
  return `PKT node=${v.node} seq=${v.seq} up_s=${v.up_s} fix=${v.fix} sats=${v.sats} hdop=${v.hdop} ` +
    `lat=${v.lat} lon=${v.lon} alt_m=${v.alt_m} spd_mps=${v.spd_mps} crs_deg=${v.crs_deg} ` +
    `utc=${v.utc} airborne=${v.airborne} rssi_dbm=${v.rssi_dbm} snr_db=${v.snr_db} missed=${v.missed}${rebooted}`;
}

const BAD_CRC = 'BAD reason=lora-crc len=34 rssi_dbm=-118.0 snr_db=-9.50';
const BAD_OTHER_RADIO = 'BAD reason=wrong-length len=12 rssi_dbm=-88.0 snr_db=9.75';
const BAD_CHECKSUM = 'BAD reason=bad-checksum len=34 rssi_dbm=-90.5 snr_db=8.00';

// ------------------------------------------------------------------
// A Dogtooth board on USB (it must never look like a receiver)
// ------------------------------------------------------------------
const DOGTOOTH_BANNER = '==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================';
const DOGTOOTH_LINES = [
  '',
  'DOGTOOTH_V1_FIRMWARE flight computer, Avionics GPS Radio v2 (SIMULATED GPS)',
  'Built Nov 13 2026 15:03:45',
  'SIM launch site: 35.1234567, -117.1234567, 700.0 m MSL (placeholder values in src/sim/SimGps.h)',
  'Radio: 909.000 MHz, BW 125.0 kHz, SF9, CR 4/7, sync 0x12, preamble 8, chip power -9 dBm',
  'Radio: OFF, held in reset. Packets are printed as hex and not transmitted.',
  'GPS',
  '  TARGET LOCK [GPS]: ------------------ LOCKED',
  '  LATITUDE: --------------------------- 42.3386255',
  'RADIO',
  '  RADIO PACKETS SENT: ----------------- 65',
  'Error: GPS has sent no data for 3 s',
  // From the PC sim's log (sim_output/pc_sim_flight.log): a real packet.
  'SIM PKT sim_s=0 phase=pad seq=0 len=34 hex=01 01 00 00 E8 03 00 00 07 0A 5A 00 06 6A EF 14 FA 60 30 BA 70 11 01 00 00 00 00 00 00 E8 6E 03 EA A0',
];

// A store like the page's flight store, a feed on a clock the test moves,
// and a helper that sends one line through the receiver's parser.
function setup() {
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight });
  let nowMs = 1_000_000;
  const feed = createFlightFeed({ store, clock: () => nowMs, every: null });
  return {
    store,
    feed,
    // Moves the computer's clock on.
    wait(seconds) { nowMs += seconds * 1000; },
    // One line arrives now.
    line(text) {
      feed.noteLine(text);
      return feed.push(RECEIVER.parse(text), nowMs);
    },
  };
}

// ------------------------------------------------------------------
// The source detector
// ------------------------------------------------------------------

test('the marker is the text the firmware prints', () => {
  // Config::kStatusMarker in DEKEL_RX_FIRMWARE's include/Config.h.
  assert.equal(RECEIVER_MARKER, '# DEKEL_RX');
  assert.equal(RECEIVER.name, 'Radio board receiver');
  assert.equal(RECEIVER.mode, 'flight');
});

test('the header, the status line or a PKT line each mean a receiver', () => {
  for (const first of [HEADER[1], STATUS_NO_PACKETS, STATUS_LISTENING, STATUS_FAILED, pktLine()]) {
    const d = createSourceDetector();
    assert.equal(d.push(''), null, 'a blank line says nothing');
    assert.equal(d.push(first)?.id, 'radio-board-rx', `"${first.slice(0, 30)}..." is a receiver`);
  }
});

test('the whole header finds the receiver at its first line with text', () => {
  const d = createSourceDetector();
  const found = HEADER.map((line) => d.push(line)?.id ?? null);
  assert.deepEqual(found, [null, 'radio-board-rx', 'radio-board-rx', 'radio-board-rx', 'radio-board-rx', 'radio-board-rx']);
  assert.equal(d.unknown, false);
});

test('BAD lines and other comment lines alone do not name the source', () => {
  const d = createSourceDetector();
  for (const line of [BAD_CRC, BAD_OTHER_RADIO, '# Radio status: listening', '# Board: something else']) {
    assert.equal(d.push(line), null);
  }
  // The status line comes within a second and settles it.
  assert.equal(d.push(STATUS_LISTENING)?.id, 'radio-board-rx');
});

test('a Dogtooth board on USB is never taken for a receiver', () => {
  for (const line of [...DOGTOOTH_LINES, DOGTOOTH_BANNER]) {
    assert.equal(RECEIVER.test(line), false, `"${line.slice(0, 40)}" is not a receiver line`);
  }
  // Its lines, then its banner: the detector waits, then says Dogtooth.
  const d = createSourceDetector();
  for (const line of DOGTOOTH_LINES) assert.equal(d.push(line), null);
  assert.equal(d.push(DOGTOOTH_BANNER)?.id, 'dogtooth-usb');
  // Once found, it stays Dogtooth, whatever comes later on this connection.
  assert.equal(d.push(DOGTOOTH_LINES.at(-1))?.id, 'dogtooth-usb');
});

test('the Dogtooth source comes first and never matches a receiver line', () => {
  assert.equal(SOURCES[0], DOGTOOTH);
  for (const line of [...HEADER, STATUS_LISTENING, STATUS_FAILED, pktLine(), BAD_CRC]) {
    assert.equal(DOGTOOTH.test(line), false);
  }
});

// ------------------------------------------------------------------
// The parser
// ------------------------------------------------------------------

test('a PKT line becomes a sample with the rocket ID from node=', () => {
  const out = RECEIVER.parse(pktLine({ node: 1, seq: 42, up_s: '12.3', alt_m: '123.45', spd_mps: '5.14', crs_deg: '123.45' }));
  assert.equal(out.kind, 'sample');
  const s = out.sample;
  assert.equal(s.rocketId, '1');
  assert.equal(s.t, 12.3);
  assert.equal(s.type, 'tlm');
  assert.deepEqual(s.gps, { fix: 1, sats: 9, hdop: 0.95, lat: 42.3386255, lon: -71.0896268, altMsl: 123.45, speed: 5.14, course: 123.45, stale: null });
  // The receiver's own measurements of the packet.
  assert.deepEqual(s.radio, { rssi: -97.5, snr: 6.25 });
  assert.equal(s.extra.seq, 42);
  assert.equal(s.extra.missed, 0);

  assert.equal(RECEIVER.parse(pktLine({ node: 7 })).sample.rocketId, '7');
});

test('a PKT line with no fix keeps its place in time and claims no position', () => {
  const s = RECEIVER.parse(pktLine({ fix: 'no', sats: 0, hdop: '?', lat: '0.0000000', lon: '0.0000000', alt_m: '0.00', utc: '--:--:--.---', airborne: 'no' })).sample;
  assert.equal(s.gps.fix, 0);
  assert.equal(s.gps.hdop, null);
  assert.equal(s.extra.utc, null);
});

test('BAD lines are bad packets, comment lines are ignored, SIM PKT is refused', () => {
  for (const line of [BAD_CRC, BAD_OTHER_RADIO, BAD_CHECKSUM]) {
    const out = RECEIVER.parse(line);
    assert.equal(out.kind, 'bad');
    assert.equal(out.damaged, true);
  }
  for (const line of [...HEADER, STATUS_NO_PACKETS, STATUS_LISTENING, STATUS_FAILED]) {
    assert.equal(RECEIVER.parse(line).kind, 'ignored', `"${line}" is not data`);
  }
  // A receiver never prints SIM PKT, so even a good one is not a packet here.
  assert.equal(RECEIVER.parse(DOGTOOTH_LINES.at(-1)).kind, 'ignored');
});

test('a PKT line cut short, or with a key the page does not know, is bad', () => {
  const whole = pktLine();
  assert.equal(RECEIVER.parse(whole.slice(0, whole.indexOf(' rssi_dbm'))).kind, 'bad');
  assert.equal(RECEIVER.parse(`${whole} extra_key=1`).kind, 'bad');
});

// ------------------------------------------------------------------
// The feed: a whole session
// ------------------------------------------------------------------

test('a session: header, status, packets, bad packets, and the samples in the store', () => {
  const { store, feed, wait, line } = setup();

  for (const text of HEADER) assert.equal(line(text), false);
  assert.equal(line(STATUS_NO_PACKETS), false);
  assert.equal(store.getRockets().length, 0, 'no rocket before the first packet');
  assert.equal(store.getNow(), null);

  // Ten packets, one a second, with other radios' packets in between.
  for (let i = 0; i < 10; i++) {
    wait(1);
    assert.equal(line(pktLine({ seq: 100 + i, up_s: (60 + i).toFixed(1), alt_m: (17.3 + i * 0.1).toFixed(2) })), true);
    if (i === 3) assert.equal(line(BAD_CRC), false);
    if (i === 6) assert.equal(line(BAD_OTHER_RADIO), false);
    line(`# DEKEL_RX listening good=${i + 1} bad=${i >= 6 ? 2 : i >= 3 ? 1 : 0} last_good_s_ago=0.0 rx_up_s=${(6 + i).toFixed(1)}`);
  }

  assert.deepEqual(feed.counts, { samples: 10, bad: 2, restarts: 0 });
  assert.equal(feed.receiver.state, 'listening');
  assert.equal(feed.receiver.good, 10);

  const rocket = store.getRocket('1');
  assert.ok(rocket, 'node=1 is rocket 1');
  assert.equal(store.getRockets().length, 1);
  assert.equal(rocket.samples.length, 10);
  // The first board heard keeps its own clock: up_s goes in unchanged.
  assert.equal(rocket.samples[0].t, 60);
  assert.equal(rocket.samples[9].t, 69);
  assert.equal(rocket.samples[9].extra.time_shift_s, undefined);
  assert.equal(store.getNow(), 69);
  assert.equal(store.getTotals().late, 0);
  // My board's name comes from fleet.js, since it sends node ID 1.
  assert.equal(rocket.profile.name, 'GPS and radio board');

  // The position and the receiver's signal readings reached the store.
  assert.equal(store.hasFixNow(rocket), true);
  assert.equal(rocket.lastGoodFix.lat, 42.3386255);
  assert.equal(rocket.lastGoodFix.lon, -71.0896268);
  assert.deepEqual(rocket.latestByGroup.radio.values, { rssi: -97.5, snr: 6.25 });
  assert.ok(rocket.sensorGroups.has('radio'));
});

test('the clock keeps moving between packets, so the views see the data go old', () => {
  const { store, feed, wait, line } = setup();
  wait(1);
  line(pktLine({ seq: 1, up_s: '100.0' }));
  const rocket = store.getRocket('1');
  assert.equal(store.getNow(), 100);
  assert.equal(store.isSilent(rocket), false);

  // Half a second later, with no new packet.
  wait(0.5);
  feed.tick();
  assert.equal(store.getNow(), 100.5);
  assert.equal(store.ageOf(rocket.lastPacketT), 0.5);
  assert.equal(store.isSilent(rocket), false);

  // The rocket goes out of range: after LINK_STALE_S the link is silent,
  // and nothing it last said counts as a fix now.
  wait(config.LINK_STALE_S);
  feed.tick();
  assert.equal(store.isSilent(rocket), true);
  assert.equal(store.hasFixNow(rocket), false);
  assert.equal(store.altitudeIsOld(rocket), true);

  // Its packets come back 20 s of board time later: the clock follows the
  // board again and the link is live.
  wait(14.5);
  line(pktLine({ seq: 21, up_s: '120.0', missed: 19 }));
  assert.equal(store.getNow(), 120);
  assert.equal(store.isSilent(rocket), false);
  assert.equal(store.hasFixNow(rocket), true);
});

test('a status line alone never moves the clock or adds a rocket', () => {
  const { store, feed, wait, line } = setup();
  for (let i = 0; i < 5; i++) { wait(1); line(STATUS_NO_PACKETS); feed.tick(); }
  assert.equal(store.getNow(), null);
  assert.equal(store.getRockets().length, 0);
});

test('REBOOTED: the flight board restarted, and its track carries on', () => {
  const { store, feed, wait, line } = setup();
  for (let i = 0; i < 5; i++) { wait(1); line(pktLine({ seq: 300 + i, up_s: (300 + i).toFixed(1) })); }
  assert.equal(store.getNow(), 304);

  // A brownout. The board is back 3 s later, 2.5 s into its new clock.
  wait(3);
  assert.equal(line(pktLine({ seq: 2, up_s: '2.5', REBOOTED: true })), true);
  wait(1);
  assert.equal(line(pktLine({ seq: 3, up_s: '3.5' })), true);

  const rocket = store.getRocket('1');
  assert.equal(feed.counts.restarts, 1);
  assert.equal(store.getTotals().late, 0, 'no packet was turned away as late');
  assert.equal(rocket.samples.length, 7, 'the track was not cleared');
  // The new times follow on from where the feed clock stood: 304 + 3 s.
  assert.equal(rocket.samples[5].t, 307);
  assert.equal(rocket.samples[6].t, 308);
  assert.equal(rocket.samples[5].extra.time_shift_s, 304.5);
  assert.equal(rocket.samples[5].extra.rebooted, 'yes');
  assert.equal(store.getNow(), 308);
  // Times never go backwards in the store.
  for (let i = 1; i < rocket.samples.length; i++) assert.ok(rocket.samples[i].t > rocket.samples[i - 1].t);
});

test('a clock that goes back without the REBOOTED word is followed the same way', () => {
  // The receiver itself restarted in the gap, so it never saw the old clock.
  const { store, feed, wait, line } = setup();
  wait(1); line(pktLine({ seq: 50, up_s: '50.0' }));
  wait(10); line(pktLine({ seq: 4, up_s: '4.0' }));
  assert.equal(feed.counts.restarts, 1);
  assert.equal(store.getRocket('1').samples.length, 2);
  assert.equal(store.getRocket('1').samples[1].t, 60);
  assert.equal(store.getTotals().late, 0);
});

test('a clock that leaps ahead of real time is put back on the feed clock', () => {
  // Another board with the same ID and a much longer uptime.
  const { store, feed, wait, line } = setup();
  wait(1); line(pktLine({ seq: 10, up_s: '10.0' }));
  wait(1); line(pktLine({ seq: 900, up_s: (11 + CLOCK_JUMP_S + 100).toFixed(1) }));
  assert.equal(feed.counts.restarts, 1);
  assert.equal(store.getRocket('1').samples[1].t, 11);
  assert.equal(store.getNow(), 11);
});

test('a long silence is not a restart: the board clock and real time agree', () => {
  const { store, feed, wait, line } = setup();
  wait(1); line(pktLine({ seq: 10, up_s: '10.0' }));
  wait(600); line(pktLine({ seq: 610, up_s: '610.0', missed: 599 }));
  assert.equal(feed.counts.restarts, 0);
  assert.equal(store.getRocket('1').samples[1].t, 610);
  assert.equal(store.getRocket('1').samples[1].extra.time_shift_s, undefined);
});

test('a second board joins the feed clock where it stands', () => {
  const { store, feed, wait, line } = setup();
  wait(1); line(pktLine({ node: 1, seq: 10, up_s: '500.0' }));
  // Board 2 powered up much later, so its own clock reads 30 s.
  wait(0.4); line(pktLine({ node: 2, seq: 3, up_s: '30.0' }));
  wait(0.6); line(pktLine({ node: 1, seq: 11, up_s: '501.0' }));
  wait(0.4); line(pktLine({ node: 2, seq: 4, up_s: '31.0' }));

  assert.equal(store.getRockets().length, 2);
  assert.equal(feed.counts.restarts, 0);
  const two = store.getRocket('2');
  assert.equal(two.samples.length, 2);
  assert.ok(Math.abs(two.samples[0].t - 500.4) < 1e-6);
  assert.ok(Math.abs(two.samples[1].t - 501.4) < 1e-6);
  assert.equal(two.samples[0].extra.time_shift_s, 470.4);
  assert.equal(store.getTotals().late, 0);
});

test('a new connection keeps the flight and forgets what the last receiver said', () => {
  const { store, feed, wait, line } = setup();
  wait(1); line(STATUS_FAILED);
  assert.equal(feed.receiver.state, 'radio-failed');
  wait(1); line(pktLine({ seq: 1, up_s: '9.0' }));
  feed.newConnection();
  assert.equal(feed.receiver, null);
  assert.equal(store.getRocket('1').samples.length, 1);
  wait(1); line(pktLine({ seq: 2, up_s: '10.0' }));
  assert.equal(store.getRocket('1').samples.length, 2);
});

// ------------------------------------------------------------------
// The status line and the note under the bar
// ------------------------------------------------------------------

test('the status line is read into numbers', () => {
  assert.deepEqual(readReceiverStatus(STATUS_LISTENING), { state: 'listening', good: 12, bad: 3, error: null, lastGoodAgoS: 0.4, rxUpS: 73 });
  assert.deepEqual(readReceiverStatus(STATUS_NO_PACKETS), { state: 'listening', good: 0, bad: 0, error: null, lastGoodAgoS: null, rxUpS: 5 });
  assert.deepEqual(readReceiverStatus(STATUS_FAILED), { state: 'radio-failed', good: 0, bad: 0, error: -2, lastGoodAgoS: null, rxUpS: 5 });
  for (const line of [...HEADER, pktLine(), BAD_CRC, DOGTOOTH_BANNER, '# DEKEL_RXlistening', '# DEKEL_RX something-else good=1']) {
    assert.equal(readReceiverStatus(line), null);
  }
});

test('before the first packet the page says the receiver is found and listening', () => {
  const { feed, wait, line } = setup();
  for (const text of HEADER) line(text);
  line(STATUS_NO_PACKETS);
  assert.deepEqual(waitingNote(feed, RECEIVER.name), {
    text: 'Radio board receiver found. It is listening, and no packets from the rocket have come in yet.',
    kind: 'info',
  });

  // Other radios on the field are heard and turned away.
  line(BAD_OTHER_RADIO);
  assert.match(waitingNote(feed, RECEIVER.name).text, /It heard 1 packet that was damaged or from another radio\.$/);
  line(BAD_CRC);
  assert.match(waitingNote(feed, RECEIVER.name).text, /It heard 2 packets that were damaged or from other radios\.$/);

  // The first packet: the HUD takes over and the note goes away.
  wait(1);
  line(pktLine());
  assert.deepEqual(waitingNote(feed, RECEIVER.name), { text: '', kind: 'info' });
});

test('a radio that did not start is a warning, with or without packets', () => {
  const { feed, wait, line } = setup();
  line(STATUS_FAILED);
  const note = waitingNote(feed, RECEIVER.name);
  assert.equal(note.kind, 'warn');
  assert.equal(note.text, 'Radio board receiver is connected, but its radio didn\'t start (error -2). It can\'t hear the rocket until that is fixed.');

  // It recovers (the firmware retries every 5 s), and the note follows.
  wait(5);
  line(STATUS_NO_PACKETS);
  assert.equal(waitingNote(feed, RECEIVER.name).kind, 'info');
});

test('the note text follows the site\'s writing rules', () => {
  const { feed, line } = setup();
  const texts = [waitingNote(feed, RECEIVER.name).text];
  line(BAD_CRC);
  texts.push(waitingNote(feed, RECEIVER.name).text);
  line(STATUS_FAILED);
  texts.push(waitingNote(feed, RECEIVER.name).text);
  for (const text of texts) {
    assert.doesNotMatch(text, /[—–;&]/, `no dashes, semicolons or "&" in "${text}"`);
    assert.doesNotMatch(text, /: /, `no colon phrases in "${text}"`);
  }
});
