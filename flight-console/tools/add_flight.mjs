// add_flight.mjs
// Adds a flight to the Flight Console library. It copies the data file(s)
// into data/flights/<id>/ (the originals are only read, never changed or
// deleted), runs them through the SAME parser.js and detector.js the page
// uses to fill in the summary, and adds or updates the entry in
// data/flights/index.json, newest date first.
//
// Everything is checked before anything is written, so a mistake in the
// command never leaves half a flight behind.
//
// Run from the website folder, for example:
//   node flight-console/tools/add_flight.mjs --id gps-board-sim-01
//     --title "GPS and radio board simulated flight" --kind simulated
//     --file "C:\path\to\pc_sim_flight.log" --rocket-name "GPS and radio board"
//     --board "SAMD21, SAM-M8Q GPS and E22 LoRa radio" --date 2026-09-30 --featured
//
// Options:
//   --id ID              folder name and ?flight= value (letters, numbers, - and _)
//   --title TEXT         shown on the launcher and in the console
//   --kind KIND          simulated or real
//   --date YYYY-MM-DD    flight date
//   --file PATH          a data file (.log, .csv or .jsonl). Repeat for more rockets.
//   --rocket-id ID       rocket ID for the matching --file (default: the ID in the file)
//   --rocket-name TEXT   display name for the matching --file
//   --board TEXT         board description for the matching --file
//   --description TEXT   one or two plain sentences
//   --site TEXT          launch site name
//   --featured           make this the featured flight (clears it from the others)
//   --replace            allowed to overwrite a flight with the same id
// The Nth --rocket-id, --rocket-name and --board go with the Nth --file.
// A file holding several rocket IDs (like a ground station log) becomes one
// rocket per ID, and can't take --rocket-id.
//
// Used by: me, from the command line. Nothing in the page imports it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateEntry, buildFlight } from '../js/library.js';
import { parseFile } from '../js/parser.js';
import { detectAll, FLIGHT_EVENT_TYPES } from '../js/detector.js';
import { GROUPS } from '../js/schema.js';
import { KNOWN_ROCKETS } from '../js/fleet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLIGHTS_DIR = path.resolve(HERE, '..', 'data', 'flights');
const MANIFEST_PATH = path.join(FLIGHTS_DIR, 'index.json');

function fail(message) {
  console.error(`add_flight: ${message}`);
  console.error('Nothing was written.');
  process.exit(1);
}

// ------------------------------------------------------------------
// Command line
// ------------------------------------------------------------------
function parseArgs(argv) {
  const repeatable = new Set(['--file', '--rocket-id', '--rocket-name', '--board']);
  const flags = new Set(['--featured', '--replace']);
  const single = new Set(['--id', '--title', '--kind', '--date', '--description', '--site']);
  const args = { '--file': [], '--rocket-id': [], '--rocket-name': [], '--board': [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (flags.has(key)) { args[key] = true; continue; }
    if (!repeatable.has(key) && !single.has(key)) fail(`unknown option ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} needs a value`);
    i += 1;
    if (repeatable.has(key)) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const id = args['--id'];
const title = args['--title'];
const kind = args['--kind'];
const date = args['--date'];
if (!id || !title || !kind || !date || args['--file'].length === 0) {
  fail('needs at least --id, --title, --kind, --date and one --file (see the top of this file)');
}
if (!['simulated', 'real'].includes(kind)) fail('--kind must be simulated or real');
if (args['--rocket-id'].length > args['--file'].length) fail('there are more --rocket-id values than --file values');

// The id becomes a folder name, so it must stay inside data/flights.
const idCheck = validateEntry({ id, title, date, kind, rockets: [{ rocketId: 'x', name: 'x', file: 'x.log' }] });
if (!idCheck.ok) fail(`the flight details are not valid: ${idCheck.reason}`);
const flightDir = path.resolve(FLIGHTS_DIR, id);
if (path.dirname(flightDir) !== FLIGHTS_DIR) fail(`the id "${id}" would put the flight outside ${FLIGHTS_DIR}`);

// ------------------------------------------------------------------
// Manifest
// ------------------------------------------------------------------
let manifest = { flights: [] };
if (fs.existsSync(MANIFEST_PATH)) {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    fail(`${MANIFEST_PATH} is not valid JSON (${err.message}). Fix it by hand first.`);
  }
  if (!manifest || !Array.isArray(manifest.flights)) fail(`${MANIFEST_PATH} has no "flights" list. Fix it by hand first.`);
}
const existingIndex = manifest.flights.findIndex((f) => f && f.id === id);
if (existingIndex !== -1 && !args['--replace']) {
  fail(`a flight with id "${id}" already exists. Add --replace to overwrite it.`);
}

// ------------------------------------------------------------------
// Source files: read them (only read) and check the names
// ------------------------------------------------------------------
const sources = args['--file'].map((source) => {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(`can't find the file ${resolved}`);
  const name = path.basename(resolved);
  if (name.startsWith('.')) fail(`the file name ${name} starts with a dot`);
  const target = path.join(flightDir, name);
  if (path.resolve(target) === resolved) fail('the source file is already inside the library folder');
  if (fs.existsSync(target) && !args['--replace']) fail(`${target} already exists. Add --replace to overwrite it.`);
  return { source: resolved, name, target, text: fs.readFileSync(resolved, 'utf8') };
});
const names = sources.map((s) => s.name);
const duplicateName = names.find((n, i) => names.indexOf(n) !== i);
if (duplicateName) fail(`two --file values have the same name (${duplicateName}). Rename one copy first so both fit in the flight's folder.`);

// ------------------------------------------------------------------
// Work out the rockets
// ------------------------------------------------------------------
const known = new Map(KNOWN_ROCKETS.map((k) => [k.id, k]));
const rockets = [];
sources.forEach((file, i) => {
  const idsInFile = [...new Set(parseFile(file.text, file.name).samples.filter((s) => s.type !== 'gs').map((s) => s.rocketId).filter(Boolean))];
  if (idsInFile.length > 1) {
    if (args['--rocket-id'][i]) {
      fail(`${file.name} holds ${idsInFile.length} rocket IDs (${idsInFile.join(', ')}), so it can't take --rocket-id. Leave it out and each ID becomes its own rocket.`);
    }
    // One file, several rockets (for example a ground station log).
    console.log(`  ${file.name} holds ${idsInFile.length} rockets: ${idsInFile.join(', ')}`);
    for (const rid of idsInFile) {
      rockets.push({ rocketId: rid, name: known.get(rid)?.name ?? `Rocket ${rid}`, board: known.get(rid)?.board ?? null, file: file.name });
    }
    return;
  }
  const rocketId = args['--rocket-id'][i] ?? idsInFile[0] ?? `rocket-${i + 1}`;
  const name = args['--rocket-name'][i] ?? known.get(rocketId)?.name ?? `Rocket ${rocketId}`;
  const board = args['--board'][i] ?? known.get(rocketId)?.board ?? null;
  rockets.push({ rocketId, name, board, file: file.name });
});
const rocketIds = rockets.map((r) => r.rocketId);
const duplicateId = rocketIds.find((r, i) => rocketIds.indexOf(r) !== i);
if (duplicateId) {
  fail(`two files use rocket ID "${duplicateId}" (every board sends node 1 until it is given its own number). Pass --rocket-id once for each --file, for example --rocket-id a --rocket-id b.`);
}

// ------------------------------------------------------------------
// Summary, from the same parser and detector the page uses
// ------------------------------------------------------------------
const draft = validateEntry({ id, title, date, kind, rockets });
if (!draft.ok) fail(`the new entry is not valid: ${draft.reason}`);
const flight = buildFlight(draft.entry, new Map(sources.map((s) => [s.name, s.text])));

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const sensors = new Set();
const eventTypes = new Set();
let maxAglM = null;
let flightDurationS = null;
const report = [];
for (const r of draft.entry.rockets) {
  const own = flight.samples.filter((s) => s.rocketId === r.rocketId);
  if (!own.length) fail(`rocket "${r.rocketId}" (${r.file}) has no readable samples. Check the file and the --rocket-id values.`);
  for (const s of own) for (const g of GROUPS) if (s[g]) sensors.add(g);
  const { events, state } = detectAll(own);
  for (const e of events) if (FLIGHT_EVENT_TYPES.includes(e.type)) eventTypes.add(e.type);
  const liftoff = events.find((e) => e.type === 'liftoff');
  const landed = events.find((e) => e.type === 'landed');
  let duration = null;
  let durationFrom = '';
  if (liftoff && landed) {
    duration = landed.t - liftoff.t;
    durationFrom = 'liftoff to landed';
  } else {
    duration = own[own.length - 1].t - own[0].t;
    durationFrom = 'whole data span (liftoff or landing not detected)';
  }
  if (Number.isFinite(state.maxAgl) && (maxAglM === null || state.maxAgl > maxAglM)) maxAglM = state.maxAgl;
  if (Number.isFinite(duration) && (flightDurationS === null || duration > flightDurationS)) flightDurationS = duration;
  report.push({ rocket: r, count: own.length, events, state, duration, durationFrom });
}

const entry = {
  id,
  title,
  date,
  kind,
  featured: Boolean(args['--featured']),
  description: args['--description'] ?? '',
  site: args['--site'] ?? null,
  rockets: rockets.map(({ rocketId, name, board, file }) => ({ rocketId, name, board, file })),
  summary: {
    rocketCount: rockets.length,
    maxAglM: round1(maxAglM),
    flightDurationS: round1(flightDurationS),
    sensors: GROUPS.filter((g) => sensors.has(g)),
    events: FLIGHT_EVENT_TYPES.filter((e) => eventTypes.has(e)),
  },
};
const finalCheck = validateEntry(entry);
if (!finalCheck.ok) fail(`the finished entry is not valid: ${finalCheck.reason}`);

// ------------------------------------------------------------------
// Everything checked: copy the files and write the manifest
// ------------------------------------------------------------------
fs.mkdirSync(flightDir, { recursive: true });
// copyFileSync copies byte for byte and only reads the source.
for (const s of sources) fs.copyFileSync(s.source, s.target);

let flights = manifest.flights.filter((f) => !(f && f.id === id));
if (entry.featured) flights = flights.map((f) => (f && typeof f === 'object' && f.featured ? { ...f, featured: false } : f));
flights.push(entry);
flights.sort((a, b) => String(b?.date ?? '').localeCompare(String(a?.date ?? '')) || String(a?.title ?? '').localeCompare(String(b?.title ?? '')));
const output = { ...manifest, flights };
const check = validateManifest(output);
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

// ------------------------------------------------------------------
// Tell me what happened
// ------------------------------------------------------------------
console.log(`${existingIndex === -1 ? 'Added' : 'Replaced'} flight "${id}" (${kind}, ${date})`);
for (const s of sources) console.log(`  copied ${s.source}\n      to ${s.target}`);
for (const r of report) {
  console.log(`  rocket ${r.rocket.rocketId} "${r.rocket.name}": ${r.count} samples, altitude from ${r.state.altSource ?? 'nothing'}`);
  for (const e of r.events) console.log(`    ${e.message}`);
  console.log(`    duration ${round1(r.duration)} s (${r.durationFrom})`);
}
console.log(`  bad rows skipped: ${flight.badRows}`);
for (const f of flight.files) for (const note of f.notes ?? []) console.log(`  note: ${note}`);
console.log(`  summary: ${JSON.stringify(entry.summary)}`);
if (entry.featured) console.log('  this is now the featured flight');
if (!entry.description) console.log('  note: no --description given, the launcher will show none');
if (check.problems.length) {
  console.log(`  warning: the manifest has ${check.problems.length} other entr${check.problems.length === 1 ? 'y' : 'ies'} the page will skip:`);
  for (const p of check.problems) console.log(`    entry ${p.index === null ? '' : p.index + 1}${p.id ? ` ("${p.id}")` : ''}: ${p.reason}`);
}
console.log(`  wrote ${MANIFEST_PATH}`);
