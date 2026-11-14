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
// Changes from the store behind the switch (new samples, a reset after a
// seek, ...) reach the switch's subscribers unchanged. Changes from a
// store that is no longer behind the switch never do.
//
//   const stage = createStoreSwitch(liveStore);
//   createMapView(root, { store: stage, ... });   // made once
//   stage.use(replayStore);                       // a saved flight opened
//   stage.use(liveStore);                         // back to live
//
// It has every method a store has (see store.js), plus:
//   use(store)   switch to another store. Switching to the store already
//                in use does nothing (no 'source' change).
//   current()    the real store behind it right now
//   destroy()    stops listening to the store behind it and forgets every
//                subscriber
//
// Used by: main.js. No DOM.

// Every method store.js has. A method the store gains later is passed on
// too, as long as the first store has it.
const METHODS = [
  'addSample', 'addSamples', 'setTime', 'reset', 'clearAll', 'registerRocket', 'setPrescan', 'focus',
  'getRockets', 'getRocket', 'getFocused', 'getFocusedId', 'getEvents', 'getGroundStation', 'getNow',
  'getTotals', 'ageOf', 'isSilent', 'gpsIsQuiet', 'hasFixNow', 'altitudeIsOld', 'flightTimeOf',
];
// Names the switch answers itself.
const OWN = new Set(['use', 'current', 'subscribe', 'destroy']);

function isStore(value) {
  return Boolean(value) && typeof value.subscribe === 'function' && typeof value.getRockets === 'function';
}

export function createStoreSwitch(initial) {
  if (!isStore(initial)) throw new Error('createStoreSwitch needs a store to start with');
  const listeners = new Set();
  let target = initial;
  let detach = null;

  function emit(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (err) { console.error('Flight Console view error:', err); }
    }
  }

  // Listens to one store. A change only gets through while that store is
  // still the one behind the switch.
  function attach(store) {
    detach = store.subscribe((change) => {
      if (store === target) emit(change);
    });
  }

  function use(next) {
    if (!isStore(next)) throw new Error('use() needs a store');
    if (next === target) return;
    detach?.();
    target = next;
    attach(next);
    emit({ type: 'source', newEvents: [], quiet: true });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function destroy() {
    detach?.();
    detach = null;
    listeners.clear();
  }

  const api = { use, current: () => target, subscribe, destroy };
  const names = new Set(METHODS);
  for (const [name, value] of Object.entries(initial)) if (typeof value === 'function') names.add(name);
  for (const name of names) {
    if (OWN.has(name)) continue;
    api[name] = (...args) => {
      if (typeof target[name] !== 'function') throw new Error(`the store in use has no ${name}()`);
      return target[name](...args);
    };
  }
  attach(initial);
  return api;
}
