// globe-poster.js
// The globe's poster on Track a Rocket: a still of the 3D view's idle Earth
// (assets/flight-console/globe-poster.webp), shown while Cesium downloads.
// It lies exactly where Cesium will draw the Earth, at any window size, with
// "3D VIEWER LOADING..." under it, and the 3D view fades in over it when its
// first picture is in (map-view.js does the fade).
//
// It shows from two places:
//   - Before the page's own code has run. That code is many small files, and
//     on a slow connection it takes several seconds to arrive. So index.html
//     also loads this file on its own (an async module), and on the console's
//     addresses (?track and ?flight=) it puts the poster up as soon as the
//     picture is in (see "Early start" below).
//   - map-view.js, from the moment it starts. It takes over the same canvas,
//     already in the same place, so nothing moves.
//
// The picture. index.html holds it as a hidden img (#fc-globe-poster) with
// a 1x and a 2x file, so the browser fetches it with the page and picks the
// file for the screen. It is drawn on a canvas, warped for the view's shape
// (warpEarth in idle-earth.js): the picture was made for one shape of
// window, and other shapes see the Earth from a little closer or farther.
//
// The launch page (launch.html) has no poster. Its 3D view opens on the
// launch field, not on the idle Earth, and the poster is a picture of the
// idle Earth. So when window.FC_LAUNCH is true, globePoster() returns null:
// nothing is put up early, and map-view.js shows its loading message on its
// own in the middle of the frame, as it does over a replay. (The flag is
// read straight from the page here, not from js/launch/launch-mode.js,
// because this file runs before the rest of the page's code.)
//
// Used by: index.html (the early start) and map-view.js.

import { idleFit, idleOutline, posterScale, warpEarth, POSTER_ANGLE_DEG, POSTER_EARTH_SHARE } from './idle-earth.js';
import { buildMapControls } from './map-controls.js';

// The message under the poster while the 3D view loads.
export const LOADING_TEXT = '3D VIEWER LOADING...';
// The poster is a picture of Cesium ion's imagery, so it carries the
// imagery's credit while it shows. This is what Cesium's "Data attribution"
// listed for the idle view's imagery when the poster was made. (The real 3D
// view shows Cesium's own credits.)
export const POSTER_CREDIT = 'Imagery from Cesium ion. Bing Maps, © 2026 Microsoft Corporation, Earthstar Geographics SIO, © Mapbox.';
// The poster is drawn again for a new view size at most this often (ms)
// while the window is being resized.
const REDRAW_MS = 150;
// Room (px) between the Earth's bottom edge and the loading message under
// it, and between the message and anything below it.
const MSG_GAP_PX = 6;

// The height (px) of the band the controls row (and any other HUD block
// down there) takes along the bottom of a view (boxEl), so the idle Earth
// can sit above it: the tallest reach, from the view's bottom edge, of the
// elements given that start in its bottom 40%. (The panel switches halfway
// up the sides don't count, by that rule.) map-view.js passes the HUD's
// blocks, and so does the early start.
export function bandUnder(boxEl, elements) {
  const box = boxEl.getBoundingClientRect();
  let band = 0;
  for (const el of elements) {
    if (!el?.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.top < box.top + box.height * 0.6 || r.top >= box.bottom) continue;
    band = Math.max(band, box.bottom - r.top);
  }
  return band;
}

// Where the loading message's top goes (px from the view's top): just under
// the Earth (earth from idleOutline), centered on it, moved up only as far
// as it must to clear the blocks given ({ left, top, right, bottom } in the
// view's px) and the view's bottom edge (hgt), and never above the Earth's
// middle.
export function messageTop(earth, msgW, msgH, hgt, blocks) {
  let top = earth.cy + earth.ry + MSG_GAP_PX;
  const left = earth.cx - msgW / 2;
  const right = earth.cx + msgW / 2;
  const below = blocks.filter((r) => r.right > left && r.left < right).sort((a, b) => b.top - a.top);
  for (const r of below) {
    if (top + msgH + MSG_GAP_PX > r.top && top < r.bottom) top = r.top - MSG_GAP_PX - msgH;
  }
  top = Math.min(top, hgt - msgH - MSG_GAP_PX);
  return Math.max(top, earth.cy);
}

// The page's one poster: { canvas, ready(), onReady(fn), place() }, or null
// if the page has no picture for it.
let poster;
export function globePoster() {
  if (poster === undefined) poster = makePoster();
  return poster;
}

function makePoster() {
  // No poster on the launch page (see the top of this file).
  if (window.FC_LAUNCH === true) return null;
  const img = document.getElementById('fc-globe-poster');
  if (!(img instanceof HTMLImageElement)) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'fc-globe-poster';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');

  let bitmap = null;   // the picture at its full size, once decoded
  let pixels = null;   // its pixels, read once for warping (false: can't be read)
  let drawn = '';      // the size and view the canvas was last drawn for
  let drawnAt = 0;
  let timer = 0;
  const waiting = [];

  // The page's img picks the 1x or 2x file, but reports the size the page
  // would show it at rather than its pixels. So the file it picked is opened
  // again as a plain image (from the browser's cache) to get every pixel. A
  // picture that doesn't load just never shows.
  img.decode().then(() => {
    const raw = new Image();
    raw.src = img.currentSrc || img.src;
    return raw.decode().then(() => raw);
  }).then((raw) => {
    if (!(raw.naturalWidth > 0)) return;
    bitmap = raw;
    for (const fn of waiting.splice(0)) fn();
  }, () => {});

  // Draws the picture for a view that sees the Earth at angular radius
  // angle (radians), with the middle of the Earth's face shift (a share of
  // the poster's height) below the outline's center, as a camera tilted a
  // touch south sees it. The picture was made for POSTER_ANGLE_DEG, looking
  // straight at the Earth. For any other view each pixel inside the Earth
  // is moved to where the real view will draw that spot, so the coastlines
  // don't slide as the real view fades in. That takes about 30 ms on a
  // laptop, so while the window is being resized it is done at most every
  // REDRAW_MS, and again (redo) once the resizing stops.
  function draw(angle, shift, redo) {
    const n = bitmap.naturalWidth;
    const from = POSTER_ANGLE_DEG * Math.PI / 180;
    const faceShift = Math.round(shift * n * 2) / 2;
    // Within about a twentieth of a degree and half a pixel, the picture
    // is used as it is.
    const same = Math.abs(angle - from) < 0.001 && faceShift === 0;
    const key = same ? `${n}|same` : `${n}|${angle.toFixed(3)}|${faceShift}`;
    if (key === drawn) return;
    const now = performance.now();
    if (drawn && now - drawnAt < REDRAW_MS) {
      clearTimeout(timer);
      timer = setTimeout(() => redo?.(), REDRAW_MS);
      return;
    }
    drawnAt = now;
    if (canvas.width !== n || canvas.height !== n) {
      canvas.width = n;
      canvas.height = n;
    }
    const g = canvas.getContext('2d');
    try {
      if (same || pixels === false) {
        g.drawImage(bitmap, 0, 0, n, n);
      } else {
        if (!pixels) {
          g.drawImage(bitmap, 0, 0, n, n);
          pixels = g.getImageData(0, 0, n, n).data;
        }
        const warped = warpEarth(pixels, n, (n / 2) * POSTER_EARTH_SHARE, posterScale(from, angle), faceShift);
        g.putImageData(new ImageData(warped, n, n), 0, 0);
      }
    } catch (err) {
      // The pixels can't be read (it shouldn't happen, the picture is on
      // this site). The picture is used as it is from now on.
      console.warn('Flight Console: the globe poster could not be warped', err);
      pixels = false;
      g.drawImage(bitmap, 0, 0, n, n);
    }
    drawn = key;
  }

  return {
    canvas,
    ready: () => Boolean(bitmap),
    // fn runs once the picture is in (at once if it already is).
    onReady(fn) {
      if (bitmap) fn();
      else waiting.push(fn);
    },
    // Lays the poster over the Earth the idle view will draw in a view w by
    // hgt px with a band px tall along its bottom (idle-earth.js does the
    // sums, the same ones the 3D view's camera uses), drawing it first if
    // the view changed. The Earth's outline can be a touch taller than
    // wide (see idleOutline), so the poster is stretched to match. redo is
    // called to lay it again after a redraw put off by a resize. Returns the
    // Earth's outline in the view's px.
    place(w, hgt, band, redo) {
      const earth = idleOutline(w, hgt, band);
      if (!bitmap) return earth;
      const pw = (2 * earth.rx) / POSTER_EARTH_SHARE;
      const ph = (2 * earth.ry) / POSTER_EARTH_SHARE;
      draw(idleFit(w, hgt, band).angle, (earth.faceY - earth.cy) / ph, redo);
      Object.assign(canvas.style, {
        left: `${earth.cx - pw / 2}px`,
        top: `${earth.cy - ph / 2}px`,
        width: `${pw}px`,
        height: `${ph}px`,
      });
      return earth;
    },
  };
}

// ------------------------------------------------------------------
// Early start
// ------------------------------------------------------------------
// On the console's addresses, before the page's code has shown a screen,
// the console is laid out but kept invisible (data-fc-boot on the body, see
// flight-console-map.css), and only the poster, the loading message under
// it and the poster's credit show. The map's controls row isn't there yet,
// so an unwired copy of it (map-controls.js) goes in its place to take the
// same room, and the band and the Earth come out exactly as map-view.js
// will work them out. The message shows at once, the poster as soon as its
// picture is in. map-view.js ends it all when it starts (endBoot), keeping
// the poster's canvas. main.js takes data-fc-boot away whenever it shows a
// screen.

let boot = null;

export function endBoot() {
  if (!boot) return;
  boot.observer?.disconnect();
  boot.message.remove();
  boot.credit.remove();
  boot.copy?.remove();
  boot = null;
  if (document.body.dataset.fcBoot) delete document.body.dataset.fcBoot;
}

function startBoot() {
  if (!/[?&](track|flight)\b/.test(window.location.search)) return;
  if (!document.body || document.body.dataset.fcScreen) return;
  const stage = document.getElementById('fc-panel-globe');
  const mount = document.getElementById('fc-map-controls');
  const p = globePoster();
  if (!stage || !p) return;

  const line = document.createElement('p');
  line.className = 'fc-globe-msg';
  const cursor = document.createElement('span');
  cursor.className = 'fc-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.textContent = '_';
  line.append(LOADING_TEXT, cursor);
  const box = document.createElement('div');
  box.className = 'fc-globe-msgbox';
  box.append(line);
  const message = document.createElement('div');
  message.className = 'fc-globe-panel is-under fc-boot-msg';
  message.hidden = true;
  message.append(box);
  const credit = document.createElement('p');
  credit.className = 'fc-globe-credits fc-poster-credit fc-boot-credit';
  credit.hidden = true;
  credit.textContent = POSTER_CREDIT;
  const copy = mount && mount.childElementCount === 0 ? buildMapControls().controls : null;
  if (copy) mount.append(copy);
  stage.append(p.canvas, message, credit);
  boot = { message, credit, copy, observer: null };
  document.body.dataset.fcBoot = 'globe';

  const covers = () => [...stage.querySelectorAll('[data-fc-cover]'), ...(stage.closest('.fc-screens')?.querySelectorAll('.fc-flip') ?? [])];
  const layout = () => {
    if (!boot) return;
    if (document.body.dataset.fcBoot !== 'globe' || document.body.dataset.fcScreen) {
      endBoot();
      return;
    }
    const w = stage.clientWidth;
    const hgt = stage.clientHeight;
    if (!(w > 0 && hgt > 0)) return;
    const earth = p.place(w, hgt, bandUnder(stage, covers()), layout);
    const shown = p.ready();
    p.canvas.hidden = !shown;
    credit.hidden = !shown;
    message.hidden = false;
    const s = stage.getBoundingClientRect();
    const blocks = [...covers(), credit].map((el) => el.getBoundingClientRect())
      .filter((r) => r.width >= 1 && r.height >= 1)
      .map((r) => ({ left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top }));
    message.style.setProperty('--fc-msg-top', `${Math.round(messageTop(earth, box.offsetWidth, box.offsetHeight, hgt, blocks))}px`);
  };
  if ('ResizeObserver' in window) {
    boot.observer = new ResizeObserver(layout);
    boot.observer.observe(stage);
    if (mount) boot.observer.observe(mount);
  }
  p.onReady(layout);
  layout();
}

startBoot();
