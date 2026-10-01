// icons.js
// The small drawings the page shares, as SVG markup strings: the rocket, the
// launch rail, the ground station tower, and the button icons. The map uses
// the strings inside Leaflet markers, other views turn them into elements
// with iconNode(). Every map drawing has a dark outline under it (the
// "halo" group), so it shows on bright photos and on the dark map alike.
//
// The rocket always points straight up. No board sends orientation data
// yet, so the icon never turns to suggest which way the rocket points.
// Used by: map-view.js, launcher.js, launcher-map.js, mission-header.js,
// stats-panel.js, timeline.js and debug-panel.js.

import { HALO_COLOR, PAD_COLOR, GROUND_STATION_COLOR } from '../config.js';

// The colors come from config.js, so changing one there changes the icons
// too: the dark outline (HALO_COLOR), the off-white of the launch rail and
// the rocket's body (PAD_COLOR) and the ground station's teal
// (GROUND_STATION_COLOR).
const HALO = HALO_COLOR;
const OFF_WHITE = PAD_COLOR;
const TEAL = GROUND_STATION_COLOR;

// ------------------------------------------------------------------
// Rocket: nose cone, body, two fins, a small round window and a nozzle,
// pointing up. The whole outline is one path, so the "no GPS fix" look
// (grey and hollow, switched on by CSS through the classes) is one clean
// line. The drawing is centered in its box, so the middle of the icon is
// the rocket's position.
// ------------------------------------------------------------------
const ROCKET_OUTLINE =
  'M12 2C15.4 4.6 17 8.4 17 12.5V19L20.8 24.8V29.6L17 27.2H14.8L15.6 30H8.4L9.2 27.2H7' +
  'L3.2 29.6V24.8L7 19V12.5C7 8.4 8.6 4.6 12 2Z';
const ROCKET_FINS = 'M17 19L20.8 24.8V29.6L17 27.2ZM7 19L3.2 24.8V29.6L7 27.2Z';
const ROCKET_NOZZLE = 'M9.2 27.2H14.8L15.6 30H8.4Z';

// The rocket's box: 24 by 34 units, with the drawing (y 2 to 30) centered.
const ROCKET_VIEW = [24, 34];

// Pixel size of the rocket icon for a drawn height. Both sides are even,
// so the middle lands on a whole pixel.
export function rocketBox(size = 30) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return [even((size * ROCKET_VIEW[0]) / ROCKET_VIEW[1]), even(size)];
}

// size is the drawn height in px.
export function rocketSvg(size = 30) {
  const [width, height] = rocketBox(size);
  return `<svg class="fc-ico-rocket" viewBox="0 -1 ${ROCKET_VIEW[0]} ${ROCKET_VIEW[1]}" width="${width}" height="${height}" aria-hidden="true" focusable="false">` +
    `<path class="fc-rkt-halo" d="${ROCKET_OUTLINE}" fill="${HALO}" stroke="${HALO}" stroke-width="3" stroke-linejoin="round"/>` +
    `<path class="fc-rkt-body" d="${ROCKET_OUTLINE}" fill="${OFF_WHITE}" stroke-linejoin="round"/>` +
    `<path class="fc-rkt-fins" d="${ROCKET_FINS}" fill="#B4B0A6"/>` +
    `<path class="fc-rkt-nozzle" d="${ROCKET_NOZZLE}" fill="#7D7A73"/>` +
    `<circle class="fc-rkt-window" cx="12" cy="13.4" r="2.2" fill="#0A0F1A"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Launch rail: a thin vertical rail on a three-legged stand, with a small
// square blast plate at the base. A faint ring underneath marks the exact
// spot. PAD_ANCHOR is the bottom middle of the blast plate (and the ring's
// center), which sits exactly on the pad coordinate.
// ------------------------------------------------------------------
export const PAD_SIZE = Object.freeze([22, 28]);
export const PAD_ANCHOR = Object.freeze([11, 21]);
const PAD_LINES = '<path d="M11 1.5V18.5M11 10.5L4 21M11 10.5L18 21M11 10.5L14.6 17.6"/>';
const PAD_PLATE = '<rect x="7.5" y="18.5" width="7" height="2.5"/>';

export function padSvg() {
  return `<svg class="fc-ico-pad" viewBox="0 0 22 28" width="22" height="28" aria-hidden="true" focusable="false">` +
    `<circle class="fc-pad-ring" cx="11" cy="21" r="5.5" fill="none" stroke="${OFF_WHITE}" stroke-opacity="0.45" stroke-width="1.2"/>` +
    `<g fill="none" stroke="${HALO}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${PAD_LINES}</g>` +
    `<g fill="${HALO}" stroke="${HALO}" stroke-width="2" stroke-linejoin="round">${PAD_PLATE}</g>` +
    `<g fill="none" stroke="${OFF_WHITE}" stroke-width="1.5" stroke-linecap="round">${PAD_LINES}</g>` +
    `<g fill="${OFF_WHITE}">${PAD_PLATE}</g>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Ground station: an A-frame radio mast with cross braces, a dot on top and
// two signal arcs above it. TOWER_ANCHOR is the middle of its base, which
// sits on the ground station coordinate.
// ------------------------------------------------------------------
export const TOWER_SIZE = Object.freeze([26, 32]);
export const TOWER_ANCHOR = Object.freeze([13, 30]);
const TOWER_LINES =
  '<path d="M6 30L13 11M20 30L13 11M8.2 24H17.8M10.4 18H15.6M8.2 24L15.6 18M17.8 24L10.4 18M6 30L17.8 24M20 30L8.2 24"/>' +
  '<path d="M9.56 7.09A4.2 4.2 0 0 1 16.44 7.09M7.33 4.74A7.4 7.4 0 0 1 18.67 4.74"/>';

export function towerSvg() {
  return `<svg class="fc-ico-tower" viewBox="0 0 26 32" width="26" height="32" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke="${HALO}" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round">${TOWER_LINES}</g>` +
    `<circle cx="13" cy="9.5" r="3.4" fill="${HALO}"/>` +
    `<g fill="none" stroke="${TEAL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${TOWER_LINES}</g>` +
    `<circle cx="13" cy="9.5" r="2" fill="${TEAL}"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Button icons, 24 by 24, drawn in the text color (currentColor).
// ------------------------------------------------------------------
const UI = {
  play: '<path d="M8 5.5V18.5L18.5 12Z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5.5" width="3.8" height="13" rx="0.8" fill="currentColor"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="0.8" fill="currentColor"/>',
  replay: '<path d="M5.5 12A6.5 6.5 0 1 0 8 6.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.6 3.2V7.4H4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowLeft: '<path d="M19 12H5.5M11 6L5 12L11 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  link: '<path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.1 1.1M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.1-1.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5L10 17.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="M9 6L15 12L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

// name is one of the keys above. size is in px.
export function uiIcon(name, size = 18) {
  return `<svg class="fc-ui-ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${UI[name] ?? ''}</svg>`;
}

// Turns markup from this file into an element, for views that build pages
// with h(). The markup here is fixed, never built from data.
export function iconNode(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}
