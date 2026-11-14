// store-switch.js
// One store the map can keep for the whole visit, standing in front of
// whichever real store is on screen (the live one, or a replay's).
//
// Track a Rocket keeps its map and 3D view alive when a saved flight
// opens, so the globe never goes blank. The views are made once with this
// switch as their store. When the page changes what it shows, it calls
// use(otherStore). Every reading method then answers from the new store,
// and subscribers get one change, { type: 'source' }, which means "drop
// everything you drew or cached and draw the new store from scratch".
//
//   const stage = createStoreSwitch(liveStore);
//   createMapView(root, { store: stage, ... });   // made once
//   stage.use(replayStore);                       // a saved flight opened
//   stage.use(liveStore);                         // back to live
//
// It has every method a store has (see store.js), plus:
//   use(store)   switch to another store
//   current()    the real store behind it right now
//
// Used by: main.js. No DOM.

const METHODS = [
  'addSample', 'addSamples', 'setTime', 'reset', 'clearAll', 'registerRocket', 'setPrescan', 'focus',
  'getRockets', 'getRocket', 'getFocused', 'getFocusedId', 'getEvents', 'getGroundStation', 'getNow',
  'getTotals', 'ageOf', 'isSilent', 'gpsIsQuiet', 'hasFixNow', 'altitudeIsOld', 'flightTimeOf',
];

export function createStoreSwitch(initial) {
  if (!initial) throw new Error('createStoreSwitch needs a store to start with');
  const listeners = new Set();
  let target = initial;
  let detach = null;

  function emit(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (err) { console.error('Flight Console view error:', err); }
    }
  }

  function attach() {
    detach = target.subscribe(emit);
  }

  function use(next) {
    if (!next || next === target) return;
    detach?.();
    target = next;
    attach();
    emit({ type: 'source', newEvents: [], quiet: true });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const api = { use, current: () => target, subscribe };
  for (const name of METHODS) api[name] = (...args) => target[name](...args);
  attach();
  return api;
}
