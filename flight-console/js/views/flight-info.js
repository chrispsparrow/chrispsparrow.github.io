// flight-info.js
// "About this flight": where the data on this page came from, as a
// compact strip in panel 2, under the mission timeline.
//
// Closed, it is one line that still says where the data came from:
// simulated or real, and the data file (or how many files). Open, it
// shows the flight's title and description, the date and launch site, the
// board each rocket carried, each data file with how many readings it
// held and how many bad lines were skipped, and anything the parser had
// to adjust while reading a file (a board restart, say). So the page
// always says where its data came from.
//
// [ COPY LINK ] sits on the closed line and copies the replay's address,
// to share it. If the browser blocks copying, the link shows in a field,
// selected and ready to copy by hand.
//
// Nothing here changes while the flight plays, so it draws once.
//
//   createFlightInfo(root, ctx) -> { destroy() }
//     ctx.flight   { entry, files, notes } for the saved flight
//     ctx.link     the replay's address, for COPY LINK
//
// Used by: js/views/data-panel.js. Reads ctx.flight, never other views.

import { h, setText, setChildren, formatDate, rocketDot } from './dom.js?v=2';
import { formatNumber } from '../geo.js?v=3';

let nextId = 0;

export function createFlightInfo(root, ctx) {
  const { flight, store, config } = ctx;
  const entry = flight.entry;
  const real = entry.kind === 'real';
  const id = `fc-info-${++nextId}`;
  const files = flight.files ?? [];

  // One row of the details list. Rows with nothing to say are left out.
  const rows = [];
  const row = (label, ...values) => rows.push(h('dt', {}, label), h('dd', {}, ...values));

  if (entry.date) row('Date', formatDate(entry.date));
  if (entry.site) row('Launch site', entry.site);

  // The board on each rocket, as the flight library lists it.
  const boards = entry.rockets.filter((r) => r.board);
  if (entry.rockets.length === 1 && boards.length === 1) {
    row('Board', boards[0].board);
  } else if (boards.length) {
    row('Boards', boards.map((r) => {
      const color = store.getRocket(r.rocketId)?.profile.color;
      return h('span', { class: 'fc-info-line fc-info-rocket' },
        color ? rocketDot(color) : null,
        h('span', { class: 'fc-info-strong' }, r.name),
        h('span', { class: 'fc-info-soft' }, r.board));
    }));
  }

  // Each data file with its reading count and bad lines.
  if (files.length) {
    row(files.length === 1 ? 'Data file' : 'Data files', files.map((f) => {
      // Each part stays on one line, so a wrap only falls between parts.
      const counts = [countText(f.sampleCount, 'reading', 'readings'), badLinesText(f.badRows)].filter(Boolean);
      return h('span', { class: 'fc-info-line' },
        h('span', { class: 'fc-info-strong' }, f.file),
        counts.map((text) => [', ', h('span', { class: 'fc-info-keep' }, text)]));
    }));
  }

  // Anything the parser or library had to adjust, said plainly.
  const notes = flight.notes ?? [];
  if (notes.length) row('Notes', notes.map((note) => h('span', { class: 'fc-info-line fc-info-note' }, note)));

  // The closed line: simulated or real, and the file.
  const fileText = files.length === 1 ? files[0].file : files.length ? `${files.length} data files` : '';

  // COPY LINK keeps both labels stacked in the same spot and shows one, so
  // it never changes width when LINK COPIED appears.
  const copyButton = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm fc-copy', onclick: copyLink },
    h('span', { class: 'fc-copy-face fc-copy-face--idle' }, 'COPY LINK'),
    h('span', { class: 'fc-copy-face fc-copy-face--done', 'aria-hidden': 'true' }, 'LINK COPIED'));
  // Always in the page (even when empty) so screen readers announce it.
  const copyStatus = h('span', { class: 'sr-only', role: 'status' });
  const copyFallback = h('div', { class: 'fc-copy-fallback', hidden: true });

  const toggle = h('button', {
    type: 'button', class: 'fc-strip-toggle', 'aria-expanded': 'false', 'aria-controls': `${id}-body`,
    onclick: () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'),
  },
  h('span', { class: 'fc-strip-caret', 'aria-hidden': 'true' }),
  h('span', { class: 'fc-strip-name' }, 'About this flight'),
  h('span', { class: 'fc-strip-latest' },
    h('span', { class: `fc-info-kind${real ? ' fc-info-kind--real' : ''}` }, real ? 'Real flight' : 'Simulated flight'),
    fileText ? h('span', { class: 'fc-strip-msg fc-info-file' }, fileText) : null));

  const body = h('div', { class: 'fc-strip-body fc-info-body', id: `${id}-body`, hidden: true },
    h('h3', { class: 'fc-info-title' }, entry.title),
    entry.description ? h('p', { class: 'fc-info-desc' }, entry.description) : null,
    rows.length ? h('dl', { class: 'fc-info-list' }, rows) : null);

  const strip = h('section', { class: 'fc-strip fc-info', 'aria-label': 'About this flight' },
    h('div', { class: 'fc-strip-row' }, toggle, h('div', { class: 'fc-strip-actions' }, copyButton, copyStatus)),
    copyFallback,
    body);
  setChildren(root, strip);

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    strip.classList.toggle('is-open', open);
  }

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
      copyButton.classList.add('fc-copy--done');
      setText(copyStatus, 'Link copied');
      copyTimer = setTimeout(() => {
        copyButton.classList.remove('fc-copy--done');
        setText(copyStatus, '');
      }, config.LINK_COPIED_MS);
    } else {
      // The browser blocked copying, so show the link to copy by hand,
      // already selected.
      copyButton.classList.remove('fc-copy--done');
      setText(copyStatus, '');
      const field = h('input', {
        id: `${id}-field`,
        class: 'fc-copy-field',
        type: 'text',
        readOnly: true,
        value: ctx.link,
        onfocus: (e) => e.target.select(),
      });
      setChildren(copyFallback,
        h('label', { class: 'fc-copy-field-label', for: `${id}-field` }, 'Copying was blocked, so here is the link to copy.'),
        field);
      copyFallback.hidden = false;
      field.focus({ preventScroll: true });
      field.select();
    }
  }

  return {
    destroy() {
      clearTimeout(copyTimer);
    },
  };
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

// "1 reading", "246 readings". Null when the count isn't known.
function countText(n, one, many) {
  if (!Number.isFinite(n)) return null;
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

// "no bad lines", "1 bad line skipped", "3 bad lines skipped". Null when
// the count isn't known, so it never claims a clean file by mistake.
function badLinesText(n) {
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 'no bad lines';
  return `${formatNumber(n)} bad ${n === 1 ? 'line' : 'lines'} skipped`;
}
