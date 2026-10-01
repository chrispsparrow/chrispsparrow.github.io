// esri.js
// Asks Esri whether it accepts the satellite key from this page. The
// console map and the launcher's map picture both need the answer, so it
// lives here and is shared: once Esri says yes, the rest of the visit uses
// that yes without asking again. A no (an expired key, or a page address
// the key isn't set up for), an error or no answer within
// TILE_FAIL_TIMEOUT_MS means no satellite this time, and the next try asks
// again. Two checks at the same moment share one request.
// Used by: map-view.js and launcher-map.js.

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
