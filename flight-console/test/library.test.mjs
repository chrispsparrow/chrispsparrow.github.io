// Checks the flight library's optional groundStation (Manta's position for
// one flight) in js/library.js, how the store uses it, and that
// tools/add_flight.mjs takes it (--gs-lat, --gs-lon, --gs-alt). The tool is
// run on a copy of the library in the system's temp folder, so the real
// index.json is never touched.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/library.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateEntry, validateManifest } from '../js/library.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '..');

const base = { id: 'beach-01', title: 'Beach flight', date: '2027-03-01', kind: 'real', rockets: [{ rocketId: '1', name: 'Board', file: 'a.log' }] };

test('an entry may carry groundStation, checked and passed through', () => {
  const ok = validateEntry({ ...base, groundStation: { lat: -8.5374, lon: 119.5724, altMsl: 2 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entry.groundStation, { lat: -8.5374, lon: 119.5724, altMsl: 2 });
  assert.ok(Object.isFrozen(ok.entry.groundStation));
  // altMsl can be left out.
  assert.deepEqual(validateEntry({ ...base, groundStation: { lat: 1, lon: 2 } }).entry.groundStation, { lat: 1, lon: 2, altMsl: null });
  // Left out (or null): no key at all, so createStore() falls back to the demo position.
  assert.equal('groundStation' in validateEntry(base).entry, false);
  assert.equal('groundStation' in validateEntry({ ...base, groundStation: null }).entry, false);
  // A broken one stops the entry.
  for (const bad of [{ lat: 95, lon: 0 }, { lat: 0, lon: 181 }, { lat: '1', lon: 2 }, { lat: 1 }, { lat: 1, lon: 2, altMsl: 'high' }, 'here', [1, 2]]) {
    const r = validateEntry({ ...base, groundStation: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.reason, /groundStation/);
  }
  // The real library still reads.
  const manifest = JSON.parse(fs.readFileSync(path.join(CONSOLE_DIR, 'data', 'flights', 'index.json'), 'utf8'));
  const { flights, problems } = validateManifest(manifest);
  assert.equal(problems.length, 0);
  assert.ok(flights.length >= 1);
});

test('a store made with the entry\'s groundStation starts there, not at the demo position', () => {
  const entry = validateEntry({ ...base, groundStation: { lat: -8.5374, lon: 119.5724, altMsl: 2 } }).entry;
  const gs = createStore({ fleet: createFleet(), groundStation: entry.groundStation }).getGroundStation();
  assert.deepEqual(gs, { lat: -8.5374, lon: 119.5724, altMsl: 2, source: 'flight library', t: null });
  // An entry without one: undefined, so the demo position.
  const plain = validateEntry(base).entry;
  assert.equal(createStore({ fleet: createFleet(), groundStation: plain.groundStation }).getGroundStation().source, 'config');
  // After a reset (a replay seeking), it is still there.
  const store = createStore({ fleet: createFleet(), groundStation: entry.groundStation });
  store.reset();
  assert.equal(store.getGroundStation().source, 'flight library');
});

test('add_flight.mjs takes --gs-lat, --gs-lon and --gs-alt, and checks them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-add-flight-'));
  try {
    for (const dir of ['js', 'tools', 'data']) fs.cpSync(path.join(CONSOLE_DIR, dir), path.join(tmp, 'site', dir), { recursive: true });
    const log = path.join(tmp, 'pc_sim_flight.log');
    fs.copyFileSync(path.join(CONSOLE_DIR, 'data', 'flights', 'gps-board-sim-01', 'pc_sim_flight.log'), log);
    const tool = path.join(tmp, 'site', 'tools', 'add_flight.mjs');
    const indexPath = path.join(tmp, 'site', 'data', 'flights', 'index.json');
    const runTool = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
    const common = ['--title', 'Beach test', '--kind', 'simulated', '--file', log, '--date', '2027-03-01'];

    const good = runTool(['--id', 'beach-test-01', ...common, '--gs-lat', '35.12', '--gs-lon', '-117.13', '--gs-alt', '701.5']);
    assert.equal(good.status, 0, good.stderr);
    const flights = JSON.parse(fs.readFileSync(indexPath, 'utf8')).flights;
    const beach = flights.find((f) => f.id === 'beach-test-01');
    const sim = flights.find((f) => f.id === 'gps-board-sim-01');
    assert.deepEqual(beach.groundStation, { lat: 35.12, lon: -117.13, altMsl: 701.5 });
    assert.equal(beach.summary.gsDemo, false, 'the distances use Manta, not the demo position');
    assert.ok(beach.summary.maxGsDistanceM > 0 && beach.summary.maxGsDistanceM !== sim.summary.maxGsDistanceM);
    assert.equal(validateManifest({ flights }).problems.length, 0);

    // Without them it is the demo position, as before.
    const plain = runTool(['--id', 'beach-test-02', ...common]);
    assert.equal(plain.status, 0, plain.stderr);
    const plainEntry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).flights.find((f) => f.id === 'beach-test-02');
    assert.equal('groundStation' in plainEntry, false);
    assert.equal(plainEntry.summary.gsDemo, true);

    // Mistakes stop it before anything is written.
    const before = fs.readFileSync(indexPath, 'utf8');
    for (const args of [['--gs-lat', '95', '--gs-lon', '1'], ['--gs-lat', '35'], ['--gs-alt', '3'], ['--gs-lat', 'north', '--gs-lon', '1']]) {
      const bad = runTool(['--id', 'beach-test-03', ...common, ...args]);
      assert.equal(bad.status, 1, args.join(' '));
      assert.match(bad.stderr, /Nothing was written/);
    }
    assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
