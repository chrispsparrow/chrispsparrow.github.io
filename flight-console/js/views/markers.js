// markers.js
// The look of everything the 3D view and the 2D map draw on the map, in
// one place, so the two views and the KEY always match:
//   - the breadcrumbs: a small dot per received fix and the thin line that
//     joins the good ones, with their sizes and outline
//   - the Dogtooth board, the launch point and Manta's dish, as SVG markup
//   - the event diamond (apogee, drogue, main, landed) and the recovery
//     crosshair
//   - the packet ring, the radio link and its traveling dot
//   - small samples of each for the KEY, plus one of a gap in the line
// The 3D view turns the SVG markup into small canvases for Cesium. The map
// puts it inside Leaflet markers, and the KEY shows it with iconNode()
// from icons.js. The names next to the markers are drawn by map-labels.js.
//
// The board marker always stands upright and keeps one size on screen. No
// board sends orientation data yet, so it never turns to suggest which way
// the rocket points.
//
// Used by: globe-view.js and map-view.js.

import { HALO_COLOR, PAD_COLOR, COLOR_WHITE } from '../config.js';
import { TRACK_RAMP } from '../track.js';

// The board's blue. #184590 is the soldermask as the 3D viewer on
// projects/avionics-pcb.html renders it, sampled from
// assets/flight-console/dogtooth-board-blue.png (a render with the
// viewer's lighting, where it is the most common color). The model's raw
// material color (mat_29 in avionics-pcb.min.glb, converted to sRGB) is
// #01306F, which is the same blue before any light falls on it and reads
// almost black on a map.
export const BOARD_BLUE = '#184590';
export const OFF_WHITE = PAD_COLOR;     // the theme's off-white, #E8EDF2
export const WHITE = COLOR_WHITE;       // the theme's white, #FFFFFF
export const DIM = '#A0A3A9';           // the theme's dim off-white
export const NEAR_BLACK = HALO_COLOR;   // the theme's near-black, #07060D
const HALO = HALO_COLOR;                // the dark outline

// ------------------------------------------------------------------
// Breadcrumbs: one dot per received fix, joined by a thin line.
// ------------------------------------------------------------------
// A good fix: a solid dot this wide (px) in its speed color, with a dark
// outline this wide (px) around it.
export const DOT_PX = 5;
export const DOT_OUTLINE_PX = 1;
// A weak fix (it failed the quality gate): a hollow grey ring this wide
// (px), drawn in WEAK_COLOR with the same dark outline.
export const WEAK_DOT_PX = 6;
export const WEAK_LINE_PX = 1.25;
export const WEAK_COLOR = DIM;
// The line through the good fixes: this wide (px), in the speed colors,
// with a dark outline this wide (px) on each side.
export const LINE_PX = 2;
export const LINE_OUTLINE_PX = 1;
// Other rockets in a flight with several (not the focused one) get a
// thinner line and smaller dots in their own grey, so the focused board's
// speed colors stand out.
export const OTHER_LINE_PX = 1.5;
export const OTHER_DOT_PX = 4;
// The ground shadow in 3D: the same line laid flat on the terrain under
// the real one, this wide (px), in near-black at this opacity. A wider,
// very faint off-white band under it keeps it findable over dark ground
// (roofs, trees, water), where a dark line alone disappears.
export const SHADOW_PX = 3;
export const SHADOW_ALPHA = 0.5;
export const SHADOW_EDGE_PX = SHADOW_PX + 3;
export const SHADOW_EDGE_ALPHA = 0.2;

// ------------------------------------------------------------------
// The packet ring: one thin white ring that grows out of the board marker
// and fades each time a packet arrives. It grows to RING_PX across over
// RING_MS. A packet that comes while a ring is still running starts no
// new one, so at fast playback it stays one ring at a time. Viewers who
// ask for less motion get no ring.
// ------------------------------------------------------------------
export const RING_PX = 44;
export const RING_MS = 900;
export const RING_LINE_PX = 1.5;
// Each ring starts at this share of its full size.
export const RING_FROM_SCALE = 0.3;

// ------------------------------------------------------------------
// The radio link from the board to Manta: a thin, faint, dashed white
// line. Each packet sends a small white dot along it from the board to
// Manta, taking LINK_TRAVEL_MS (none with less motion asked for).
// ------------------------------------------------------------------
export const LINK_COLOR = WHITE;
export const LINK_ALPHA = 0.5;
// The 3D view draws the link solid, in about the color the faint white
// makes over the ground, so the markers can sit on top of it (a
// see-through line would be drawn after them, over the board).
export const LINK_SOLID = '#C9CCD1';
export const LINK_PX = 1.25;
export const LINK_DASH_PX = [6, 5];
export const LINK_TRAVEL_MS = 700;
export const LINK_DOT_PX = 5;

// ------------------------------------------------------------------
// The Dogtooth board: a plain rounded rectangle in the board's blue with a
// thin off-white outline, upright like the real board (about 3 wide to 4
// tall). The focused board is the larger size. With no GPS fix right now
// it turns hollow: a solid near-black middle and a dim outline (the map
// does the same with CSS, through the .fc-brd-body class). The middle
// stays solid so the launch point, which sits under a board on a desk,
// doesn't show through it.
// ------------------------------------------------------------------
export const BOARD_FOCUSED = Object.freeze([18, 24]);
export const BOARD_OTHER = Object.freeze([14, 18]);
const BOARD_LINE = 1.5;

export function boardSvg([w, h], { hollow = false } = {}) {
  const inset = BOARD_LINE / 2;
  const r = Math.round(Math.min(w, h) * 0.2 * 2) / 2;
  return `<svg class="fc-ico-board" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">` +
    `<rect class="fc-brd-body" x="${inset}" y="${inset}" width="${w - BOARD_LINE}" height="${h - BOARD_LINE}" rx="${r}"` +
    ` fill="${hollow ? NEAR_BLACK : BOARD_BLUE}" stroke="${hollow ? DIM : OFF_WHITE}" stroke-width="${BOARD_LINE}"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// The launch point (where the board sat still before liftoff): a small
// off-white dot with a thin dark ring. Its middle sits on the spot.
// ------------------------------------------------------------------
export const START_SIZE = 12;

export function startSvg() {
  return `<svg class="fc-ico-start" viewBox="0 0 ${START_SIZE} ${START_SIZE}" width="${START_SIZE}" height="${START_SIZE}" aria-hidden="true" focusable="false">` +
    `<circle cx="6" cy="6" r="4.25" fill="${OFF_WHITE}" stroke="${HALO}" stroke-width="1.5"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Manta, the ground station: a small satellite dish in an off-white
// outline, tilted up on a short stand, about the size of the board marker.
// A dark line under the drawing keeps it visible on bright ground.
// DISH_ANCHOR is the middle of the stand's foot, which sits on Manta's
// position.
// ------------------------------------------------------------------
export const DISH_SIZE = Object.freeze([26, 29]);
export const DISH_ANCHOR = Object.freeze([12, 26.5]);
const DISH_LINES =
  // The bowl, open toward the upper right, closed by its rim.
  '<path d="M7 6Q5 22 22 20Z"/>' +
  // The arm out to the feed.
  '<path d="M14.5 13L19 8.2"/>' +
  // The stand and its foot.
  '<path d="M10.2 18.4L12 26.5M8 26.5H16"/>';
const FEED = { cx: 19.8, cy: 7.3 };

export function dishSvg() {
  return `<svg class="fc-ico-dish" viewBox="0 0 ${DISH_SIZE[0]} ${DISH_SIZE[1]}" width="${DISH_SIZE[0]}" height="${DISH_SIZE[1]}" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke="${HALO}" stroke-opacity="0.85" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${DISH_LINES}</g>` +
    `<circle cx="${FEED.cx}" cy="${FEED.cy}" r="2.5" fill="${HALO}" fill-opacity="0.85"/>` +
    `<g fill="none" stroke="${OFF_WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${DISH_LINES}</g>` +
    `<circle cx="${FEED.cx}" cy="${FEED.cy}" r="1.4" fill="${OFF_WHITE}"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// A flight event (apogee, drogue, main, landed): a small white diamond
// with a thin dark outline, on the fix where it happened. Its middle sits
// on the spot.
// ------------------------------------------------------------------
export const DIAMOND_SIZE = 12;

export function diamondSvg() {
  const c = DIAMOND_SIZE / 2;
  const r = c - 1.4;
  return `<svg class="fc-ico-diamond" viewBox="0 0 ${DIAMOND_SIZE} ${DIAMOND_SIZE}" width="${DIAMOND_SIZE}" height="${DIAMOND_SIZE}" aria-hidden="true" focusable="false">` +
    `<path d="M${c} ${c - r}L${c + r} ${c}L${c} ${c + r}L${c - r} ${c}Z" fill="${WHITE}" stroke="${HALO}" stroke-width="1.4" stroke-linejoin="round"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// The recovery position (the average of the fixes after landing, the spot
// OPEN IN MAPS goes to): a thin white crosshair, a ring with four ticks
// outside it, so it can be told apart from the landed diamond. A landed
// board sits right on it, so the ring is drawn just wide enough to show
// around the board marker. Its middle sits on the spot.
// ------------------------------------------------------------------
export const CROSSHAIR_SIZE = 40;
const CROSS_RING_R = 14;   // the ring's radius (px), just past the board's sides
const CROSS_TICK_FROM = 16; // the ticks run from here to the edge (px from the middle)

export function crosshairSvg() {
  const c = CROSSHAIR_SIZE / 2;
  const a = c - CROSS_TICK_FROM;
  const b = c + CROSS_TICK_FROM;
  const lines = `<circle cx="${c}" cy="${c}" r="${CROSS_RING_R}"/>` +
    `<path d="M${c} 1.5V${a}M${c} ${b}V${CROSSHAIR_SIZE - 1.5}M1.5 ${c}H${a}M${b} ${c}H${CROSSHAIR_SIZE - 1.5}"/>`;
  return `<svg class="fc-ico-cross" viewBox="0 0 ${CROSSHAIR_SIZE} ${CROSSHAIR_SIZE}" width="${CROSSHAIR_SIZE}" height="${CROSSHAIR_SIZE}" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke="${HALO}" stroke-opacity="0.85" stroke-width="3.2" stroke-linecap="round">${lines}</g>` +
    `<g fill="none" stroke="${WHITE}" stroke-width="1.4" stroke-linecap="round">${lines}</g>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Samples for the KEY. Each is a small SVG, 28 by 14.
// ------------------------------------------------------------------
const KEY_W = 28;
const KEY_H = 14;
const keySvg = (body) => `<svg class="fc-ico-key" viewBox="0 0 ${KEY_W} ${KEY_H}" width="${KEY_W}" height="${KEY_H}" aria-hidden="true" focusable="false">${body}</svg>`;
let keyGradients = 0;

// The path: a short line through three dots, from the slow end of the
// speed colors on the left to the fast end on the right.
export function pathKeySvg() {
  const id = `fc-key-ramp-${keyGradients += 1}`;
  const stops = TRACK_RAMP.map((c, i) => `<stop offset="${(i / (TRACK_RAMP.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('');
  const dot = (x, color) => `<circle cx="${x}" cy="7" r="${DOT_PX / 2}" fill="${color}" stroke="${HALO}" stroke-width="${DOT_OUTLINE_PX}"/>`;
  return keySvg(
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="3" x2="25" y1="7" y2="7">${stops}</linearGradient></defs>` +
    `<line x1="3" y1="7" x2="25" y2="7" stroke="${HALO}" stroke-width="${LINE_PX + 2 * LINE_OUTLINE_PX}" stroke-linecap="round"/>` +
    `<line x1="3" y1="7" x2="25" y2="7" stroke="url(#${id})" stroke-width="${LINE_PX}" stroke-linecap="round"/>` +
    dot(4, TRACK_RAMP[0]) + dot(14, TRACK_RAMP[2]) + dot(24, TRACK_RAMP[TRACK_RAMP.length - 1]));
}

// A gap: the same line, broken where packets were missed or the fix was
// lost, with no dots in the break.
export function gapKeySvg() {
  const color = TRACK_RAMP[1];
  const piece = (x1, x2) =>
    `<line x1="${x1}" y1="7" x2="${x2}" y2="7" stroke="${HALO}" stroke-width="${LINE_PX + 2 * LINE_OUTLINE_PX}" stroke-linecap="round"/>` +
    `<line x1="${x1}" y1="7" x2="${x2}" y2="7" stroke="${color}" stroke-width="${LINE_PX}" stroke-linecap="round"/>`;
  const dot = (x) => `<circle cx="${x}" cy="7" r="${DOT_PX / 2}" fill="${color}" stroke="${HALO}" stroke-width="${DOT_OUTLINE_PX}"/>`;
  return keySvg(piece(2, 9) + piece(19, 26) + dot(9) + dot(19));
}

// The packet ring: one thin white ring with the faint dark edge the real
// one has.
export function ringKeySvg() {
  return keySvg(
    `<circle cx="14" cy="7" r="5.5" fill="none" stroke="${HALO}" stroke-opacity="0.45" stroke-width="${RING_LINE_PX + 2}"/>` +
    `<circle cx="14" cy="7" r="5.5" fill="none" stroke="${WHITE}" stroke-width="${RING_LINE_PX}"/>`);
}

// A weak fix: one hollow grey ring.
export function weakKeySvg() {
  const r = WEAK_DOT_PX / 2;
  return keySvg(
    `<circle cx="14" cy="7" r="${r}" fill="none" stroke="${HALO}" stroke-width="${WEAK_LINE_PX + 2}"/>` +
    `<circle cx="14" cy="7" r="${r}" fill="none" stroke="${WEAK_COLOR}" stroke-width="${WEAK_LINE_PX}"/>`);
}

// The ground shadow: a short dark band with its faint light edge.
export function shadowKeySvg() {
  return keySvg(
    `<line x1="3" y1="9" x2="25" y2="9" stroke="${OFF_WHITE}" stroke-opacity="${SHADOW_EDGE_ALPHA}" stroke-width="${SHADOW_EDGE_PX}" stroke-linecap="round"/>` +
    `<line x1="3" y1="9" x2="25" y2="9" stroke="${NEAR_BLACK}" stroke-opacity="0.9" stroke-width="${SHADOW_PX}" stroke-linecap="round"/>`);
}

// The radio link: the faint dashed line with its small dot.
export function linkKeySvg() {
  return keySvg(
    `<line x1="2" y1="7" x2="26" y2="7" stroke="${LINK_COLOR}" stroke-opacity="${LINK_ALPHA + 0.2}" stroke-width="${LINK_PX}" stroke-dasharray="${LINK_DASH_PX[0] - 2} ${LINK_DASH_PX[1] - 2}"/>` +
    `<circle cx="17" cy="7" r="${LINK_DOT_PX / 2}" fill="${WHITE}" stroke="${HALO}" stroke-width="1"/>`);
}
