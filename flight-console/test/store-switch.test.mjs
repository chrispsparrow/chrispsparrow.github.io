// Checks js/store-switch.js: one store the map keeps for the whole visit,
// standing in front of the live store or a replay's.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/store-switch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStoreSwitch } from '../js/store-switch.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { flightState, STATE } from '../js/flight-state.js';
import { makeSample, SITE } from './synthetic.mjs';

const newStore = (options = {}) => createStore({ fleet: createFleet(), ...options });
const sample = (t, id = '1') => makeSample({ t, rocketId: id, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: 700, sats: 9, hdop: 1 });

test('every store method answers from the store in use', () => {
  const live = newStore({ groundStation: null });
  const replay = newStore();
  live.addSample(sample(5, 'live'));
  replay.addSample(sample(50, 'replay'));
  const stage = createStoreSwitch(live);
  // Every function a store has is on the switch too.
  for (const [name, value] of Object.entries(live)) {
    if (typeof value === 'function') assert.equal(typeof stage[name], 'function', name);
  }
  assert.equal(stage.current(), live);
  assert.equal(stage.getFocusedId(), 'live');
  assert.equal(stage.getGroundStation(), null);
  assert.equal(stage.getNow(), 5);
  stage.use(replay);
  assert.equal(stage.current(), replay);
  assert.equal(stage.getFocusedId(), 'replay');
  assert.equal(stage.getGroundStation().source, 'config');
  assert.equal(stage.getNow(), 50);
  // Writing goes to the store in use.
  stage.addSample(sample(51, 'replay'));
  assert.equal(replay.getFocused().samples.length, 2);
  assert.equal(live.getFocused().samples.length, 1);
  // flightState works on the switch like on a store.
  assert.equal(flightState(stage).state, STATE.PAD);
});

test('use() sends one "source" change, and the old store goes quiet', () => {
  const a = newStore();
  const b = newStore();
  const stage = createStoreSwitch(a);
  const seen = [];
  stage.subscribe((change) => seen.push(change.type));
  a.addSample(sample(1));
  assert.deepEqual(seen, ['samples']);
  stage.use(b);
  assert.deepEqual(seen, ['samples', 'source']);
  a.addSample(sample(2));
  a.reset();
  assert.deepEqual(seen, ['samples', 'source'], 'nothing from the store that left');
  b.addSample(sample(3));
  b.reset();
  assert.deepEqual(seen, ['samples', 'source', 'samples', 'reset']);
  stage.use(b);
  assert.equal(seen.length, 4, 'switching to the same store does nothing');
  stage.use(a);
  a.addSample(sample(4));
  assert.deepEqual(seen.slice(4), ['source', 'samples'], 'and back');
});

test('a listener that throws doesn\'t stop the others, unsubscribe and destroy work', () => {
  const a = newStore();
  const stage = createStoreSwitch(a);
  const seen = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    stage.subscribe(() => { throw new Error('a view broke'); });
    const off = stage.subscribe((c) => seen.push(c.type));
    a.addSample(sample(1));
    assert.deepEqual(seen, ['samples']);
    off();
    a.addSample(sample(2));
    assert.deepEqual(seen, ['samples']);
    stage.subscribe((c) => seen.push(c.type));
    stage.destroy();
    a.addSample(sample(3));
    assert.deepEqual(seen, ['samples']);
  } finally {
    console.error = quiet;
  }
});

test('only stores go in', () => {
  assert.throws(() => createStoreSwitch(null));
  assert.throws(() => createStoreSwitch({}));
  const stage = createStoreSwitch(newStore());
  assert.throws(() => stage.use(null));
  assert.throws(() => stage.use({ subscribe() {} }));
});
