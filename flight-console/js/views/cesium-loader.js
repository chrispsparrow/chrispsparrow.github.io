// cesium-loader.js
// Downloads CesiumJS (the 3D globe library) only when the viewer asks for
// the 3D view. Nothing here runs when the page opens, so a visit that stays
// on the map never downloads it.
//
// loadCesium() adds Cesium's stylesheet and script to the page and resolves
// to the library once it is ready. There is only ever one download: calling
// it again waits on the same one. Each call gives up after
// CESIUM_LOAD_TIMEOUT_MS, but the download itself is left running, so a
// later try picks it up where it is instead of starting a second one. If
// the download really fails, its tags are removed and the next call starts
// over.
//
// Used by: map-view.js.

import { CESIUM_JS_URL, CESIUM_CSS_URL, CESIUM_BASE_URL, CESIUM_LOAD_TIMEOUT_MS } from '../config.js';

// The download in progress. It settles only when the script itself loads
// or fails, never because a caller ran out of patience.
let download = null;

// True once Cesium is on the page, so opening the 3D view needs no download.
export function cesiumIsLoaded() {
  return Boolean(window.Cesium?.Viewer);
}

export function loadCesium() {
  if (cesiumIsLoaded()) return Promise.resolve(window.Cesium);
  if (!download) download = startDownload();
  let timer = null;
  const tooLong = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cesium took too long to download')), CESIUM_LOAD_TIMEOUT_MS);
  });
  return Promise.race([download, tooLong]).finally(() => clearTimeout(timer));
}

function startDownload() {
  const started = new Promise((resolve, reject) => {
    // Cesium fetches its workers and assets from this folder. It has to be
    // set before the script runs.
    window.CESIUM_BASE_URL = CESIUM_BASE_URL;

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = CESIUM_CSS_URL;

    const script = document.createElement('script');
    script.src = CESIUM_JS_URL;
    script.async = true;

    // Leave nothing behind, so a later try starts clean.
    const fail = (error) => {
      script.remove();
      style.remove();
      download = null;
      reject(error);
    };
    script.addEventListener('load', () => {
      if (cesiumIsLoaded()) resolve(window.Cesium);
      else fail(new Error('Cesium loaded but did not start'));
    }, { once: true });
    script.addEventListener('error', () => fail(new Error('Cesium did not download')), { once: true });

    document.head.append(style, script);
  });
  // A download that fails after everyone waiting on it has given up is
  // nobody's error to handle.
  started.catch(() => {});
  return started;
}
