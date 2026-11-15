// esri.js
// Two things about Esri's satellite photos, shared by every console map
// (the live one and each replay's):
//
// 1. Whether Esri accepts the satellite key from this page. Once Esri says
//    yes, the rest of the visit uses that yes without asking again. A no (an
//    expired key, or a page address the key isn't set up for), an error or
//    no answer within TILE_FAIL_TIMEOUT_MS means no satellite this time, and
//    the next try asks again. Two checks at the same moment share one
//    request.
//
// 2. The satellite tile layer, which never asks for a photo Esri doesn't
//    have. Esri has photos down to SATELLITE_SURE_ZOOM everywhere, but how
//    much deeper they go depends on the place: zoom 20 on my campus in
//    Boston, 19 at the California launch site, 18 at Komodo and only 13 over
//    open ocean. Asking for a tile that isn't there fails (the browser
//    reports a 404 and the map shows a hole). So for a tile deeper than
//    SATELLITE_SURE_ZOOM the layer first asks the same World Imagery
//    service which tiles exist (its "tilemap": one small answer covers
//    SATELLITE_TILEMAP_BLOCK by SATELLITE_TILEMAP_BLOCK tiles of one zoom).
//    Where the photo isn't there, the deepest tile that is gets scaled up
//    to fill its place, the way Leaflet scales tiles past maxNativeZoom.
//    The answers are kept for the visit, so each part of the map is asked
//    about once per zoom level.
//
// Used by: map-view.js.

let acceptedKey = null; // the key Esri said yes to in this visit
let pending = null;     // { key, promise } while a check is on its way

// Resolves true or false, never throws.
export function checkEsriKey(config) {
  const key = config.ESRI_API_KEY;
  if (!key) return Promise.resolve(false);
  if (acceptedKey === key) return Promise.resolve(true);
  if (pending && pending.key === key) return pending.promise;
  const url = config.ESRI_KEY_CHECK_URL.replace('{key}', encodeURIComponent(key));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.TILE_FAIL_TIMEOUT_MS);
  const promise = fetch(url, { signal: abort.signal })
    .then((res) => (res.ok ? res.json() : null))
    // Esri can also report a rejected key inside a normal reply.
    .then((body) => {
      const ok = Boolean(body && !body.error);
      if (ok) acceptedKey = key;
      return ok;
    })
    .catch(() => false)
    .finally(() => {
      clearTimeout(timer);
      if (pending?.promise === promise) pending = null;
    });
  pending = { key, promise };
  return promise;
}

// ------------------------------------------------------------------
// Which photos exist
// ------------------------------------------------------------------

// Tilemap answers, by "zoom/top row/left column" of the block:
// { ready, answer }. `ready` is a promise that settles when the answer is
// in. `answer` is undefined until then, and null when Esri couldn't say
// (no answer, an error, a rejected key).
const blocks = new Map();

function blockFor(config, z, x, y) {
  const size = config.SATELLITE_TILEMAP_BLOCK;
  const left = Math.floor(x / size) * size;
  const top = Math.floor(y / size) * size;
  const id = `${z}/${top}/${left}`;
  let entry = blocks.get(id);
  if (entry) return entry;
  const url = config.SATELLITE_TILEMAP_URL
    .replace('{z}', z).replace('{y}', top).replace('{x}', left)
    .replaceAll('{size}', size)
    .replace('{key}', encodeURIComponent(config.ESRI_API_KEY));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.TILE_FAIL_TIMEOUT_MS);
  entry = { answer: undefined, ready: null };
  entry.ready = fetch(url, { signal: abort.signal })
    .then((res) => (res.ok ? res.json() : null))
    // A usable answer has the block's place and one 0 or 1 per tile.
    .then((body) => {
      const at = body?.location;
      const ok = body && !body.error && Array.isArray(body.data) && at && body.data.length === at.width * at.height;
      return ok ? { left: at.left, top: at.top, width: at.width, height: at.height, data: body.data } : null;
    })
    .catch(() => null)
    .then((answer) => {
      clearTimeout(timer);
      entry.answer = answer;
      return answer;
    });
  blocks.set(id, entry);
  return entry;
}

// Whether a tile exists, by a block's answer. With no answer it is taken
// to exist, which is how the map worked before it asked.
function tileIsThere(answer, x, y) {
  if (!answer) return true;
  const col = x - answer.left;
  const row = y - answer.top;
  if (col < 0 || row < 0 || col >= answer.width || row >= answer.height) return true;
  return answer.data[row * answer.width + col] === 1;
}

// The deepest zoom (from SATELLITE_SURE_ZOOM up to the tile's own) that has
// a photo for the tile at `coords`. A number when the answers needed are
// already in, otherwise a promise of one. A tile with no photo at one zoom
// has none deeper either, so the search stops at the first zoom without.
// The answers it still needs are asked for at the same time.
function deepestZoom(config, coords) {
  const sure = config.SATELLITE_SURE_ZOOM;
  if (coords.z <= sure) return coords.z;
  const steps = [];
  for (let z = sure + 1; z <= coords.z; z++) {
    const scale = 2 ** (coords.z - z);
    const x = Math.floor(coords.x / scale);
    const y = Math.floor(coords.y / scale);
    const entry = blockFor(config, z, x, y);
    steps.push({ z, x, y, entry });
    // Known to be missing here: no need to ask about deeper zooms.
    if (entry.answer !== undefined && !tileIsThere(entry.answer, x, y)) break;
  }
  const pick = () => {
    let best = sure;
    for (const s of steps) {
      if (!tileIsThere(s.entry.answer, s.x, s.y)) break;
      best = s.z;
    }
    return best;
  };
  if (steps.every((s) => s.entry.answer !== undefined)) return pick();
  return Promise.all(steps.map((s) => s.entry.ready)).then(pick);
}

// ------------------------------------------------------------------
// The satellite layer
// ------------------------------------------------------------------

// A Leaflet tile layer for Esri's photos (L is Leaflet, `options` the usual
// L.tileLayer options). Each tile is a box holding one photo: its own, or
// the deepest one above it, scaled up and moved so the right part of it
// fills the box. map-view.js styles the box (fc-sat-tiles).
//
// Apart from where the photo comes from, the layer works like Leaflet's
// own tile layer. That needs a few of Leaflet's methods redone, because
// Leaflet's versions expect each tile to be the photo itself (an img), and
// here it is a box around one:
// - When the zoom level changes, Leaflet throws away the old level's tiles
//   that are still loading (_abortLoading). It tells them apart by the
//   img's `complete`, which a box doesn't have, so it threw away every old
//   tile, loaded ones too, and the map went black until the new photos
//   came in. Here a tile counts as finished once its photo has loaded or
//   failed, so the old photos stay on screen, scaled, until the new ones
//   have faded in over them, the same as on the dark map.
// - When Leaflet drops a tile (the view moved on), it cancels the photo's
//   download by pointing the img at an empty picture. Here that is done to
//   the img inside the box (drop()). A tile still waiting to hear which
//   photos exist never asks for one at all.
// - A dropped tile's late "loaded" is ignored (_tileReady), so it can't be
//   mistaken for a new tile in the same spot.
export function createSatelliteLayer(L, config, options) {
  const SatelliteLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const box = document.createElement('div');
      const img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      box.append(img);
      // finished: the photo loaded or failed. dropped: the map let go of
      // the tile (see drop()).
      const tile = { img, finished: false, dropped: false };
      box.fcTile = tile;
      const show = (z) => {
        if (tile.dropped) return;
        // How many of this tile fit across the photo it borrows from (1
        // when it has its own), and which one it is.
        const scale = 2 ** (coords.z - z);
        const x = Math.floor(coords.x / scale);
        const y = Math.floor(coords.y / scale);
        const size = this.getTileSize();
        img.style.width = `${size.x * scale + 0.5}px`;
        img.style.height = `${size.y * scale + 0.5}px`;
        img.style.left = `${-(coords.x - x * scale) * size.x}px`;
        img.style.top = `${-(coords.y - y * scale) * size.y}px`;
        img.onload = () => { tile.finished = true; done(null, box); };
        img.onerror = (e) => { tile.finished = true; done(e, box); };
        img.src = L.Util.template(this._url, L.Util.extend({ r: '', s: '' }, this.options, { x, y, z }));
      };
      const z = deepestZoom(config, coords);
      if (typeof z === 'number') show(z);
      else z.then(show);
      return box;
    },

    // Leaflet's _abortLoading, for boxes: when the zoom level changes, the
    // tiles of other levels that are still loading go. Finished ones stay
    // until Leaflet's pruning takes them away, once the new level covers
    // their spot.
    _abortLoading() {
      for (const key in this._tiles) {
        const entry = this._tiles[key];
        if (entry.coords.z === this._tileZoom || entry.el.fcTile?.finished) continue;
        drop(L, entry.el);
        L.DomUtil.remove(entry.el);
        delete this._tiles[key];
        this.fire('tileabort', { tile: entry.el, coords: entry.coords });
      }
    },

    // Leaflet's _removeTile, for boxes: cancel the photo, then let Leaflet
    // take the tile out of the page as usual.
    _removeTile(key) {
      const entry = this._tiles[key];
      if (!entry) return;
      drop(L, entry.el);
      return L.GridLayer.prototype._removeTile.call(this, key);
    },

    // Leaflet's _tileReady, for boxes: nothing to do for a dropped tile.
    _tileReady(coords, err, box) {
      if (!this._map || box?.fcTile?.dropped) return;
      return L.GridLayer.prototype._tileReady.call(this, coords, err, box);
    },
  });
  return new SatelliteLayer(config.SATELLITE_URL, options);
}

// Lets go of a tile's photo: it never reports back, and a download still
// on its way is cancelled by pointing the img at Leaflet's empty picture
// (what Leaflet does to its own tiles). A tile still waiting to hear which
// photos exist won't ask for one.
function drop(L, box) {
  const tile = box.fcTile;
  if (!tile || tile.dropped) return;
  tile.dropped = true;
  tile.img.onload = null;
  tile.img.onerror = null;
  if (tile.img.getAttribute('src')) tile.img.setAttribute('src', L.Util.emptyImageUrl);
}
