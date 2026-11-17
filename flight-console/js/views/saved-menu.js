// saved-menu.js
// The SAVED FLIGHTS dropdown in the console's bar: a small log, one line
// per flight in the library (data/flights/index.json), with its name, date
// and flight time, plus a LIVE line at the top for the live console. The
// line for what is on screen now is marked (aria-current).
//
// Under the library's flights come the LOCAL ones, the flights this browser
// keeps (recordings and loaded files, see js/local/). Each is tagged LOCAL
// and has EXPORT RAW LOG, EXPORT CSV and DELETE under it. DELETE asks first,
// in place. Then a short note that they live in this browser only, and
// LOAD FILE. local-console.js gives them to it with setLocal().
//
// Every line is a real link, so a middle click or Ctrl+click still opens a
// new tab. A plain click opens the replay (or goes back to live) in place,
// through onOpen(id) or onLive().
//
// Keyboard: the button opens it (Enter, Space or the down arrow), the up
// and down arrows move between the lines, Home and End go to the first and
// last, and Escape closes it and puts focus back on the button. Tabbing
// out of it or clicking anywhere else closes it too.
//
// It only ever reads the manifest, never a flight's data files.
// Used by: main.js and js/views/local-console.js.

import { h, setChildren } from './dom.js?v=2';
import { formatDuration } from '../geo.js?v=3';

// root holds the button and the menu.
//   hrefFor(id)   a flight's real address
//   liveHref      the live console's address
//   onOpen(id)    a plain click on a flight
//   onLive()      a plain click on LIVE
export function createSavedMenu(root, { hrefFor, liveHref, onOpen, onLive }) {
  const button = root.querySelector('.fc-dd-button');
  const menu = root.querySelector('.fc-dd-menu');
  let shown = null;        // the manifest on screen now
  let current = 'live';    // 'live' or the id of the open flight
  // The LOCAL flights and what their buttons do (see setLocal()). null
  // until local-console.js has read them.
  let local = null;
  let confirming = null;   // the LOCAL flight whose DELETE is asking, or null

  // ------------------------------------------------------------------
  // Contents
  // ------------------------------------------------------------------
  function renderLoading() {
    if (shown && !shown.error) return;
    shown = null;
    draw();
  }

  function render(manifest) {
    if (manifest === shown) return;
    shown = manifest;
    draw();
  }

  // The LOCAL flights:
  //   flights     their records, newest first (js/local/flight-db.js)
  //   persistent  false when this browser won't store them (memory only)
  //   exports(record) -> { rawLog, csv }: which exports it can have
  //   onExport(id, kind)  kind is 'raw' or 'csv'
  //   onDelete(id)        after DELETE was confirmed
  //   onLoadFile()        LOAD FILE
  function setLocal(next) {
    local = next;
    if (confirming && !local.flights.some((f) => f.id === confirming)) confirming = null;
    draw();
  }

  // Everything in the menu, from the manifest (or "Loading") and the LOCAL
  // flights. Focus stays on the same control when it can.
  function draw() {
    const focusKey = keyOf(document.activeElement);
    const builtIn = shown ? libraryPart(shown) : { items: [], notes: ['Loading the saved flights...'] };
    setChildren(menu,
      list([liveItem(), ...builtIn.items]),
      builtIn.notes.map((text) => h('p', { class: 'fc-dd-note' }, text)),
      localPart());
    markCurrent();
    // A control that went away (a deleted flight's) hands focus to LOAD
    // FILE, so it stays in the open menu.
    if (focusKey && isOpen()) (menu.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) ?? menu.querySelector('.fc-dd-load'))?.focus();
  }

  const keyOf = (el) => (el instanceof Element && menu.contains(el) ? el.dataset.key ?? null : null);

  function libraryPart(manifest) {
    const flights = manifest.error ? [] : (manifest.flights ?? []);
    const notes = [];
    if (manifest.error) {
      notes.push({
        network: 'The flight library didn\'t load. Check your internet connection and refresh the page.',
        server: 'The flight library didn\'t load because the site had a problem. Refresh the page in a moment.',
      }[manifest.errorKind] ?? 'The flight library didn\'t load because the list on the site is missing or damaged. That\'s on my end, not yours.');
    } else if (!flights.length) {
      notes.push('There are no saved flights yet.');
    }
    const skipped = manifest.problems?.length ?? 0;
    if (skipped) {
      notes.push(skipped === 1
        ? 'One flight in the library couldn\'t be read, so it\'s hidden for now.'
        : `${skipped} flights in the library couldn't be read, so they're hidden for now.`);
    }
    return { items: flights.map(flightItem), notes };
  }

  // The LOCAL flights, the note about where they're kept, and LOAD FILE.
  function localPart() {
    if (!local) return null;
    const note = local.persistent
      ? 'LOCAL FLIGHTS ARE STORED IN THIS BROWSER ONLY. EXPORT A RAW LOG TO KEEP ONE.'
      : 'THIS BROWSER WON\'T STORE FLIGHTS, SO LOCAL FLIGHTS LAST UNTIL THE PAGE CLOSES. EXPORT A RAW LOG TO KEEP ONE.';
    return h('div', { class: 'fc-dd-local' },
      local.flights.length ? h('ul', { class: 'fc-dd-list', 'aria-label': 'Local flights' }, local.flights.map(localItem)) : null,
      h('p', { class: 'fc-dd-fine' }, note),
      h('p', { class: 'fc-dd-load-row' },
        h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm fc-dd-load', 'data-key': 'load', onclick: () => local.onLoadFile() }, 'LOAD FILE')));
  }

  // A LOCAL flight: its line, tagged LOCAL, then its buttons.
  function localItem(record) {
    const id = record.id;
    const date = shortDate(localIsoDate(record.createdAt));
    const time = Number.isFinite(record.durationS) ? formatDuration(record.durationS) : null;
    const label = [record.title, 'local', date, time ? `${time} long` : null].filter(Boolean).join(', ');
    const can = local.exports(record);
    const button = (key, text, onclick, extra = {}) => h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', 'data-key': `${key}:${id}`, onclick, ...extra }, text);
    const actions = confirming === id
      ? h('div', { class: 'fc-dd-actions is-asking', role: 'group', 'aria-label': `Delete ${record.title}?` },
        h('span', { class: 'fc-dd-ask' }, 'DELETE THIS FLIGHT?'),
        button('yes', 'DELETE', () => { confirming = null; local.onDelete(id); }),
        button('no', 'KEEP', () => { confirming = null; draw(); focusKey(`del:${id}`); }))
      : h('div', { class: 'fc-dd-actions', role: 'group', 'aria-label': record.title },
        can.rawLog ? button('raw', 'EXPORT RAW LOG', () => local.onExport(id, 'raw')) : null,
        can.csv ? button('csv', 'EXPORT CSV', () => local.onExport(id, 'csv')) : null,
        button('del', 'DELETE', () => { confirming = id; draw(); focusKey(`yes:${id}`); }));
    return h('li', { class: 'fc-dd-local-item' },
      link(hrefFor(id), () => onOpen(id), { class: 'fc-dd-item', 'data-id': id, 'data-key': `open:${id}`, 'aria-label': label },
        h('span', { class: 'fc-dd-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'fc-dd-name' }, record.title, ' ', h('span', { class: 'fc-dd-tag' }, 'LOCAL')),
        h('span', { class: 'fc-dd-date' }, date),
        h('span', { class: 'fc-dd-time' }, time ?? '')),
      actions);
  }

  function focusKey(key) {
    menu.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  function list(items) {
    return h('ul', { class: 'fc-dd-list', 'aria-label': 'Saved flights' }, items);
  }

  function liveItem() {
    return h('li', {}, link(liveHref, () => onLive(), { class: 'fc-dd-item fc-dd-item--live', 'data-id': 'live', 'data-key': 'open:live', 'aria-label': 'Live console' },
      h('span', { class: 'fc-dd-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'fc-dd-name' }, 'LIVE')));
  }

  // One line: the name, the date and the flight time.
  function flightItem(entry) {
    const s = entry.summary ?? {};
    const date = shortDate(entry.date);
    const time = Number.isFinite(s.flightDurationS) ? formatDuration(s.flightDurationS) : null;
    const label = [entry.title, date, time ? `${time} flight` : null].filter(Boolean).join(', ');
    return h('li', {}, link(hrefFor(entry.id), () => onOpen(entry.id), { class: 'fc-dd-item', 'data-id': entry.id, 'data-key': `open:${entry.id}`, 'aria-label': label },
      h('span', { class: 'fc-dd-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'fc-dd-name' }, entry.title),
      h('span', { class: 'fc-dd-date' }, date),
      h('span', { class: 'fc-dd-time' }, time ?? '')));
  }

  function link(href, open, attrs, ...children) {
    return h('a', {
      ...attrs,
      href,
      onclick: (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        close({ focus: false });
        open();
      },
    }, ...children);
  }

  // 'live' or a flight id.
  function setCurrent(id) {
    current = id;
    markCurrent();
  }

  function markCurrent() {
    for (const a of items()) {
      if (a.dataset.id === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // What the arrow keys move between: the flights, then LOAD FILE.
  const items = () => [...menu.querySelectorAll('.fc-dd-item, .fc-dd-load')];

  // ------------------------------------------------------------------
  // Opening and closing
  // ------------------------------------------------------------------
  const isOpen = () => !menu.hidden;

  function open({ focus = null } = {}) {
    if (!isOpen()) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      root.classList.add('is-open');
    }
    const all = items();
    if (focus === 'first') all[0]?.focus();
    else if (focus === 'last') all[all.length - 1]?.focus();
    else if (focus === 'current') (all.find((a) => a.dataset.id === current) ?? all[0])?.focus();
  }

  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    const inside = root.contains(document.activeElement);
    if (confirming) {
      confirming = null;
      draw();
    }
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    if (focus && inside) button.focus();
  }

  function onButtonClick() {
    if (isOpen()) close();
    else open();
  }

  function onButtonKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); open({ focus: 'current' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open({ focus: 'last' }); }
    else if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
  }

  function onMenuKey(e) {
    const all = items();
    const i = all.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = all[(i + 1) % all.length];
    else if (e.key === 'ArrowUp') next = all[(i - 1 + all.length) % all.length];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    } else return;
    e.preventDefault();
    next?.focus();
  }

  // Tabbing out of the dropdown closes it.
  function onFocusOut(e) {
    if (isOpen() && e.relatedTarget && !root.contains(e.relatedTarget)) close({ focus: false });
  }

  // A click anywhere else closes it.
  function onPointerDown(e) {
    if (isOpen() && !root.contains(e.target)) close({ focus: false });
  }

  button.addEventListener('click', onButtonClick);
  button.addEventListener('keydown', onButtonKey);
  menu.addEventListener('keydown', onMenuKey);
  root.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onPointerDown);
  renderLoading();

  return {
    render,
    renderLoading,
    setLocal,
    setCurrent,
    close,
    open,
    destroy() {
      button.removeEventListener('click', onButtonClick);
      button.removeEventListener('keydown', onButtonKey);
      menu.removeEventListener('keydown', onMenuKey);
      root.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown);
    },
  };
}

// "2026-11-17" for a time in ms, on this computer's clock.
function localIsoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "Sep 30, 2026".
function shortDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate ?? '';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
