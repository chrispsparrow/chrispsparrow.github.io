// add_flight.mjs
// Adds a flight to the Flight Console library. It copies the data file(s)
// into data/flights/<id>/ (the originals are only read, never changed or
// deleted), runs them through the SAME parser.js, detector.js and store.js
// the page uses to fill in the summary, and adds or updates the entry in
// data/flights/index.json, newest date first. The summary includes a
// simplified track and altitude line for the launcher's featured card, so
// the launcher never has to download a flight's data files.
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
import { KNOWN_ROCKETS, createFleet } from '../js/fleet.js';
import { createStore } from '../js/store.js';
import { distanceM } from '../js/geo.js';
import { LINK_STALE_S } from '../js/config.js';

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

// ------------------------------------------------------------------
// The launcher's featured card: a small map of the track, an altitude line,
// how far the rocket drifted from the pad and how far it got from the
// ground station. A store fed the whole flight (the same code the console
// runs) supplies them, so the track only ever holds good GPS positions and
// the altitude line only real readings. Both break (a gap) wherever the GPS
// had no fix, and wherever nothing came in for longer than LINK_STALE_S (a
// radio silence), so neither is ever drawn as solid across missing data.
// With several rockets they describe the one that flew highest.
// ------------------------------------------------------------------
// Most points kept in the track and in the altitude line.
const SUMMARY_MAX_POINTS = 60;
// Seconds of the altitude line kept before liftoff and after landing.
const PROFILE_EDGE_S = 10;

const round = (v, digits) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

// Ramer-Douglas-Peucker: the indexes of the points to keep so the line
// never moves more than eps from the original. distance(p, a, b) is how far
// p is from the straight line a-b.
function simplifyIndexes(points, eps, distance) {
  if (points.length <= 2) return points.map((_, i) => i);
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstDist = 0;
    for (let i = a + 1; i < b; i++) {
      const dist = distance(points[i], points[a], points[b]);
      if (dist > worstDist) { worstDist = dist; worst = i; }
    }
    if (worst !== -1 && worstDist > eps) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

// How far p is from the segment a-b, in the same units as x and y.
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy));
}

// Simplifies runs of points to fit in SUMMARY_MAX_POINTS. Each run is
// { pts, gapAfterT }: its points (with x and y for measuring) and, for the
// altitude line, when the gap after it starts. The tolerance goes up until
// everything fits, and every run keeps its first and last point, so the gaps
// stay where they were. If there are so many gaps that even that doesn't
// fit (a GPS that keeps dropping out), the shortest runs between two gaps
// are left out, so their stretch is drawn as part of one longer gap, never
// as a solid line. extraPerGap counts the altitude line's [t, null] entries.
function simplifyRuns(runs, startEps, { mustKeep = () => false, extraPerGap = 0 } = {}) {
  const count = (list) => list.reduce((n, run) => n + run.pts.length, 0) + extraPerGap * Math.max(0, list.length - 1);
  let live = runs.filter((run) => run.pts.length);
  for (;;) {
    let eps = startEps;
    let kept = live;
    for (let tries = 0; tries < 60; tries++) {
      kept = live.map((run) => {
        const idx = new Set(simplifyIndexes(run.pts, eps, segmentDistance));
        run.pts.forEach((p, i) => { if (mustKeep(p)) idx.add(i); });
        return { ...run, pts: [...idx].sort((x, y) => x - y).map((i) => run.pts[i]) };
      });
      if (count(kept) <= SUMMARY_MAX_POINTS) return kept;
      eps *= 1.5;
    }
    // Still too many: leave out the shortest run between two gaps (never
    // the first or last run, or one with a point that must stay).
    let drop = -1;
    for (let i = 1; i < live.length - 1; i++) {
      if (live[i].pts.some(mustKeep)) continue;
      if (drop === -1 || live[i].pts.length < live[drop].pts.length) drop = i;
    }
    if (drop === -1) return kept;
    live = live.filter((_, i) => i !== drop);
  }
}

function summarizePicture(rocket, gs) {
  const d = rocket.derived;
  const out = { trackRocketId: rocket.id, track: null, trackGaps: [], padPoint: null, landingPoint: null, altProfile: null, driftM: null, maxGsDistanceM: null };

  // Track: good positions only, split into runs wherever the GPS had no fix
  // or no position came in for longer than LINK_STALE_S, with repeats of the
  // same spot (sitting on the pad) dropped.
  const origin = rocket.track[0];
  if (origin) {
    const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const runs = [];
    let prevT = null;
    for (const p of rocket.track) {
      const silent = prevT !== null && p.t - prevT > LINK_STALE_S;
      prevT = p.t;
      if (!runs.length || p.gapBefore || silent) runs.push({ pts: [], gapAfterT: null });
      const run = runs[runs.length - 1].pts;
      const last = run[run.length - 1];
      if (!last || last.lat !== p.lat || last.lon !== p.lon) {
        run.push({ lat: p.lat, lon: p.lon, x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * 110540 });
      }
    }
    const kept = simplifyRuns(runs, 0.5);
    out.track = [];
    for (const run of kept) {
      if (out.track.length) out.trackGaps.push(out.track.length);
      for (const p of run.pts) out.track.push([round(p.lat, 6), round(p.lon, 6)]);
    }
    let farthest = 0;
    for (const p of rocket.track) farthest = Math.max(farthest, distanceM(gs.lat, gs.lon, p.lat, p.lon));
    out.maxGsDistanceM = round(farthest, 0);
  }

  // Pad and landing: the pad is the last good position before liftoff (as
  // the console draws it), the landing point the first good position from
  // the moment the landing was detected. Drift is the distance between them.
  if (rocket.padPosition) out.padPoint = [round(rocket.padPosition.lat, 6), round(rocket.padPosition.lon, 6)];
  const landed = d?.events?.landed;
  const landing = landed ? rocket.track.find((p) => p.t >= landed.t - 1e-6) : null;
  if (landing) out.landingPoint = [round(landing.lat, 6), round(landing.lon, 6)];
  if (rocket.padPosition && landing) {
    out.driftM = round(distanceM(rocket.padPosition.lat, rocket.padPosition.lon, landing.lat, landing.lon), 0);
  }

  // Altitude line: seconds from liftoff (from the first reading if there is
  // no liftoff) and meters above the ground level frozen at liftoff, from
  // PROFILE_EDGE_S before liftoff to PROFILE_EDGE_S after landing. A reading
  // that should have had an altitude and didn't, or no reading at all for
  // longer than LINK_STALE_S, becomes [t, null]: a break.
  const series = rocket.altSeries;
  if (series.length && Number.isFinite(d?.groundRef)) {
    const zero = d.liftoffT ?? series[0].t;
    const from = d.liftoffT !== null ? d.liftoffT - PROFILE_EDGE_S : -Infinity;
    const to = landed ? landed.t + PROFILE_EDGE_S : Infinity;
    const inWindow = series.filter((p) => p.t >= from && p.t <= to);
    const span = Math.max(1e-6, inWindow.length ? inWindow[inWindow.length - 1].t - inWindow[0].t : 1);
    const top = Math.max(1, d.maxAgl ?? 1);
    const runs = [];
    let open = null;
    let prevT = null;
    for (const p of inWindow) {
      const silent = prevT !== null && p.t - prevT > LINK_STALE_S;
      if (open && (p.alt === null || silent)) {
        open.gapAfterT = (p.alt === null ? p.t : prevT + LINK_STALE_S) - zero;
        open = null;
      }
      prevT = p.t;
      if (p.alt === null) continue;
      if (!open) { open = { pts: [], gapAfterT: null }; runs.push(open); }
      const t = p.t - zero;
      const agl = p.alt - d.groundRef;
      open.pts.push({ t, agl, x: t / span, y: agl / top });
    }
    if (runs.length) {
      const peak = Math.max(...runs.flatMap((run) => run.pts.map((p) => p.agl)));
      const kept = simplifyRuns(runs, 0.0005, { mustKeep: (p) => p.agl === peak, extraPerGap: 1 });
      out.altProfile = [];
      kept.forEach((run, i) => {
        for (const p of run.pts) out.altProfile.push([round(p.t, 1), round(p.agl, 1)]);
        if (i < kept.length - 1) out.altProfile.push([round(run.gapAfterT ?? run.pts[run.pts.length - 1].t, 1), null]);
      });
    }
  }
  return out;
}

const scan = createStore({ fleet: createFleet() });
for (const r of draft.entry.rockets) scan.registerRocket({ id: r.rocketId, name: r.name, board: r.board });
scan.addSamples(flight.samples
  .filter((s) => Number.isFinite(s.t))
  .map((s, i) => ({ s, i }))
  .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
  .map((x) => x.s), { quiet: true });
const highest = report.reduce((best, r) => (Number.isFinite(r.state.maxAgl) && (!best || r.state.maxAgl > best.state.maxAgl) ? r : best), null) ?? report[0];
const gsNow = scan.getGroundStation();
const picture = summarizePicture(scan.getRocket(highest.rocket.rocketId), gsNow);

// A cover picture is added to index.json by hand (see the README), so a
// --replace keeps the one the flight already had.
const keptCover = existingIndex === -1 ? null : (manifest.flights[existingIndex]?.cover ?? null);

const entry = {
  id,
  title,
  date,
  kind,
  featured: Boolean(args['--featured']),
  description: args['--description'] ?? '',
  site: args['--site'] ?? null,
  ...(keptCover ? { cover: keptCover } : {}),
  rockets: rockets.map(({ rocketId, name, board, file }) => ({ rocketId, name, board, file })),
  summary: {
    rocketCount: rockets.length,
    maxAglM: round1(maxAglM),
    flightDurationS: round1(flightDurationS),
    sensors: GROUPS.filter((g) => sensors.has(g)),
    events: FLIGHT_EVENT_TYPES.filter((e) => eventTypes.has(e)),
    ...picture,
    // True when the ground station distances use the demo position in
    // config.js, because the data had no ground station GPS packets.
    gsDemo: gsNow.source === 'config',
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
const { track, trackGaps, altProfile, ...shortSummary } = entry.summary;
console.log(`  summary: ${JSON.stringify(shortSummary)}`);
console.log(`  featured card picture from rocket ${picture.trackRocketId}: track ${track?.length ?? 0} points` +
  `${trackGaps.length ? ` (GPS gaps before points ${trackGaps.join(', ')})` : ''}, altitude line ${altProfile?.length ?? 0} points`);
if (keptCover) console.log(`  kept the cover picture ${keptCover.file ?? ''} from the old entry. If the flight's data changed, make a new one.`);
if (entry.featured) console.log('  this is now the featured flight');
if (!entry.description) console.log('  note: no --description given, the launcher will show none');
if (check.problems.length) {
  console.log(`  warning: the manifest has ${check.problems.length} other entr${check.problems.length === 1 ? 'y' : 'ies'} the page will skip:`);
  for (const p of check.problems) console.log(`    entry ${p.index === null ? '' : p.index + 1}${p.id ? ` ("${p.id}")` : ''}: ${p.reason}`);
}
console.log(`  wrote ${MANIFEST_PATH}`);
