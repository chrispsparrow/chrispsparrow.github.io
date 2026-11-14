// data-panel.js
// Panel 2 for a store: the graphs and readings for whatever main.js is
// showing from a store (a saved flight today, a live flight source later).
// The live board on USB has its own panel, js/live/bench-panel.js, which
// reads the board's status blocks instead of a store.
//
//   createDataPanel(root, ctx) -> { destroy() }
//     root   the empty element in panel 2 to fill (#fc-data-replay)
//     ctx    what every view gets from main.js:
//            store      the store to read (subscribe to it for changes)
//            player     the replay's player, or null for live data
//            config     js/config.js
//            prescan    Map of rocketId -> { profile, events, state } for
//                       the whole flight (empty for live data)
//            flight     { entry, truth, badRows, badRowDetails, files, notes,
//                       sampleCount } for a saved flight
//            link       the replay's address, for COPY LINK
//            navigate   main.js's navigate(target)
//
// For now it holds the mission timeline and the flight details.
//
// Used by: main.js.

import { h, setChildren } from './dom.js';
import { createEventLog } from './event-log.js?v=2';
import { createFlightInfo } from './flight-info.js?v=3';

export function createDataPanel(root, ctx) {
  const log = h('div', { class: 'fc-data-log' });
  const info = h('div', {});
  setChildren(root, log, h('div', { class: 'fc-data-about' }, info));
  const views = [];
  for (const [mount, make] of [[log, createEventLog], [info, createFlightInfo]]) {
    try {
      views.push(make(mount, ctx));
    } catch (err) {
      console.error('Flight Console: a part of the graphs panel failed to start', err);
    }
  }
  return {
    destroy() {
      for (const view of views) {
        try { view?.destroy?.(); } catch (err) { console.error('Flight Console: error closing a view', err); }
      }
      root.replaceChildren();
    },
  };
}
