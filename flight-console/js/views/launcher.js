// launcher.js
// The launcher screen at /flight-console/. index.html holds its fixed text
// and drawings: the hero (title, contour lines and the gold flight arc),
// How it works and the live tracking card. This file fills in everything
// that comes from the flight library (index.json):
//   - the hero buttons, "Watch the demo flight" and "How it works"
//   - the apogee label on the hero arc, and the arc's one-time draw
//   - the featured flight card: the flight's cover picture or a map picture
//     of its track (launcher-map.js), the altitude line, four stats and a
//     Watch button
//   - the "Watch a flight" link in How it works
//   - the flight library, one row per flight
//   - notes when the library didn't load or an entry had to be skipped
// It only ever uses the manifest and the featured flight's cover picture,
// never a flight's data files, so it loads fast.
// Used by: main.js.

import { h, svg, setChildren, formatDate, prefersReducedMotion } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { formatNumber, formatDuration, formatDistance, metersToFeet, MISSING } from '../geo.js';
import { createFlightPicture } from './launcher-map.js';

// How long the hero arc takes to draw itself, plus a little spare (ms).
// After this the draw class comes off, so coming back from a flight shows
// the arc already drawn. Matches the animation times in the launcher part of flight-console.css.
const ARC_DRAW_MS = 3400;
// The altitude line's drawing box (it stretches to the card's width).
const SPARK_W = 600;
const SPARK_H = 100;

// root is the launcher <section>. options.hrefFor(id) gives a flight's URL,
// options.onWatch(id) opens it. config and libs.leaflet are for the
// featured card's picture.
export function createLauncher(root, { hrefFor, onWatch, config, libs }) {
  const hero = root.querySelector('.fc-hero');
  const actions = root.querySelector('#fc-hero-actions');
  const apogeeLabel = root.querySelector('.fc-arc-label');
  const apogeeValue = root.querySelector('#fc-arc-apogee');
  const notes = root.querySelector('#fc-launch-notes');
  const featuredSection = root.querySelector('.fc-featured-section');
  const featuredBox = root.querySelector('#fc-featured');
  const howSection = root.querySelector('#fc-how');
  const howTitle = root.querySelector('#fc-how-title');
  const howWatch = root.querySelector('#fc-how-watch');
  const libraryBox = root.querySelector('#fc-library');

  let shown = null;          // the manifest on screen now
  let picture = null;        // the featured card's picture
  let howWatchId = null;     // the flight the "Watch a flight" link opens

  // A button, not a #link: the site's script turns every #link into its
  // own smooth scroll with a history entry.
  const howButton = h('button', { type: 'button', class: 'fc-btn fc-btn--outline fc-btn--lg', onclick: scrollToHow }, 'How it works');

  // The arc draws itself once, the first time the launcher opens. With
  // reduced motion it is simply there (the launcher CSS only animates under
  // no-preference, this check just skips adding the class).
  let drawTimer = null;
  if (hero && !prefersReducedMotion()) {
    hero.classList.add('fc-hero--draw');
    drawTimer = setTimeout(() => hero.classList.remove('fc-hero--draw'), ARC_DRAW_MS);
  }

  const onHowWatch = (e) => {
    if (!howWatchId || isModifiedClick(e)) return;
    e.preventDefault();
    onWatch(howWatchId);
  };
  howWatch?.addEventListener('click', onHowWatch);

  renderActions(null, { loading: true });

  // While the manifest downloads. Coming back from a flight, the library is
  // already on screen and render() follows at once with the same manifest,
  // so it stays as it is.
  function renderLoading() {
    if (shown && !shown.error) return;
    shown = null;
    picture?.destroy();
    picture = null;
    setChildren(notes);
    renderActions(null, { loading: true });
    setApogee(null);
    setHowWatch(null);
    featuredSection.hidden = false;
    setChildren(featuredBox, h('div', { class: 'fc-card fc-feature-wait' },
      h('p', { class: 'fc-wait' }, 'Loading the flight library...')));
    setChildren(libraryBox);
  }

  function render(manifest) {
    if (manifest === shown) {
      picture?.refresh();
      return;
    }
    shown = manifest;
    picture?.destroy();
    picture = null;

    setChildren(notes, noteItems(manifest));
    const flights = manifest.error ? [] : (manifest.flights ?? []);
    // The flight marked featured, or the newest one if none is.
    const featured = flights.find((f) => f.featured) ?? flights[0] ?? null;

    renderActions(featured);
    setApogee(featured);
    setHowWatch(featured);
    featuredSection.hidden = !featured;
    setChildren(featuredBox, featured ? featuredCard(featured) : null);

    if (manifest.error) {
      setChildren(libraryBox, h('p', { class: 'fc-empty' }, 'No flights to show until the library loads.'));
    } else if (!flights.length) {
      setChildren(libraryBox, h('p', { class: 'fc-empty' }, 'There are no flights in the library yet.'));
    } else {
      setChildren(libraryBox, h('ul', { class: 'fc-lib' }, flights.map(libraryRow)));
    }
  }

  // ------------------------------------------------------------------
  // Hero
  // ------------------------------------------------------------------

  // The watch button is disabled while loading and left out if there is no
  // flight to watch.
  function renderActions(featured, { loading = false } = {}) {
    let watch = null;
    if (featured) {
      watch = watchLink(featured.id, { class: 'fc-btn fc-btn--gold fc-btn--lg' },
        iconNode(uiIcon('play', 20)), 'Watch the demo flight');
    } else if (loading) {
      watch = h('button', { type: 'button', class: 'fc-btn fc-btn--gold fc-btn--lg', disabled: true },
        iconNode(uiIcon('play', 20)), 'Watch the demo flight');
    }
    setChildren(actions, watch, howButton);
  }

  function scrollToHow() {
    if (!howSection) return;
    howSection.scrollIntoView({ behavior: prefersReducedMotion() ? 'instant' : 'smooth', block: 'start' });
    howTitle?.focus({ preventScroll: true });
  }

  // "Apogee 3,000 m" at the top of the arc, from the featured flight's
  // summary. Hidden when the summary has no apogee.
  function setApogee(featured) {
    if (!apogeeLabel || !apogeeValue) return;
    const m = featured?.summary?.maxAglM;
    if (Number.isFinite(m)) {
      apogeeValue.textContent = `${formatNumber(m, 0)} m`;
      apogeeLabel.removeAttribute('hidden');
    } else {
      apogeeLabel.setAttribute('hidden', '');
    }
  }

  function setHowWatch(featured) {
    if (!howWatch) return;
    howWatchId = featured?.id ?? null;
    howWatch.hidden = !howWatchId;
    if (howWatchId) howWatch.href = hrefFor(howWatchId);
  }

  // ------------------------------------------------------------------
  // Featured flight card
  // ------------------------------------------------------------------
  function featuredCard(entry) {
    const s = entry.summary ?? {};
    const titleId = 'fc-feature-flight-title';
    picture = createFlightPicture(entry, { config, libs });
    return h('article', { class: `fc-card fc-feature${picture ? '' : ' fc-feature--no-pic'}` },
      picture?.el,
      h('div', { class: 'fc-feature-body' },
        h('p', { class: 'fc-eyebrow fc-feature-eyebrow' },
          'Featured flight',
          h('span', { class: 'sr-only' }, ','),
          h('span', { class: 'fc-feature-sep', 'aria-hidden': 'true' }, '·'),
          kindWord(entry)),
        h('h3', { id: titleId, class: 'fc-feature-title' }, entry.title),
        metaLine(entry),
        sparkline(s),
        h('dl', { class: 'fc-feature-stats' },
          stat('Apogee', altitudeValue(s.maxAglM), 'fc-stat--apogee'),
          // flightDurationS is liftoff to landing only when both were
          // detected. Otherwise add_flight stores the whole recording's
          // length, so it gets that name instead.
          stat(hasEvents(s, 'liftoff', 'landed') ? 'Flight time' : 'Recording length',
            Number.isFinite(s.flightDurationS) ? formatDuration(s.flightDurationS) : MISSING),
          stat('Drift from pad', formatDistance(s.driftM)),
          stat('Farthest from ground station', [
            formatDistance(s.maxGsDistanceM),
            s.gsDemo && Number.isFinite(s.maxGsDistanceM)
              ? h('span', { class: 'fc-stat-note' }, 'Measured from the demo ground station position')
              : null,
          ])),
        h('div', { class: 'fc-feature-actions' },
          watchLink(entry.id, { class: 'fc-btn fc-btn--gold fc-btn--lg', 'aria-describedby': titleId },
            iconNode(uiIcon('play', 20)), 'Watch flight'))));
  }

  // ------------------------------------------------------------------
  // Flight library: one row per flight, the whole row is the link.
  // ------------------------------------------------------------------
  function libraryRow(entry) {
    const s = entry.summary ?? {};
    const date = formatDate(entry.date);
    const kind = kindWord(entry);
    const apogee = Number.isFinite(s.maxAglM) ? `${formatNumber(s.maxAglM, 0)} m` : MISSING;
    const name = `Watch ${entry.title}. ${kind} flight, ${date}${Number.isFinite(s.maxAglM) ? `, apogee ${apogee}` : ''}.`;
    return h('li', { class: 'fc-lib-item' },
      watchLink(entry.id, { class: 'fc-lib-row', 'aria-label': name },
        h('span', { class: 'fc-lib-title' }, entry.title),
        h('span', { class: 'fc-lib-meta' },
          h('span', { class: 'fc-lib-date' }, date),
          h('span', { class: `fc-pill fc-lib-kind ${entry.kind === 'real' ? 'fc-pill--real' : 'fc-pill--sim'}` }, kind),
          h('span', { class: 'fc-lib-alt' },
            h('span', { class: 'fc-lib-alt-label' }, 'Apogee'), ' ',
            h('span', { class: `fc-lib-alt-value fc-num${apogee === MISSING ? ' fc-missing' : ''}` }, apogee))),
        h('span', { class: 'fc-lib-go', 'aria-hidden': 'true' }, 'Watch', iconNode(uiIcon('chevron', 16)))));
  }

  // A link to a flight: its real URL, so middle click and Ctrl+click open a
  // new tab, while a plain left click opens it in place.
  function watchLink(id, attrs, ...children) {
    return h('a', {
      ...attrs,
      href: hrefFor(id),
      onclick: (e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        onWatch(id);
      },
    }, ...children);
  }

  return {
    render,
    renderLoading,
    destroy() {
      clearTimeout(drawTimer);
      hero?.classList.remove('fc-hero--draw');
      howWatch?.removeEventListener('click', onHowWatch);
      picture?.destroy();
      picture = null;
    },
  };
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
      network: 'The flight library didn\'t load, so I can\'t show any flights right now. Check your internet connection and refresh the page.',
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

// Date and board, two parts kept apart by CSS (a thin divider that hides
// itself when the second part wraps to a new line), with a comma only
// screen readers hear. Several rockets: "3 rockets".
function metaLine(entry) {
  const rockets = entry.rockets ?? [];
  const who = rockets.length > 1
    ? `${rockets.length} rockets`
    : (rockets[0]?.board ?? rockets[0]?.name ?? null);
  return h('p', { class: 'fc-feature-meta' },
    h('span', { class: 'fc-feature-meta-row' },
      h('span', { class: 'fc-feature-meta-part' }, formatDate(entry.date)),
      who ? h('span', { class: 'sr-only' }, ', ') : null,
      who ? h('span', { class: 'fc-feature-meta-part' }, who) : null));
}

// The whole flight's altitude above ground from summary.altProfile
// ([[seconds from liftoff, m or null], ...]), as a small gold line with a
// soft fill under it. null is a stretch with no altitude, drawn as a break.
function sparkline(s) {
  const profile = s.altProfile ?? [];
  const known = profile.filter((p) => p[1] !== null);
  if (known.length < 2) return null;
  const t0 = Math.min(...profile.map((p) => p[0]));
  const t1 = Math.max(...profile.map((p) => p[0]));
  const top = Math.max(...known.map((p) => p[1]));
  if (!(t1 > t0) || !(top > 0)) return null;
  const x = (t) => ((t - t0) / (t1 - t0)) * SPARK_W;
  const y = (m) => SPARK_H - 4 - (Math.max(0, m) / top) * (SPARK_H - 12);
  const base = SPARK_H - 4;

  // Runs of known points, split at each null.
  const runs = [];
  let run = [];
  for (const [t, m] of profile) {
    if (m === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push([x(t), y(m)]);
    }
  }
  if (run.length) runs.push(run);

  const fmt = (v) => v.toFixed(1);
  const line = runs.map((r) => r.map(([px, py], i) => `${i ? 'L' : 'M'}${fmt(px)} ${fmt(py)}`).join('')).join('');
  const area = runs.filter((r) => r.length > 1)
    .map((r) => `M${fmt(r[0][0])} ${base}${r.map(([px, py]) => `L${fmt(px)} ${fmt(py)}`).join('')}L${fmt(r[r.length - 1][0])} ${base}Z`).join('');
  const peak = known.reduce((a, b) => (b[1] > a[1] ? b : a));
  const highest = Number.isFinite(s.maxAglM) ? s.maxAglM : peak[1];

  return h('div', { class: 'fc-spark' },
    h('p', { class: 'fc-spark-cap', 'aria-hidden': 'true' }, 'Altitude over the flight'),
    svg('svg', {
      class: 'fc-spark-chart',
      viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `Altitude over the flight, highest point ${formatNumber(highest, 0)} m`,
      focusable: 'false',
    },
    svg('defs', {},
      svg('linearGradient', { id: 'fc-spark-fill', x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: 0, class: 'fc-spark-stop-top' }),
        svg('stop', { offset: 1, class: 'fc-spark-stop-bottom' }))),
    svg('path', { class: 'fc-spark-base', d: `M0 ${base}H${SPARK_W}` }),
    svg('path', { class: 'fc-spark-area', d: area }),
    svg('path', { class: 'fc-spark-line', d: line }),
    // A zero-length line with a round cap is a dot that stays round even
    // though the drawing stretches sideways.
    svg('path', { class: 'fc-spark-peak', d: `M${fmt(x(peak[0]))} ${fmt(y(peak[1]))}h0` })));
}

// True when the summary lists every one of these flight events.
function hasEvents(summary, ...types) {
  return Array.isArray(summary.events) && types.every((t) => summary.events.includes(t));
}

// A missing value shows "--" in muted text, never in the value color.
function stat(label, value, extraClass = '') {
  const missing = value === MISSING || (Array.isArray(value) && value[0] === MISSING);
  return h('div', { class: `fc-stat ${extraClass}`.trim() },
    h('dt', { class: 'fc-stat-label' }, label),
    h('dd', { class: `fc-stat-value fc-num${missing ? ' fc-missing' : ''}` }, value));
}

// "3,000 m" with "9,843 ft" smaller next to it, or "--".
function altitudeValue(m) {
  if (!Number.isFinite(m)) return MISSING;
  return [`${formatNumber(m, 0)} m`, h('span', { class: 'fc-ft' }, `${formatNumber(metersToFeet(m), 0)} ft`)];
}
