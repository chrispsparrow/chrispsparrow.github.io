// markers.js
// The markers the 3D view and the 2D map draw, as SVG markup strings:
// the Dogtooth board, the start point (the launch point in a replay) and
// the ground station's dish. The 3D view turns them into small canvases
// for Cesium. The map puts them inside Leaflet markers, and the KEY shows
// them with iconNode() from icons.js. None of them has a text label: the
// readings panel says what the labels used to say.
//
// The board marker always stands upright and keeps one size on screen. No
// board sends orientation data yet, so it never turns to suggest which
// way the rocket points.
//
// Used by: globe-view.js and map-view.js.

import { HALO_COLOR, PAD_COLOR } from '../config.js';

// The board's blue. #184590 is the soldermask as the 3D viewer on
// projects/avionics-pcb.html renders it, sampled from
// assets/flight-console/dogtooth-board-blue.png (a render with the
// viewer's lighting). The model's raw material color (mat_29 in
// avionics-pcb.min.glb, converted to sRGB) is #01306F, which is the same
// blue before any light falls on it and reads almost black on a map.
export const BOARD_BLUE = '#184590';
const OFF_WHITE = PAD_COLOR;   // the theme's off-white, #E8EDF2
const DIM = '#A0A3A9';         // the theme's dim off-white
const NAVY = '#07060D';        // the theme's near-black background
const HALO = HALO_COLOR;       // the dark outline, #07060D

// The trail behind each board marker, on the map and in 3D: a thin solid
// line that fades out like a comet's tail. It shows the last TRAIL_WINDOW_S
// seconds of good positions before the marker, and is TRAIL_WIDTH_PX wide
// for the focused rocket (orange, TRACK_COLOR in config.js) and
// TRAIL_OTHER_WIDTH_PX for the others (their own colors). A gap in the
// positions is left as a break.
export const TRAIL_WINDOW_S = 30;
export const TRAIL_WIDTH_PX = 2;
export const TRAIL_OTHER_WIDTH_PX = 1.5;

// The orange rings around a board with a good GPS fix pulse outward once
// every RING_PULSE_MS, three rings a third of the way apart, as on the map
// (its CSS animation, fc-sonar, takes the same 2.4 s). While they pulse, the
// 3D view redraws at most RING_PULSE_FPS times a second. Viewers who ask
// for less motion get three still rings and no redraws.
export const RING_PULSE_MS = 2400;
export const RING_PULSE_FPS = 30;

// ------------------------------------------------------------------
// The Dogtooth board: a plain rounded rectangle in the board's blue with a
// thin off-white outline, upright like the real board (about 3 wide to 4
// tall). The focused board is the larger size. With no GPS fix right now
// it turns hollow: a solid navy middle and a dim outline (the map does the
// same with CSS, through the .fc-brd-body class). The middle stays solid
// so the start dot, which sits under a board on a desk, doesn't show
// through it.
// ------------------------------------------------------------------
export const BOARD_FOCUSED = Object.freeze([18, 24]);
export const BOARD_OTHER = Object.freeze([14, 18]);
const BOARD_LINE = 1.5;

export function boardSvg([w, h], { hollow = false } = {}) {
  const inset = BOARD_LINE / 2;
  const r = Math.round(Math.min(w, h) * 0.2 * 2) / 2;
  return `<svg class="fc-ico-board" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">` +
    `<rect class="fc-brd-body" x="${inset}" y="${inset}" width="${w - BOARD_LINE}" height="${h - BOARD_LINE}" rx="${r}"` +
    ` fill="${hollow ? NAVY : BOARD_BLUE}" stroke="${hollow ? DIM : OFF_WHITE}" stroke-width="${BOARD_LINE}"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Start point (the launch point in a replay): a small off-white dot with a
// thin dark ring. Its middle sits on the spot.
// ------------------------------------------------------------------
export const START_SIZE = 12;

export function startSvg() {
  return `<svg class="fc-ico-start" viewBox="0 0 ${START_SIZE} ${START_SIZE}" width="${START_SIZE}" height="${START_SIZE}" aria-hidden="true" focusable="false">` +
    `<circle cx="6" cy="6" r="4.25" fill="${OFF_WHITE}" stroke="${HALO}" stroke-width="1.5"/>` +
    '</svg>';
}

// ------------------------------------------------------------------
// Ground station: a small satellite dish in an off-white outline, tilted
// up on a short stand, about the size of the board marker. A dark line
// under the drawing keeps it visible on bright ground. DISH_ANCHOR is the
// middle of the stand's foot, which sits on the ground station's position.
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
