// cesium-loader.js
// Downloads CesiumJS (the 3D globe library) when the 3D view opens: when a
// flight opens on it (DEFAULT_VIEW in config.js) or the viewer clicks "3D".
// Nothing here runs on the launcher, so a visit that never opens a flight
// never downloads it.
//
// loadCesium() adds Cesium's stylesheet and script to the page and resolves
// to the library once it is ready. There is only ever one download: calling
// it again waits on the same one. Each call gives up after
// CESIUM_LOAD_TIMEOUT_MS, but the download itself is left running, so a
// later try picks it up where it is instead of starting a second one. If
// the download really fails, its tags are removed and the next call starts
// over.
//
// Where it comes from: Cesium's own release CDN (the addresses in
// config.js), except on the launch page (launch.html), which has to work
// with no internet. There it is the copy of the same release saved in
// flight-console/vendor/cesium/ (see cesiumSource() below).
//
// Used by: map-view.js.

import { CESIUM_JS_URL, CESIUM_CSS_URL, CESIUM_BASE_URL, CESIUM_LOAD_TIMEOUT_MS } from '../config.js?v=3';
// Launch mode: true only when the page is launch.html (see js/launch/launch-mode.js).
import { LAUNCH } from '../launch/launch-mode.js';

// The three addresses a download needs: the script, the stylesheet, and the
// folder Cesium fetches its own workers and assets from. On the launch page
// they point into flight-console/vendor/cesium/. That folder's address is
// worked out from this file's own address, so it is right whatever port or
// folder the site is served from. On any other page they are the CDN's.
export function cesiumSource(launch = LAUNCH) {
  if (!launch) return { baseUrl: CESIUM_BASE_URL, jsUrl: CESIUM_JS_URL, cssUrl: CESIUM_CSS_URL };
  const baseUrl = new URL('../../vendor/cesium/', import.meta.url).href;
  return { baseUrl, jsUrl: `${baseUrl}Cesium.js`, cssUrl: `${baseUrl}Widgets/widgets.css` };
}

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
    const source = cesiumSource();
    // Cesium fetches its workers and assets from this folder. It has to be
    // set before the script runs.
    window.CESIUM_BASE_URL = source.baseUrl;

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = source.cssUrl;

    const script = document.createElement('script');
    script.src = source.jsUrl;
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
