// launcher.js
// The landing at /flight-console/ (no ?track or ?flight= in the address).
//
//   createLanding(root)
//     index.html holds all of the landing's text: the title and the two
//     buttons. This only starts the moving ocean currents behind the hero,
//     once, with the fish where the fish slot is, and shows the plain logo
//     tuna in the slot whenever the currents can't draw the fish.
//     hero-currents.js pauses them by itself while the landing is hidden,
//     the tab is in the background or the hero is scrolled away, and shows
//     one still frame for visitors who ask for reduced motion.
//
// The saved flights live in the console's SAVED FLIGHTS dropdown
// (saved-menu.js). Used by: main.js.

import { startCurrents } from '../hero-currents.js?v=1';

// ------------------------------------------------------------------
// Landing
// ------------------------------------------------------------------

// root is the landing <section>.
export function createLanding(root) {
  const canvas = root.querySelector('.fc-hero-water-canvas');
  const fishSlot = root.querySelector('.fc-hero-fish');
  // Started once and left running: it stops drawing on its own whenever
  // there is nothing to see. A real-data currents animation could take its
  // place later by exporting the same start function shape.
  let stopCurrents = null;
  // data-currents tells the CSS the currents draw the fish, so the plain
  // logo it shows in the fish slot without them goes away. It comes off
  // again if they can't draw the fish (no JavaScript, a failed start, or a
  // fish outline that didn't load in time), so the slot shows the logo instead.
  root.dataset.currents = 'on';
  const onFish = (drawn) => {
    if (drawn) root.dataset.currents = 'on';
    else delete root.dataset.currents;
  };
  try {
    stopCurrents = canvas ? startCurrents(canvas, { fishSlot, onFish }) : null;
  } catch (err) {
    // A background that fails must never take the page down.
    console.error('Flight Console: the hero background failed to start', err);
  }
  if (!stopCurrents) delete root.dataset.currents;
  return {
    destroy() {
      stopCurrents?.();
      stopCurrents = null;
    },
  };
}
