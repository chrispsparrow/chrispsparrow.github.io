// Checks the ground station's name on the maps (stationLabel() in
// js/views/map-labels.js): GROUND STATION for a position typed in on the
// launch page, MANTA everywhere else, and the same as the HUD's name
// (stationName() in js/flight-state.js). The views read it from the store
// on every draw, so these also check that the store's answer follows a
// new ground station and a store switch.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/map-labels.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationLabel, LABEL_NAMES, apogeeLabel } from '../js/views/map-labels.js';
import { stationName } from '../js/flight-state.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { createStoreSwitch } from '../js/store-switch.js';

const FIELD = { lat: 44.825278, lon: -73.171727 };
const typed = (p) => ({ lat: p.lat, lon: p.lon, altMsl: null, source: 'launch-mode' });
const MANTA = { lat: -8.539775, lon: 119.574933, altMsl: 2 };

test('the dish is GROUND STATION for a typed-in position and MANTA for every other one', () => {
  const cases = [
    [typed(FIELD), 'GROUND STATION'],
    [{ ...MANTA, source: 'flight library' }, 'MANTA'],
    [{ lat: 1, lon: 2, source: 'ground station GPS' }, 'MANTA'],
    [{ lat: 1, lon: 2, source: 'config' }, 'MANTA'],
    [{ lat: 1, lon: 2 }, 'MANTA'],
    [null, 'MANTA'],
  ];
  for (const [gs, want] of cases) {
    assert.equal(stationLabel(gs), want, JSON.stringify(gs));
    assert.equal(stationLabel(gs), stationName(gs), 'the maps and the HUD agree');
  }
});

test('the fixed names are unchanged, and the station is no longer one of them', () => {
  assert.deepEqual({ ...LABEL_NAMES }, { board: 'DOGTOOTH', pad: 'LAUNCH POINT' });
  assert.equal(apogeeLabel(3012), 'APOGEE 3,012 M');
});

test('a normal store is the demo Manta, and a saved flight keeps its own Manta', () => {
  assert.equal(stationLabel(createStore({ fleet: createFleet() }).getGroundStation()), 'MANTA');
  const saved = createStore({ fleet: createFleet(), groundStation: MANTA });
  assert.equal(stationLabel(saved.getGroundStation()), 'MANTA');
});

test('the name follows a "station" change and a store switch', () => {
  const live = createStore({ fleet: createFleet(), groundStation: null });
  const replay = createStore({ fleet: createFleet(), groundStation: MANTA });
  const stage = createStoreSwitch(live);
  const seen = [];
  stage.subscribe((c) => seen.push(c.type));
  // No ground station: no dish to name (the views leave it out).
  assert.equal(stage.getGroundStation(), null);
  // The position typed in at the field.
  stage.setGroundStation(typed(FIELD));
  assert.equal(stationLabel(stage.getGroundStation()), 'GROUND STATION');
  // A saved flight with its own Manta goes on the stage, then live again.
  stage.use(replay);
  assert.equal(stationLabel(stage.getGroundStation()), 'MANTA');
  stage.use(live);
  assert.equal(stationLabel(stage.getGroundStation()), 'GROUND STATION');
  assert.deepEqual(seen, ['station', 'source', 'source']);
});
