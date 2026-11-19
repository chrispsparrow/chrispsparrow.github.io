// offline-tiles.js: which saved map tiles launch mode has, worked out from
// the downloader's manifest (offline-maps/<field>/manifest.json, written by
// launch-mode/download_tiles.py). Both maps ask this file the same
// questions, so they always agree on what is saved.
//
// The saved map is a set of zoom levels. Each level is a rectangle of tiles
// in the usual web map layout (x from the west, y from the north), saved as
// <folder>/<zoom>/<x>/<y>.jpg. The far zooms cover the whole box around the
// field, and the closest zooms only cover its middle.
//
// Usage:
//   const tiles = createOfflineTiles(hub.settings);   // null when nothing is saved
//   tiles.has(z, x, y)        true when that exact tile is saved
//   tiles.deepest(z, x, y)    the closest saved zoom that has this tile's
//                             ground (the tile itself or one above it), or
//                             null when none does
//   tiles.parent(z, x, y, toZ)  the tile at zoom toZ over this one: { z, x, y }
//   tiles.url(z, x, y)        the saved tile's address
//   tiles.stacks              for the 3D view: one entry per group of levels
//                             that covers the same ground, far to near:
//                             { maxZoom, rect: { south, west, north, east } }
//                             Every tile from zoom 0 to maxZoom that touches
//                             rect is saved, so a layer limited to rect and
//                             maxZoom never asks for a missing tile.
//   tiles.bounds              the ground the far levels cover (the box)
//   tiles.minZoom, tiles.maxZoom, tiles.credit, tiles.complete
//
// No DOM and no network here, so Node can test it.

// Layers are kept this far (degrees, about 1 cm) inside the tiles' real
// edges, so rounding never makes a map ask for the next tile over.
const EDGE_MARGIN_DEG = 1e-7;

function shrink(rect) {
  return {
    south: rect.south + EDGE_MARGIN_DEG,
    west: rect.west + EDGE_MARGIN_DEG,
    north: rect.north - EDGE_MARGIN_DEG,
    east: rect.east - EDGE_MARGIN_DEG,
  };
}

// The ground two rectangles share, or null.
function overlap(a, b) {
  const rect = {
    south: Math.max(a.south, b.south),
    west: Math.max(a.west, b.west),
    north: Math.min(a.north, b.north),
    east: Math.min(a.east, b.east),
  };
  return rect.south < rect.north && rect.west < rect.east ? rect : null;
}

// settings is hub.settings from launch-mode.js: { manifest, tilesUrl }.
export function createOfflineTiles(settings) {
  const manifest = settings?.manifest;
  const base = settings?.tilesUrl;
  if (!manifest || !base || !Array.isArray(manifest.levels) || manifest.levels.length === 0) return null;

  const template = String(manifest.tileUrl || '{z}/{x}/{y}.jpg');
  const levels = new Map();
  for (const lv of manifest.levels) {
    if (![lv.z, lv.x0, lv.x1, lv.y0, lv.y1].every(Number.isInteger)) continue;
    const missing = new Set((lv.missing ?? []).map(([x, y]) => `${x}/${y}`));
    levels.set(lv.z, { ...lv, missing });
  }
  if (levels.size === 0) return null;
  const zooms = [...levels.keys()].sort((a, b) => a - b);
  const minZoom = zooms[0];
  const maxZoom = zooms[zooms.length - 1];

  function has(z, x, y) {
    const lv = levels.get(z);
    if (!lv) return false;
    if (x < lv.x0 || x > lv.x1 || y < lv.y0 || y > lv.y1) return false;
    return !lv.missing.has(`${x}/${y}`);
  }

  // The tile at zoom toZ that holds tile (z, x, y). toZ is at or above z.
  function parent(z, x, y, toZ) {
    const scale = 2 ** (z - toZ);
    return { z: toZ, x: Math.floor(x / scale), y: Math.floor(y / scale) };
  }

  // The closest saved zoom, from `from` (the tile's own zoom unless given)
  // up to the farthest, that has this tile's ground. Past maxZoom the map is
  // zoomed in further than anything saved, so the search starts at maxZoom.
  function deepest(z, x, y, from = z) {
    for (let at = Math.min(from, z, maxZoom); at >= minZoom; at--) {
      const p = parent(z, x, y, at);
      if (has(at, p.x, p.y)) return at;
    }
    return null;
  }

  function url(z, x, y) {
    return base + template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  // Groups of levels that were saved for the same box (the same halfKm),
  // far to near. A group's rectangle is the ground its closest level
  // covers, cut down to the group before it, so everything in it is saved
  // at every zoom up to the group's closest.
  const stacks = [];
  for (const z of zooms) {
    const lv = levels.get(z);
    if (!lv.covered) continue;
    const last = stacks[stacks.length - 1];
    if (last && last.halfKm === lv.halfKm && last.maxZoom === z - 1) {
      last.maxZoom = z;
      last.covered = lv.covered;
    } else {
      stacks.push({ halfKm: lv.halfKm, minZoom: z, maxZoom: z, covered: lv.covered });
    }
  }
  let outer = null;
  const usable = [];
  for (const stack of stacks) {
    const inside = outer ? overlap(stack.covered, outer) : stack.covered;
    if (!inside) continue;
    outer = inside;
    usable.push({ maxZoom: stack.maxZoom, rect: shrink(inside) });
  }

  return {
    has,
    parent,
    deepest,
    url,
    stacks: usable,
    bounds: usable.length ? usable[0].rect : null,
    minZoom,
    maxZoom,
    credit: String(manifest.credit ?? ''),
    complete: manifest.complete === true,
    name: String(manifest.name ?? ''),
    center: manifest.center ?? null,
  };
}
