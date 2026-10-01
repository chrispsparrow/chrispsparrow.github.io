// check_detection.mjs
// Prints the events detector.js finds in a library flight and, when the
// flight has simulated ground truth (a "phase" value), compares each event
// with the moment the simulator's phase really started.
//
// It flags an event that is more than --tolerance seconds (default 5) away
// from the truth, fires more than once, or never fires. The exit code is 1
// when anything is flagged, so it can run as a quick test.
//
// Run from the website folder:
//   node flight-console/tools/check_detection.mjs gps-board-sim-01
//   node flight-console/tools/check_detection.mjs gps-board-sim-01 --tolerance 3
//
// Used by: me, from the command line. Nothing in the page imports it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, buildFlight } from '../js/library.js';
import { detectAll, FLIGHT_EVENT_TYPES } from '../js/detector.js';
import { compareWithTruth, truthPhaseStarts } from '../js/truth-check.js';
import { DETECTOR_DEFAULTS } from '../js/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLIGHTS_DIR = path.resolve(HERE, '..', 'data', 'flights');

const argv = process.argv.slice(2);
const flightId = argv.find((a) => !a.startsWith('--'));
const tolIndex = argv.indexOf('--tolerance');
const tolerance = tolIndex !== -1 ? Number(argv[tolIndex + 1]) : 5;
if (!flightId || !Number.isFinite(tolerance)) {
  console.error('Usage: node flight-console/tools/check_detection.mjs <flight-id> [--tolerance seconds]');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(FLIGHTS_DIR, 'index.json'), 'utf8'));
const { flights, problems } = validateManifest(manifest);
for (const p of problems) console.log(`(manifest entry ${p.index + 1} skipped: ${p.reason})`);
const entry = flights.find((f) => f.id === flightId);
if (!entry) {
  console.error(`No valid flight with id "${flightId}". Known: ${flights.map((f) => f.id).join(', ') || 'none'}`);
  process.exit(2);
}

const texts = new Map();
for (const file of new Set(entry.rockets.map((r) => r.file))) {
  texts.set(file, fs.readFileSync(path.join(FLIGHTS_DIR, entry.id, file), 'utf8'));
}
const flight = buildFlight(entry, texts);

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : '--');

console.log(`Flight "${entry.title}" (${entry.kind}), id ${entry.id}`);
console.log(`Files: ${flight.files.map((f) => `${f.file} (${f.format}, ${f.sampleCount} samples, ${f.badRows} bad rows)`).join('; ')}`);
console.log('Thresholds:');
for (const [key, value] of Object.entries(DETECTOR_DEFAULTS)) console.log(`  ${key} = ${value}`);

let flagged = 0;
let anyTruth = false;
// Every rocket in the manifest, plus any other rocket ID the data holds
// (a file with several board IDs keeps them, and the page shows them all).
const rocketsToCheck = [...entry.rockets];
for (const s of flight.samples) {
  if (s.type !== 'gs' && !rocketsToCheck.some((r) => r.rocketId === s.rocketId)) {
    rocketsToCheck.push({ rocketId: s.rocketId, name: `not in the manifest` });
  }
}
for (const rocket of rocketsToCheck) {
  const samples = flight.samples.filter((s) => s.type !== 'gs' && s.rocketId === rocket.rocketId);
  const truth = flight.truth.filter((r) => r.rocketId === rocket.rocketId);
  const { events, state } = detectAll(samples);

  console.log('');
  console.log(`Rocket ${rocket.rocketId} "${rocket.name}": ${samples.length} samples, t ${fmt(samples[0]?.t)} to ${fmt(samples[samples.length - 1]?.t)} s`);
  if (!samples.length) {
    flagged += 1;
    console.log('  CHECK  this manifest rocket has no samples. Check its rocketId against the IDs in the file.');
    continue;
  }
  console.log(`  altitude from ${state.altSource ?? 'nothing'}, ground ${fmt(state.groundRef)} m${state.groundEstimated ? ' (estimated)' : ''}, max ${fmt(state.maxAgl)} m AGL`);
  console.log('  Detected events (data time t, flight time T, basis):');
  for (const e of events) {
    console.log(`    t=${fmt(e.t).padStart(6)}  T=${signed(e.flightT).padStart(7)}  ${e.basis.padEnd(8)}  ${e.message}`);
  }

  if (!truth.length) {
    console.log('  No ground truth for this rocket, so detection times were not compared.');
    // A flight event firing twice is a bug with or without truth.
    for (const type of FLIGHT_EVENT_TYPES) {
      const count = events.filter((e) => e.type === type).length;
      if (count > 1) {
        flagged += 1;
        console.log(`    CHECK  ${type} FIRED ${count} TIMES`);
      }
    }
    continue;
  }
  anyTruth = true;
  console.log('  True phase starts: ' + truthPhaseStarts(truth).map((s) => `${s.phase} t=${fmt(s.t)}`).join(', '));
  console.log(`  Compared with truth (tolerance ${tolerance} s):`);
  for (const row of compareWithTruth(events, truth)) {
    const notes = [];
    if (row.truthT === null) notes.push('no true phase to compare');
    if (row.count === 0 && row.truthT !== null) notes.push('NEVER DETECTED');
    if (row.count > 1) notes.push(`FIRED ${row.count} TIMES`);
    if (Number.isFinite(row.diffS) && Math.abs(row.diffS) > tolerance) notes.push(`OFF BY MORE THAN ${tolerance} s`);
    const bad = notes.some((n) => n === n.toUpperCase());
    if (bad) flagged += 1;
    console.log(`    ${row.type.padEnd(8)} true ${String(row.truthPhase).padEnd(7)} t=${fmt(row.truthT).padStart(6)}  ` +
      `detected t=${fmt(row.detectedT).padStart(6)} (confirmed t=${fmt(row.confirmedT)})  diff ${signed(row.diffS).padStart(5)} s  ` +
      `${bad ? 'CHECK' : 'ok'}${notes.length ? `  ${notes.join(', ')}` : ''}`);
  }
}

console.log('');
console.log(`Bad rows skipped while reading: ${flight.badRows}`);
if (flagged) console.log(`${flagged} problem(s) flagged.`);
else if (anyTruth) console.log('All events within tolerance, none fired twice.');
else if (flight.truth.length) console.log('The flight has ground truth, but none of it matched a checked rocket ID, so nothing was compared. No event fired twice.');
else console.log('No ground truth in this flight, so nothing was compared. No event fired twice.');
process.exit(flagged ? 1 : 0);
