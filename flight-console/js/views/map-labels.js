// map-labels.js
// The small names next to things on the map, drone-camera style: white
// Share Tech Mono with a thin dark outline, joined to what they name by a
// short leader line. "DOGTOOTH" moves with the board, and the ground
// station's name ("MANTA", or "GROUND STATION" on the launch page, see
// stationLabel), "LAUNCH POINT" and "APOGEE 3,012 M" sit by their markers.
//
// Both views use the same layer. Each view works out where its things are
// on screen with its own projection (the 3D view with Cesium's
// scene.cartesianToCanvasCoordinates, the map with Leaflet's
// latLngToContainerPoint) and hands the layer a list of points. The layer
// places the text, draws the leader lines and keeps the labels readable:
//   - Two things closer together on screen than MERGE_PX share one label,
//     one name per line (the board sitting on its launch point, say).
//   - A label tries four spots around its point (up right, up left, down
//     right, down left) and takes the first one that doesn't cover another
//     label, a covered part of the view (the HUD) or the view's edge. If
//     none is free it fades out. More important labels are placed first.
//   - When the view is zoomed far out, every label fades out.
// Labels are plain page elements, so the text stays crisp. They never take
// clicks or keyboard focus, and screen readers skip them (the HUD says the
// same things in words).
//
// Used by: map-view.js, which makes one layer and shares it with
// globe-view.js.

import { h, svg } from './dom.js?v=2';
import { formatNumber } from '../geo.js?v=3';
import { stationName } from '../flight-state.js?v=4';

// The fixed names. The ground station's name is not fixed (stationLabel).
export const LABEL_NAMES = Object.freeze({
  board: 'DOGTOOTH',
  pad: 'LAUNCH POINT',
});

// The ground station's name by its dish, for the store's ground station
// gs: "MANTA", or "GROUND STATION" for a position typed in on the launch
// page. It is stationName() in flight-state.js, so the maps say what the
// HUD and the launch panel say. The views read it on every draw, so it
// follows the store when the ground station or the store changes.
export function stationLabel(gs) {
  return stationName(gs);
}

// "APOGEE 3,012 M": the real apogee in whole meters above the ground.
export function apogeeLabel(aglM) {
  return Number.isFinite(aglM) ? `APOGEE ${formatNumber(aglM, 0)} M` : 'APOGEE';
}

// How important each kind of label is. Higher ones are placed first and
// win when two would overlap.
export const LABEL_PRIORITY = Object.freeze({ board: 4, apogee: 3, station: 2, pad: 1 });

// Length (px) of the leader line, diagonal from the marker's edge.
const LEAD_PX = 12;
// Room (px) between the leader's end and the text.
const TEXT_GAP_PX = 2;
// Points closer than this on screen (px) share one label.
const MERGE_PX = 22;
// Room (px) kept between two labels, and between a label and the view's
// edge.
const ROOM_PX = 3;
// Where a label can go around its point, in the order they are tried:
// [sideways, up or down], where -1 is left or up.
const SPOTS = [[1, -1], [-1, -1], [1, 1], [-1, 1]];

// host: the element the labels sit in. It must cover the view exactly
// (position: relative or absolute), since the points are in its pixels.
export function createLabelLayer(host) {
  const lines = svg('svg', { class: 'fc-lbl-lines', 'aria-hidden': 'true', focusable: 'false' });
  const layer = h('div', { class: 'fc-lbls', 'aria-hidden': 'true' }, lines);
  host.append(layer);
  // One entry per label on screen, by the names it shows:
  // { el, lead, leadHalo, w, h }
  const labels = new Map();
  let destroyed = false;

  // The text sizes depend on the font. If Share Tech Mono arrives after
  // the first labels were measured, they are measured again.
  document.fonts?.ready?.then(() => {
    if (destroyed) return;
    for (const label of labels.values()) measure(label);
  });

  function measure(label) {
    label.w = label.el.offsetWidth;
    label.h = label.el.offsetHeight;
  }

  function labelFor(key, names) {
    let label = labels.get(key);
    if (!label) {
      const el = h('div', { class: 'fc-lbl' }, names.map((name) => h('span', { class: 'fc-lbl-line' }, name)));
      const leadHalo = svg('line', { class: 'fc-lbl-lead-halo' });
      const lead = svg('line', { class: 'fc-lbl-lead' });
      lines.append(leadHalo, lead);
      layer.append(el);
      label = { el, lead, leadHalo, w: 0, h: 0 };
      measure(label);
      labels.set(key, label);
    }
    return label;
  }

  function removeLabel(key) {
    const label = labels.get(key);
    if (!label) return;
    label.el.remove();
    label.lead.remove();
    label.leadHalo.remove();
    labels.delete(key);
  }

  // items: [{ id, text, x, y, r, priority }], x and y in the host's pixels
  // (null or off screen to leave it out), r the room (px) to keep around
  // the point for its marker.
  // far: true fades every label out (the view is zoomed far out).
  // avoid: rectangles { left, top, right, bottom } in the host's pixels
  // that labels stay off (the HUD).
  function update(items, { far = false, avoid = [] } = {}) {
    if (destroyed) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const onScreen = items
      .filter((it) => it && it.text && Number.isFinite(it.x) && Number.isFinite(it.y) &&
        it.x >= -20 && it.y >= -20 && it.x <= width + 20 && it.y <= height + 20)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // Points close together share one label, led from the most
    // important one.
    const groups = [];
    for (const it of onScreen) {
      const near = groups.find((g) => Math.hypot(g.x - it.x, g.y - it.y) < MERGE_PX);
      if (near) {
        near.names.push(it.text);
        near.r = Math.max(near.r, it.r ?? 0);
      } else {
        groups.push({ x: it.x, y: it.y, r: it.r ?? 0, names: [it.text] });
      }
    }

    const taken = avoid.map((r) => ({ ...r }));
    const used = new Set();
    for (const g of groups) {
      const key = g.names.join('\n');
      used.add(key);
      const label = labelFor(key, g.names);
      if (!label.w) measure(label);
      let spot = null;
      if (!far) {
        for (const [sx, sy] of SPOTS) {
          const s = spotFor(g, label, sx, sy);
          if (s.box.left < ROOM_PX || s.box.top < ROOM_PX || s.box.right > width - ROOM_PX || s.box.bottom > height - ROOM_PX) continue;
          if (taken.some((t) => overlaps(s.box, t))) continue;
          spot = s;
          break;
        }
      }
      if (spot) {
        taken.push(spot.box);
        label.el.style.transform = `translate(${Math.round(spot.box.left)}px, ${Math.round(spot.box.top)}px)`;
        label.el.style.textAlign = spot.left ? 'right' : 'left';
        for (const line of [label.lead, label.leadHalo]) {
          line.setAttribute('x1', spot.x1.toFixed(1));
          line.setAttribute('y1', spot.y1.toFixed(1));
          line.setAttribute('x2', spot.x2.toFixed(1));
          line.setAttribute('y2', spot.y2.toFixed(1));
        }
      }
      show(label, Boolean(spot));
    }
    for (const key of [...labels.keys()]) {
      if (!used.has(key)) removeLabel(key);
    }
  }

  function show(label, on) {
    label.el.classList.toggle('is-shown', on);
    label.lead.classList.toggle('is-shown', on);
    label.leadHalo.classList.toggle('is-shown', on);
  }

  // Where a label goes for one spot around its point: the leader runs
  // diagonally from the marker's edge, and the text sits just past its
  // end, with the leader meeting the bottom (or top) corner of the text.
  function spotFor(g, label, sx, sy) {
    const k = Math.SQRT1_2;
    const x1 = g.x + sx * g.r * k;
    const y1 = g.y + sy * g.r * k;
    const x2 = x1 + sx * LEAD_PX * k;
    const y2 = y1 + sy * LEAD_PX * k;
    const left = sx > 0 ? x2 + TEXT_GAP_PX : x2 - TEXT_GAP_PX - label.w;
    const top = sy < 0 ? y2 - label.h + 3 : y2 - 3;
    return { x1, y1, x2, y2, left: sx < 0, box: { left, top, right: left + label.w, bottom: top + label.h } };
  }

  // Hides every label (the view is off screen, or moving in a way the
  // labels can't follow, like a map zoom).
  function hide() {
    for (const label of labels.values()) show(label, false);
  }

  function clear() {
    for (const key of [...labels.keys()]) removeLabel(key);
  }

  return {
    update,
    hide,
    clear,
    destroy() {
      destroyed = true;
      clear();
      layer.remove();
    },
  };
}

function overlaps(a, b) {
  return a.left < b.right + ROOM_PX && a.right > b.left - ROOM_PX && a.top < b.bottom + ROOM_PX && a.bottom > b.top - ROOM_PX;
}
