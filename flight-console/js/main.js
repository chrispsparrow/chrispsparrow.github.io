// main.js
// The page's starting point. It reads the URL and shows one of three things:
//   /flight-console/              the launcher (flight library)
//   /flight-console/?flight=<id>  the console, playing that flight
//   a friendly message            while loading, or if the flight is unknown
//                                 or its data didn't load
// "Watch" and "All flights" change the URL with history.pushState, and the
// browser's back and forward buttons fire "popstate", which runs route()
// again. Opening a flight builds a brand new store, player and set of views.
// Leaving it destroys all of them, so nothing from one flight can linger in
// the next.
//
// Used by: index.html (<script type="module" src="js/main.js">).

import * as config from './config.js';
import { loadManifest, loadFlight } from './library.js';
import { createStore } from './store.js';
import { createPlayer } from './player.js';
import { createFleet } from './fleet.js';
import { h, setChildren } from './views/dom.js';
import { createLauncher } from './views/launcher.js';
import { createMissionHeader } from './views/mission-header.js';
import { createRocketBar } from './views/rocket-bar.js';
import { createPhaseStrip } from './views/phase-strip.js';
import { createMapView } from './views/map-view.js';
import { createAltTape } from './views/alt-tape.js';
import { createStatsPanel } from './views/stats-panel.js';
import { createTimeline } from './views/timeline.js';
import { createEventLog } from './views/event-log.js';
import { createFlightInfo } from './views/flight-info.js';
import { createDebugPanel } from './views/debug-panel.js';

const PAGE_TITLE = 'Flight Console | Dogtooth Systems';
const $ = (id) => document.getElementById(id);
const sections = { launcher: $('fc-launcher'), console: $('fc-console'), message: $('fc-message') };
const MOUNTS = ['fc-mission', 'fc-rocketbar', 'fc-phases', 'fc-map', 'fc-tape', 'fc-stats', 'fc-timeline', 'fc-log', 'fc-info', 'fc-debug'];

// Tells the load-failure check in index.html that this module started.
window.fcStarted = true;

// ------------------------------------------------------------------
// The map library (Leaflet). Checked fresh for every console that opens,
// and once for the launcher's map picture:
//   ready  resolves to the library, or to null if it failed or took longer
//          than LIBRARY_LOAD_TIMEOUT_MS, so nothing ever waits on it.
//   late   resolves if the library finishes loading after that, so the map
//          can switch from its fallback to the real view.
// ------------------------------------------------------------------
function watchLibrary(globalName, scriptId) {
  const script = $(scriptId);
  const found = () => window[globalName] ?? null;
  const failed = () => !script || script.dataset.state === 'failed';
  const late = new Promise((resolve) => {
    if (found()) { resolve(found()); return; }
    if (failed()) return; // a failed download never arrives
    script.addEventListener('load', () => { if (found()) resolve(found()); }, { once: true });
  });
  const ready = new Promise((resolve) => {
    if (found()) { resolve(found()); return; }
    if (failed()) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), config.LIBRARY_LOAD_TIMEOUT_MS);
    late.then((lib) => { clearTimeout(timer); resolve(lib); });
    script.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
  });
  return { ready, late };
}

// ------------------------------------------------------------------
// Which CARTO map key to use. The live site uses the public key in
// config.js. On my laptop (localhost or 127.0.0.1) CARTO refuses that key,
// so the page loads js/config.local.js, which is never committed, and uses
// its key. On any other host config.local.js is never requested.
// Resolves to { key, source: 'public' | 'local' | 'missing-local' }.
// ------------------------------------------------------------------
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const tileKey = (async () => {
  if (!LOCAL_HOSTS.includes(window.location.hostname)) {
    return { key: config.TILE_API_KEY, source: 'public' };
  }
  try {
    const local = await import('./config.local.js');
    if (local.TILE_API_KEY_LOCAL) return { key: local.TILE_API_KEY_LOCAL, source: 'local' };
  } catch {
    // No config.local.js on this computer.
  }
  return { key: '', source: 'missing-local' };
})();

// ------------------------------------------------------------------
// The manifest is downloaded once and reused. A failed download is
// forgotten, so the next visit to the launcher tries again.
// ------------------------------------------------------------------
let manifestPromise = null;
function getManifest() {
  if (!manifestPromise) {
    manifestPromise = loadManifest().then((manifest) => {
      if (manifest.error) manifestPromise = null;
      return manifest;
    });
  }
  return manifestPromise;
}

// ------------------------------------------------------------------
// URLs and navigation
// ------------------------------------------------------------------
function launcherUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url;
}

function flightUrl(id) {
  const url = launcherUrl();
  url.searchParams.set('flight', id);
  return url;
}

// target is { flight: id } or { launcher: true }.
function navigate(target) {
  const url = target.flight ? flightUrl(target.flight) : launcherUrl();
  if (url.href !== window.location.href) {
    window.history.pushState(target.flight ? { flight: target.flight } : {}, '', url);
  }
  moveFocus = true;
  route();
}

// After switching screens inside the page (not on the first load), keyboard
// focus moves to the new screen's main heading, so it isn't left behind on
// a link that just disappeared.
let moveFocus = false;
function focusHeading(el) {
  if (!moveFocus || !el) return;
  moveFocus = false;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

// A link that goes through navigate() on a plain click, but still works
// normally with a middle click or Ctrl+click (new tab).
function internalLink(text, target, className = '') {
  const href = target.flight ? flightUrl(target.flight).href : launcherUrl().href;
  return h('a', {
    href,
    class: className,
    onclick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(target);
    },
  }, text);
}

function show(name) {
  for (const [key, el] of Object.entries(sections)) el.hidden = key !== name;
}

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
let routeToken = 0;      // bumps on every route, so late async results are ignored
let session = null;      // the open console: { store, player, views }
let launcher = null;

async function route() {
  const id = new URLSearchParams(window.location.search).get('flight');
  // Only the #part of the address changed (popstate fires for that too):
  // the same flight is already playing, so leave it alone.
  if (session && id !== null && id.trim() === session.id) return;
  const token = ++routeToken;
  closeConsole();
  // A new screen starts at the top at once, never with a smooth scroll.
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (id === null || id.trim() === '') await showLauncher(token);
  else await openFlight(id.trim(), token);
}

async function showLauncher(token) {
  show('launcher');
  document.title = PAGE_TITLE;
  if (!launcher) {
    launcher = createLauncher(sections.launcher, {
      hrefFor: (id) => flightUrl(id).href,
      onWatch: (id) => navigate({ flight: id }),
      config,
      libs: { leaflet: watchLibrary('L', 'fc-lib-leaflet') },
    });
  }
  launcher.renderLoading();
  const manifest = await getManifest();
  if (token !== routeToken) return;
  launcher.render(manifest);
  focusHeading($('fc-launcher-title'));
}

function showMessage(title, paragraphs, { retry = false } = {}) {
  show('message');
  const actions = h('p', { class: 'fc-message-actions' },
    internalLink('See all flights', { launcher: true }, 'fc-btn fc-btn--gold'),
    retry ? ' ' : null,
    retry ? h('button', { type: 'button', class: 'fc-btn', onclick: () => route() }, 'Try again') : null);
  const heading = h('h1', {}, title);
  setChildren(sections.message, h('div', { class: 'fc-card' },
    heading,
    paragraphs.map((p) => h('p', {}, p)),
    actions));
  focusHeading(heading);
}

async function openFlight(id, token) {
  document.title = PAGE_TITLE;
  show('message');
  setChildren(sections.message, h('p', { class: 'fc-wait' }, 'Loading the flight...'));

  const manifest = await getManifest();
  if (token !== routeToken) return;
  if (manifest.error) {
    console.warn('Flight library did not load:', manifest.error);
    const why = {
      network: 'Check your internet connection and try again.',
      server: 'The site had a problem sending it. Try again in a moment.',
    }[manifest.errorKind] ?? 'The flight list on the site is missing or damaged. That\'s on my end, not yours.';
    showMessage('The flight library didn\'t load', [
      'I couldn\'t load the list of flights, so this flight can\'t open right now.',
      why,
    ], { retry: true });
    return;
  }

  const entry = manifest.flights.find((f) => f.id === id);
  if (!entry) {
    const broken = manifest.problems.find((p) => p.id === id);
    if (broken) {
      showMessage('This flight can\'t open', [`The library entry for "${id}" has a problem, so it can't open.`, 'The other flights still work.']);
    } else {
      showMessage('Flight not found', [`There's no flight called "${id}" in the library. It may have been renamed or removed.`]);
    }
    return;
  }

  let flight;
  try {
    flight = await loadFlight(entry);
  } catch (err) {
    if (token !== routeToken) return;
    console.warn('Flight data did not load:', err);
    const why = {
      network: [`The data for "${entry.title}" couldn't be downloaded.`, 'Check your internet connection and try again.'],
      server: [`The site had a problem sending the data for "${entry.title}".`, 'Try again in a moment.'],
      missing: [`The data file for "${entry.title}" is missing from the site. That's on my end, not yours.`],
      damaged: [`The data for "${entry.title}" downloaded but couldn't be read.`],
    }[err?.kind] ?? [`The data for "${entry.title}" couldn't be loaded.`];
    showMessage('This flight\'s data didn\'t load', why, { retry: err?.kind === 'network' || err?.kind === 'server' });
    return;
  }
  if (token !== routeToken) return;

  if (!flight.samples.some((s) => s.type !== 'gs')) {
    showMessage('No readable data', [
      `"${entry.title}" loaded, but none of its lines could be read as telemetry (${flight.badRows} bad line${flight.badRows === 1 ? '' : 's'} skipped).`,
    ]);
    return;
  }
  startConsole(entry, flight);
}

// ------------------------------------------------------------------
// The console
// ------------------------------------------------------------------
function startConsole(entry, flight) {
  show('console');
  document.title = `${entry.title} | Flight Console | Dogtooth Systems`;

  const store = createStore({ fleet: createFleet() });
  for (const r of entry.rockets) store.registerRocket({ id: r.rocketId, name: r.name, board: r.board });

  // A rocket in the data that the manifest doesn't list is added now, in the
  // order it first appears, so every view knows it before playback reaches
  // its first reading.
  for (const s of flight.samples) {
    if (s.type !== 'gs' && !store.getRocket(s.rocketId)) store.registerRocket({ id: s.rocketId });
  }

  const player = createPlayer({ store });
  const ctx = {
    store,
    player,
    config,
    libs: { leaflet: watchLibrary('L', 'fc-lib-leaflet') },
    tileKey,
    // Each rocket's whole-flight altitude curve and events, for the timeline
    // and the altitude tape's scale. See prescanFlight() below.
    prescan: prescanFlight(entry, flight.samples),
    flight: {
      entry,
      truth: flight.truth,
      badRows: flight.badRows,
      badRowDetails: flight.badRowDetails,
      files: flight.files,
      notes: flight.files.flatMap((f) => f.notes ?? []),
      sampleCount: flight.samples.length,
    },
    link: flightUrl(entry.id).href,
    navigate,
  };

  const makers = [
    ['fc-mission', createMissionHeader],
    ['fc-rocketbar', createRocketBar],
    ['fc-phases', createPhaseStrip],
    ['fc-map', createMapView],
    ['fc-tape', createAltTape],
    ['fc-stats', createStatsPanel],
    ['fc-timeline', createTimeline],
    ['fc-log', createEventLog],
    ['fc-info', createFlightInfo],
    ['fc-debug', createDebugPanel],
  ];
  const views = [];
  for (const [mountId, make] of makers) {
    const mount = $(mountId);
    try {
      views.push(make(mount, ctx));
    } catch (err) {
      // One broken view must not take the rest of the console down.
      console.error(`Flight Console: the ${mountId} view failed to start`, err);
      setChildren(mount, h('div', { class: 'fc-panel' }, h('p', { class: 'fc-wait' }, 'This part of the console hit an error. The rest still works.')));
    }
  }

  session = { id: entry.id, store, player, views };
  focusHeading(sections.console.querySelector('h1'));
  player.load(flight.samples);
  player.setSpeed(config.DEFAULT_SPEED);
  player.play();
}

// ------------------------------------------------------------------
// Whole-flight pre-scan for the timeline. A second store, never shown,
// takes the whole flight at once (in the same order the player uses), so
// every rocket's full altitude curve and events are known before playback
// gets there. It is a separate copy with its own detectors: nothing it
// works out reaches the live store, and the live views never read it as
// "now". Returns rocketId -> {
//   profile    [{ t, agl }] one point per altitude reading, in data time.
//              agl is null where a reading should have had an altitude and
//              didn't (a GPS fix gap), which the timeline draws as a break.
//              Heights use the ground level frozen at liftoff.
//   events     every event the detector found, in order
//   state      the detector's final state (maxAgl, liftoffT, events, ...)
// }
// ------------------------------------------------------------------
function prescanFlight(entry, samples) {
  const scan = createStore({ fleet: createFleet() });
  for (const r of entry.rockets) scan.registerRocket({ id: r.rocketId, name: r.name, board: r.board });
  const ordered = samples
    .filter((s) => s && Number.isFinite(s.t))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map((x) => x.s);
  scan.addSamples(ordered, { quiet: true });
  const out = new Map();
  for (const rocket of scan.getRockets()) {
    const state = rocket.derived;
    const ground = state?.groundRef;
    const profile = Number.isFinite(ground)
      ? rocket.altSeries.map((p) => Object.freeze({ t: p.t, agl: p.alt === null ? null : p.alt - ground }))
      : [];
    out.set(rocket.id, Object.freeze({ profile: Object.freeze(profile), events: Object.freeze(rocket.events.slice()), state }));
  }
  scan.clearAll();
  return out;
}

function closeConsole() {
  if (!session) return;
  session.player.destroy();
  for (const view of session.views) {
    try { view?.destroy?.(); } catch (err) { console.error('Flight Console: error closing a view', err); }
  }
  session.store.clearAll();
  for (const id of MOUNTS) $(id).replaceChildren();
  session = null;
}

window.addEventListener('popstate', () => {
  moveFocus = true;
  route();
});
route();
