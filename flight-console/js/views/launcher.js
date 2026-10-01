// launcher.js
// The launcher screen at /flight-console/: the featured flight as a large
// card, every other flight as a smaller card, and notes when the library
// didn't load or an entry had to be skipped. It only ever uses the manifest
// (index.json), never a flight's data files, so it loads fast.
// The intro text and the live tracking card are plain HTML in index.html.
// Used by: main.js.

import { h, setChildren, formatDate } from './dom.js';
import { formatNumber, formatDuration, metersToFeet, MISSING } from '../geo.js';

// root is the launcher <section>. options.hrefFor(id) gives a flight's URL,
// options.onWatch(id) opens it.
export function createLauncher(root, { hrefFor, onWatch }) {
  const notes = root.querySelector('#fc-launch-notes');
  const featuredBox = root.querySelector('#fc-featured');
  const libraryBox = root.querySelector('#fc-library');

  function renderLoading() {
    setChildren(notes);
    setChildren(featuredBox, h('p', { class: 'fc-wait' }, 'Loading the flight library...'));
    setChildren(libraryBox);
  }

  function render(manifest) {
    const noteItems = [];
    if (manifest.error) {
      const text = {
        network: 'The flight library didn\'t load, so I can\'t show any flights right now. Check your internet connection and refresh the page.',
        server: 'The flight library didn\'t load because the site had a problem. Refresh the page in a moment to try again.',
      }[manifest.errorKind] ?? 'The flight library didn\'t load because the flight list on the site is missing or damaged. That\'s on my end, not yours.';
      noteItems.push(h('p', { class: 'fc-note' }, text));
    }
    const skipped = manifest.problems?.length ?? 0;
    if (skipped) {
      noteItems.push(h('p', { class: 'fc-note' },
        skipped === 1
          ? 'One flight in the library couldn\'t be read, so it\'s hidden for now.'
          : `${skipped} flights in the library couldn't be read, so they're hidden for now.`));
    }
    setChildren(notes, noteItems);

    if (manifest.error) {
      setChildren(featuredBox, h('p', { class: 'fc-empty' }, 'No flights to show until the library loads.'));
      setChildren(libraryBox);
      return;
    }

    const flights = manifest.flights ?? [];
    if (!flights.length) {
      setChildren(featuredBox, h('p', { class: 'fc-empty' }, 'There are no flights in the library yet.'));
      setChildren(libraryBox);
      return;
    }

    // The flight marked featured, or the newest one if none is.
    const featured = flights.find((f) => f.featured) ?? flights[0];
    setChildren(featuredBox, flightCard(featured, true));

    const others = flights.filter((f) => f !== featured);
    setChildren(libraryBox, others.length
      ? h('div', { class: 'fc-library-grid' }, others.map((f) => flightCard(f, false)))
      : h('p', { class: 'fc-empty' }, 'This is the only flight in the library so far. My real flights will show up here after launch day.'));
  }

  function flightCard(entry, featured) {
    const s = entry.summary ?? {};
    const boards = entry.rockets.map((r) => r.board).filter(Boolean);
    const boardLine = entry.rockets.length === 1
      ? (boards[0] ? `Board: ${boards[0]}` : `Rocket: ${entry.rockets[0].name}`)
      : `${entry.rockets.length} rockets: ${joinNames(entry.rockets.map((r) => r.name))}`;

    const watch = h('a', {
      class: `fc-btn fc-btn-primary${featured ? ' fc-btn-lg' : ''}`,
      href: hrefFor(entry.id),
      'aria-label': `Watch ${entry.title}`,
      onclick: (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onWatch(entry.id);
      },
    }, 'Watch');

    const info = h('div', { class: 'fc-flight-card' },
      h('h3', { class: 'fc-flight-title' }, entry.title),
      h('p', {}, h('span', { class: `fc-flag ${entry.kind === 'real' ? 'fc-flag--real' : 'fc-flag--sim'}` },
        entry.kind === 'real' ? 'Real flight' : 'Simulated flight')),
      h('p', { class: 'fc-flight-sub' }, formatDate(entry.date)),
      h('p', { class: 'fc-flight-sub' }, boardLine),
      entry.site ? h('p', { class: 'fc-flight-sub' }, `Launch site: ${entry.site}`) : null,
      entry.description ? h('p', { class: 'fc-flight-desc' }, entry.description) : null);

    const facts = h('dl', { class: 'fc-facts' },
      fact('Max altitude above ground', altitudeValue(s.maxAglM)),
      fact('Flight duration', Number.isFinite(s.flightDurationS) ? formatDuration(s.flightDurationS) : MISSING));

    if (featured) {
      return h('article', { class: 'fc-card fc-flight-card--featured' },
        ['tl', 'tr', 'bl', 'br'].map((c) => h('span', { class: `hero-corner ${c}`, 'aria-hidden': 'true' })),
        info,
        h('div', { class: 'fc-flight-card' }, facts, h('div', { class: 'fc-flight-actions' }, watch)));
    }
    return h('article', { class: 'fc-card fc-flight-card' },
      info, facts, h('div', { class: 'fc-flight-actions' }, watch));
  }

  return { render, renderLoading, destroy() {} };
}

function fact(label, value) {
  return h('div', { class: 'fc-fact' },
    h('dt', { class: 'fc-fact-label' }, label),
    h('dd', { class: 'fc-fact-value' }, value));
}

// "3,000 m" with "9,843 ft" smaller next to it, or "--".
function altitudeValue(m) {
  if (!Number.isFinite(m)) return MISSING;
  return [`${formatNumber(m, 0)} m`, h('span', { class: 'fc-ft' }, `${formatNumber(metersToFeet(m), 0)} ft`)];
}

// "A", "A and B", "A, B and C"
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
