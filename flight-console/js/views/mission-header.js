// mission-header.js
// The top of the console. On the left: an "All flights" link back to the
// launcher, the focused rocket's name and color, and small labels that say
// whether the flight is simulated or real, plus the honesty flags ("Data
// starts in flight", "Ground level estimated"). On the right: a "Copy link"
// button and a big gold flight clock (T+m:ss, or "On pad") that stops at
// the landing, with a caption that says when the liftoff time was only
// estimated.
// Where the data came from is shown in "About this flight" (flight-info.js).
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { formatFlightClock, MISSING } from '../geo.js';

export function createMissionHeader(root, ctx) {
  const { store, flight, config } = ctx;
  const entry = flight.entry;
  const isReal = entry.kind === 'real';

  // Back to the launcher. A plain click goes through navigate() so the page
  // doesn't reload. Middle click or Ctrl+click still opens a new tab.
  const back = h('a', {
    class: 'fc-mission-back',
    href: launcherHref(ctx.link),
    onclick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      ctx.navigate({ launcher: true });
    },
  }, iconNode(uiIcon('arrowLeft', 18)), 'All flights');

  const dot = h('span', { class: 'fc-dot fc-mission-dot', 'aria-hidden': 'true' });
  const name = h('span', { class: 'fc-mission-name' });
  const flags = h('div', { class: 'fc-mission-flags' });
  const clock = h('p', { class: 'fc-mission-clock' });
  const caption = h('p', { class: 'fc-mission-caption' });

  // The button keeps both labels stacked in the same spot and shows one, so
  // it never changes width when "Link copied" appears.
  const copyButton = h('button', { type: 'button', class: 'fc-btn fc-btn--sm fc-mission-copy', onclick: copyLink },
    h('span', { class: 'fc-copy-face fc-copy-face--idle' }, iconNode(uiIcon('link', 17)), 'Copy link'),
    h('span', { class: 'fc-copy-face fc-copy-face--done' }, iconNode(uiIcon('check', 17)), 'Link copied'));
  // Always in the page (even when empty) so screen readers announce it.
  const copyStatus = h('span', { class: 'sr-only', role: 'status' });
  const copyFallback = h('div', { class: 'fc-mission-fallback', hidden: true });

  setChildren(root, h('header', { class: 'fc-mission' },
    h('div', { class: 'fc-mission-nav' }, back),
    h('div', { class: 'fc-mission-actions' }, copyButton, copyStatus),
    h('div', { class: 'fc-mission-id' },
      h('h1', { class: 'fc-mission-title' }, dot, name),
      flags),
    h('div', { class: 'fc-mission-time' }, clock, caption),
    copyFallback));

  let copyTimer = null;
  async function copyLink() {
    clearTimeout(copyTimer);
    copyFallback.hidden = true;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ctx.link);
        copied = true;
      }
    } catch { copied = false; }
    if (!copied) copied = copyWithSelection(ctx.link);
    if (copied) {
      copyButton.classList.add('fc-mission-copy--done');
      setText(copyStatus, 'Link copied');
      copyTimer = setTimeout(() => {
        copyButton.classList.remove('fc-mission-copy--done');
        setText(copyStatus, '');
      }, config.LINK_COPIED_MS);
    } else {
      // The browser blocked copying, so show the link to copy by hand,
      // already selected.
      copyButton.classList.remove('fc-mission-copy--done');
      setText(copyStatus, '');
      const field = h('input', {
        id: 'fc-copy-field',
        class: 'fc-mission-field',
        type: 'text',
        readOnly: true,
        value: ctx.link,
        onfocus: (e) => e.target.select(),
      });
      setChildren(copyFallback,
        h('label', { class: 'fc-mission-field-label', for: 'fc-copy-field' }, 'Copying was blocked. Here is the link:'),
        field);
      copyFallback.hidden = false;
      field.focus({ preventScroll: true });
      field.select();
    }
  }

  function render() {
    const rocket = store.getFocused();
    const d = rocket?.derived;
    dot.style.setProperty('--dot', rocket?.profile.color ?? 'var(--fc-muted)');
    setText(name, rocket?.profile.name ?? 'No rocket yet');

    // The clock: "--" until there is data, "On pad" before liftoff, then
    // the time since liftoff on the store's clock. Once the landing is
    // detected it stops at the landing time, so it agrees with the phase
    // strip and the launcher's flight time.
    let state;
    const landed = d?.events?.landed;
    if (!d || d.phase === 'waiting') {
      state = 'idle';
      setText(clock, MISSING);
      setText(caption, 'Starts at liftoff');
    } else if (d.liftoffT === null) {
      state = 'pad';
      setText(clock, 'On pad');
      setText(caption, 'Starts at liftoff');
    } else if (landed) {
      state = 'landed';
      setText(clock, formatFlightClock(Math.max(0, landed.t - d.liftoffT)));
      setText(caption, d.liftoffEstimated ? 'Total flight time, liftoff estimated' : 'Total flight time');
    } else {
      state = 'running';
      const now = store.getNow() ?? d.lastT;
      setText(clock, formatFlightClock(Math.max(0, now - d.liftoffT)));
      setText(caption, d.liftoffEstimated ? 'Flight time, liftoff estimated' : 'Flight time');
    }
    if (clock.dataset.state !== state) clock.dataset.state = state;

    // Labels: simulated or real, then anything the console had to estimate.
    const wanted = [[isReal ? 'Real flight' : 'Simulated flight', isReal ? 'fc-pill--real' : 'fc-pill--sim']];
    if (d?.startedInFlight) wanted.push(['Data starts in flight', 'fc-pill--warn']);
    if (d?.groundEstimated) wanted.push(['Ground level estimated', 'fc-pill--warn']);
    const key = wanted.map((w) => w[0]).join('|');
    if (flags.dataset.key !== key) {
      flags.dataset.key = key;
      setChildren(flags, wanted.map(([text, cls]) => h('span', { class: `fc-pill ${cls}` }, text)));
    }
  }

  const scheduler = createScheduler(render, { maxFps: config.HEADER_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    // A new focus or a fresh start shows at once. Playback can wait a frame.
    if (change.type === 'focus' || change.type === 'reset' || change.type === 'clear') scheduler.flush();
    else scheduler.schedule();
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      clearTimeout(copyTimer);
    },
  };
}

// The launcher's address: this flight's link without the ?flight= part.
function launcherHref(link) {
  const url = new URL(link, window.location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

// Older way to copy text, for browsers without the clipboard API.
function copyWithSelection(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
