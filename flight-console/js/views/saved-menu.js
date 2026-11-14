// saved-menu.js
// The SAVED FLIGHTS dropdown in the console's bar: a small log, one line
// per flight in the library (data/flights/index.json), with its name, date
// and flight time, plus a LIVE line at the top for the live console. The
// line for what is on screen now is marked (aria-current).
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
// Used by: main.js.

import { h, setChildren } from './dom.js';
import { formatDuration } from '../geo.js';

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

  // ------------------------------------------------------------------
  // Contents
  // ------------------------------------------------------------------
  function renderLoading() {
    if (shown && !shown.error) return;
    shown = null;
    setChildren(menu, list([liveItem()]), h('p', { class: 'fc-dd-note' }, 'Loading the saved flights...'));
  }

  function render(manifest) {
    if (manifest === shown) return;
    shown = manifest;
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
    setChildren(menu,
      list([liveItem(), ...flights.map(flightItem)]),
      notes.map((text) => h('p', { class: 'fc-dd-note' }, text)));
    markCurrent();
  }

  function list(items) {
    return h('ul', { class: 'fc-dd-list', 'aria-label': 'Saved flights' }, items);
  }

  function liveItem() {
    return h('li', {}, link(liveHref, () => onLive(), { class: 'fc-dd-item fc-dd-item--live', 'data-id': 'live', 'aria-label': 'Live console' },
      h('span', { class: 'fc-dd-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'fc-dd-name' }, 'LIVE')));
  }

  // One line: the name, the date and the flight time.
  function flightItem(entry) {
    const s = entry.summary ?? {};
    const date = shortDate(entry.date);
    const time = Number.isFinite(s.flightDurationS) ? formatDuration(s.flightDurationS) : null;
    const label = [entry.title, date, time ? `${time} flight` : null].filter(Boolean).join(', ');
    return h('li', {}, link(hrefFor(entry.id), () => onOpen(entry.id), { class: 'fc-dd-item', 'data-id': entry.id, 'aria-label': label },
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

  const items = () => [...menu.querySelectorAll('.fc-dd-item')];

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
    setCurrent,
    close,
    destroy() {
      button.removeEventListener('click', onButtonClick);
      button.removeEventListener('keydown', onButtonKey);
      menu.removeEventListener('keydown', onMenuKey);
      root.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown);
    },
  };
}

// "Sep 30, 2026".
function shortDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate ?? '';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
