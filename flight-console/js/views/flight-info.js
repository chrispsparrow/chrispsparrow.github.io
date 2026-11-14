// flight-info.js
// "About this flight": where the data on this page came from. It shows the
// flight's title, whether it is simulated or real, its description, the
// date and launch site, the board each rocket carried, and each data file
// with how many readings it held and how many bad lines were skipped.
// Anything the parser had to adjust while reading a file (a board restart,
// say) is listed too, so the page always says where its data came from.
// A COPY LINK button copies the replay's address, to share it. If the
// browser blocks copying, the link shows in a field, selected and ready to
// copy by hand.
// Nothing else here changes while the flight plays, so it draws once.
// It sits in the console's second panel while a replay is open.
// Used by: main.js. Reads ctx.flight, never other views.

import { h, setText, setChildren, formatDate, rocketDot } from './dom.js';
import { uiIcon, iconNode } from './icons.js?v=2';
import { formatNumber } from '../geo.js';

export function createFlightInfo(root, ctx) {
  const { flight, store, config } = ctx;
  const entry = flight.entry;
  const real = entry.kind === 'real';

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
  const files = flight.files ?? [];
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
  if (notes.length) row('Notes', notes.map((note) => h('span', { class: 'fc-info-line' }, note)));

  // Copy link. The button keeps both labels stacked in the same spot and
  // shows one, so it never changes width when LINK COPIED appears.
  const copyButton = h('button', { type: 'button', class: 'fc-btn fc-btn--xs fc-copy', onclick: copyLink },
    h('span', { class: 'fc-copy-face fc-copy-face--idle' }, iconNode(uiIcon('link', 15)), 'COPY LINK'),
    h('span', { class: 'fc-copy-face fc-copy-face--done' }, iconNode(uiIcon('check', 15)), 'LINK COPIED'));
  // Always in the page (even when empty) so screen readers announce it.
  const copyStatus = h('span', { class: 'sr-only', role: 'status' });
  const copyFallback = h('div', { class: 'fc-copy-fallback', hidden: true });

  setChildren(root, h('section', { class: 'fc-panel fc-info', 'aria-labelledby': 'fc-info-title' },
    h('div', { class: 'fc-panel-head' },
      h('h2', { class: 'fc-panel-title', id: 'fc-info-title' }, 'About this flight'),
      h('div', { class: 'fc-info-actions' },
        h('span', { class: `fc-pill ${real ? 'fc-pill--real' : 'fc-pill--sim'}` }, real ? 'Real flight' : 'Simulated flight'),
        copyButton, copyStatus)),
    copyFallback,
    h('h3', { class: 'fc-info-title' }, entry.title),
    entry.description ? h('p', { class: 'fc-info-desc' }, entry.description) : null,
    rows.length ? h('dl', { class: 'fc-info-list' }, rows) : null));

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
        id: 'fc-copy-field',
        class: 'fc-copy-field',
        type: 'text',
        readOnly: true,
        value: ctx.link,
        onfocus: (e) => e.target.select(),
      });
      setChildren(copyFallback,
        h('label', { class: 'fc-copy-field-label', for: 'fc-copy-field' }, 'Copying was blocked, so here is the link to copy.'),
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
