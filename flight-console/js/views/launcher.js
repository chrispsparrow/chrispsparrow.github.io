// launcher.js
// Two small pieces of the page that don't belong to a flight:
//
//   createLanding(root)
//     The landing at /flight-console/ (no ?track or ?flight= in the
//     address). index.html holds all of its text: the title and the two
//     buttons. This only starts the moving ocean currents behind the hero,
//     once, with the fish where the fish slot is, and shows the plain logo
//     tuna in the slot whenever the currents can't draw the fish.
//     hero-currents.js pauses them by itself while the landing is hidden,
//     the tab is in the background or the hero is scrolled away, and shows
//     one still frame for visitors who ask for reduced motion.
//
//   createSavedFlights(root, { hrefFor, onOpen })
//     The "Saved flights" list inside the console (the pane under the live
//     panels). One row per flight in the library (index.json), newest
//     first, where the whole row is the link. A plain click opens the
//     replay in place through onOpen(id). A middle click or Ctrl+click
//     still opens a new tab, since every row has the flight's real address.
//     Under the list go notes when the library didn't load or an entry had
//     to be skipped. It only ever reads the manifest, never a flight's data
//     files, so it loads fast.
//
// Used by: main.js.

import { h, setChildren, formatDate } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { formatNumber, MISSING } from '../geo.js';
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

// ------------------------------------------------------------------
// Saved flights
// ------------------------------------------------------------------

// root holds the list. notesRoot (optional) gets the notes.
export function createSavedFlights(root, { notesRoot = null, hrefFor, onOpen }) {
  let shown = null;   // the manifest on screen now

  // While the manifest downloads. Coming back from a flight, the list is
  // already on screen and render() follows at once with the same manifest,
  // so it stays as it is.
  function renderLoading() {
    if (shown && !shown.error) return;
    shown = null;
    if (notesRoot) setChildren(notesRoot);
    setChildren(root, h('p', { class: 'fc-wait' }, 'Loading the saved flights...'));
  }

  function render(manifest) {
    if (manifest === shown) return;
    shown = manifest;
    if (notesRoot) setChildren(notesRoot, noteItems(manifest));
    const flights = manifest.error ? [] : (manifest.flights ?? []);
    if (manifest.error) {
      setChildren(root, h('p', { class: 'fc-empty' }, 'No flights to show until the library loads.'));
    } else if (!flights.length) {
      setChildren(root, h('p', { class: 'fc-empty' }, 'There are no saved flights yet.'));
    } else {
      setChildren(root, h('ul', { class: 'fc-lib' }, flights.map(libraryRow)));
    }
  }

  // One row per flight: the whole row is the link.
  function libraryRow(entry) {
    const s = entry.summary ?? {};
    const date = formatDate(entry.date);
    const kind = kindWord(entry);
    const apogee = Number.isFinite(s.maxAglM) ? `${formatNumber(s.maxAglM, 0)} m` : MISSING;
    const name = `Watch ${entry.title}. ${kind} flight, ${date}${Number.isFinite(s.maxAglM) ? `, apogee ${apogee}` : ''}.`;
    return h('li', { class: 'fc-lib-item' },
      flightLink(entry.id, { class: 'fc-lib-row', 'aria-label': name },
        h('span', { class: 'fc-lib-title' }, entry.title),
        h('span', { class: 'fc-lib-meta' },
          h('span', { class: 'fc-lib-date' }, date),
          h('span', { class: `fc-pill fc-lib-kind ${entry.kind === 'real' ? 'fc-pill--real' : 'fc-pill--sim'}` }, kind),
          h('span', { class: 'fc-lib-alt' },
            h('span', { class: 'fc-lib-alt-label' }, 'Apogee'), ' ',
            h('span', { class: `fc-lib-alt-value fc-num${apogee === MISSING ? ' fc-missing' : ''}` }, apogee))),
        h('span', { class: 'fc-lib-go', 'aria-hidden': 'true' }, 'Watch', iconNode(uiIcon('chevron', 16)))));
  }

  // A link to a flight: its real address, so middle click and Ctrl+click
  // open a new tab, while a plain left click opens it in place.
  function flightLink(id, attrs, ...children) {
    return h('a', {
      ...attrs,
      href: hrefFor(id),
      onclick: (e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        onOpen(id);
      },
    }, ...children);
  }

  return { render, renderLoading };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isModifiedClick(e) {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

function noteItems(manifest) {
  const items = [];
  if (manifest.error) {
    const text = {
      network: 'The flight library didn\'t load, so I can\'t show the saved flights right now. Check your internet connection and refresh the page.',
      server: 'The flight library didn\'t load because the site had a problem. Refresh the page in a moment to try again.',
    }[manifest.errorKind] ?? 'The flight library didn\'t load because the flight list on the site is missing or damaged. That\'s on my end, not yours.';
    items.push(h('p', { class: 'fc-note' }, text));
  }
  const skipped = manifest.problems?.length ?? 0;
  if (skipped) {
    items.push(h('p', { class: 'fc-note' },
      skipped === 1
        ? 'One flight in the library couldn\'t be read, so it\'s hidden for now.'
        : `${skipped} flights in the library couldn't be read, so they're hidden for now.`));
  }
  return items;
}

function kindWord(entry) {
  return entry.kind === 'real' ? 'Real' : 'Simulated';
}
