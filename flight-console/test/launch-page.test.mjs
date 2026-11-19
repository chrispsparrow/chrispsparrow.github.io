// Checks the launch page (launch.html), the Flight Console set up for a
// launch field with no internet, and the local copies it loads:
//   - launch.html is exactly what launch-mode/build-launch-page.mjs makes
//     from the current index.html, so the two pages can't drift apart
//   - nothing launch.html loads is on the internet, and every local file it
//     names is there
//   - the generator stops with a clear message when index.html changes in a
//     way it doesn't know
//   - the copies in vendor/ are the same Leaflet, CesiumJS and fonts the
//     normal page gets from the internet
//   - js/views/cesium-loader.js picks the local CesiumJS on the launch page
//     and the CDN everywhere else
// Whether the page really runs with the network off is checked in a browser
// (see launch-mode/test/), not here.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/launch-page.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchPage, internetLoads, INDEX_PATH, LAUNCH_PATH, FONTS_ADDRESS, LEAFLET_VERSION,
  LOCAL_FONTS_CSS, LOCAL_LEAFLET_CSS, LOCAL_LEAFLET_JS, LAUNCH_CSS,
} from '../../launch-mode/build-launch-page.mjs';
import * as config from '../js/config.js';
import { cesiumSource } from '../js/views/cesium-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '..');
const ROOT_DIR = path.resolve(CONSOLE_DIR, '..');
const VENDOR_DIR = path.join(CONSOLE_DIR, 'vendor');

// vendor/cesium/Cesium.js, release 1.146. The same hash as
// https://cesium.com/downloads/cesiumjs/releases/1.146/Build/Cesium/Cesium.js
// (compared on 2026-11-19, with every other file in the folder). When
// CESIUM_VERSION in js/config.js changes, fetch that release into
// vendor/cesium/ and put its hash here.
const CESIUM_VENDORED = Object.freeze({
  version: '1.146',
  sha256: 'a5ab7e638f51d3bc5a6c710a79c9aecea42d9252b5cd2dad34980ea771c2c9af',
});

const read = (file) => fs.readFileSync(file, 'utf8');
// Git on Windows may hand out the two pages with different line endings.
// That changes nothing in a browser, so the comparisons here ignore it.
const sameLines = (text) => text.replace(/\r\n/g, '\n');
const hash = (algorithm, file, encoding) => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

const indexHtml = read(INDEX_PATH);
const launchHtml = fs.existsSync(LAUNCH_PATH) ? read(LAUNCH_PATH) : '';

// Every address a tag would fetch, found the plain way (not with the
// generator's own check, so the two can catch each other's mistakes):
// [{ tag, attribute, address }]. Comments are skipped, and so are <a> links,
// which load nothing until someone clicks.
function loadingAddresses(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const tag of text.match(/<(?:script|link|img|source|video|audio|track|iframe|embed|object)\b[^>]*>/gi) ?? []) {
    for (const m of tag.matchAll(/\s(src|href|srcset|imagesrcset|poster|data)\s*=\s*"([^"]*)"/gi)) {
      const list = /srcset$/i.test(m[1]) ? m[2].split(',').map((part) => part.trim().split(/\s+/)[0]) : [m[2]];
      for (const address of list) out.push({ tag, attribute: m[1].toLowerCase(), address });
    }
  }
  return out;
}
const onTheWeb = (address) => /^\s*(?:https?:)?\/\//i.test(address);

// Where a local address in the page is on disk. Addresses starting with /
// count from the repo's root (the folder the launch server serves), the
// rest from flight-console/.
function fileFor(address) {
  const clean = decodeURIComponent(address.split(/[?#]/)[0]);
  return clean.startsWith('/') ? path.join(ROOT_DIR, clean) : path.resolve(CONSOLE_DIR, clean);
}

// ------------------------------------------------------------------
// launch.html and index.html
// ------------------------------------------------------------------

test('launch.html is what the generator makes from the current index.html', () => {
  assert.ok(launchHtml, 'flight-console/launch.html is missing. Run: node launch-mode/build-launch-page.mjs');
  assert.ok(sameLines(launchHtml) === sameLines(buildLaunchPage(indexHtml)),
    'flight-console/launch.html is out of date. Run: node launch-mode/build-launch-page.mjs');
});

test('launch mode is turned on before anything else in the page loads', () => {
  const head = launchHtml.slice(launchHtml.indexOf('<head>') + '<head>'.length).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(head, /^\s*<script>window\.FC_LAUNCH = true;<\/script>/);
  // The note that the page is generated comes before even that.
  assert.match(launchHtml, /<head>\s*<!--\s*This file is generated\. Do not edit it by hand\./);
  assert.match(launchHtml, /node launch-mode\/build-launch-page\.mjs/);
});

test('nothing the launch page loads is on the internet', () => {
  const addresses = loadingAddresses(launchHtml);
  // The check has to see the page's tags at all, or passing means nothing.
  for (const expected of ['js/main.js', LOCAL_LEAFLET_JS, LOCAL_LEAFLET_CSS, LOCAL_FONTS_CSS, LAUNCH_CSS, '../css/style.css', '/favicon.ico']) {
    assert.ok(addresses.some((a) => a.address.split('?')[0] === expected.split('?')[0]), `the page should load ${expected}`);
  }
  assert.deepEqual(addresses.filter((a) => onTheWeb(a.address)), []);
  assert.deepEqual(internetLoads(launchHtml), []);
  // No inline script or style names a web address either.
  const inline = launchHtml.replace(/<!--[\s\S]*?-->/g, '').match(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  assert.ok(inline.length >= 3);
  for (const block of inline) assert.doesNotMatch(block, /https?:\/\//i);
  // The same two checks do find the internet tags in the normal page
  // (Google Fonts, and Leaflet's stylesheet and script on cdnjs), and they
  // agree with each other.
  const live = loadingAddresses(indexHtml).filter((a) => onTheWeb(a.address)).map((a) => a.address);
  const hosts = new Set(live.map((address) => new URL(address).host));
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']) {
    assert.ok(hosts.has(host), `the check should see ${host} in index.html`);
  }
  assert.ok(live.length >= 7);
  assert.deepEqual(internetLoads(indexHtml).map((load) => load.address).sort(), [...live].sort());
});

test('every local file the launch page names is there', () => {
  const missing = loadingAddresses(launchHtml)
    .filter((a) => !onTheWeb(a.address))
    .filter((a) => !fs.existsSync(fileFor(a.address)))
    .map((a) => a.address);
  assert.deepEqual(missing, []);
});

test('the launch page differs from index.html only where it has to', () => {
  // From <body> on, only the Leaflet script tag is different.
  const body = (html) => sameLines(html.slice(html.indexOf('<body'))).replace(/<script id="fc-lib-leaflet"[^>]*><\/script>/, '');
  assert.ok(body(launchHtml) === body(indexHtml), 'the body of launch.html should be the body of index.html');
  // That tag keeps what js/main.js watches, and loses what belonged to the CDN.
  const tag = launchHtml.match(/<script id="fc-lib-leaflet"[^>]*><\/script>/)?.[0] ?? '';
  assert.match(tag, /^<script id="fc-lib-leaflet" async\s/);
  assert.ok(tag.includes(` src="${LOCAL_LEAFLET_JS}"`), tag);
  assert.match(tag, /\sonload="this\.dataset\.state='loaded'" onerror="this\.dataset\.state='failed'"><\/script>$/);
  assert.doesNotMatch(tag, /integrity|crossorigin|referrerpolicy/);
  // Every versioned address (?v=) index.html has is in the launch page too,
  // unchanged and in the same order. (The launch page's own files don't count.)
  const versioned = (html) => html.match(/(?:src|href)="[^"]*\?v=[^"]*"/g) ?? [];
  const launchOnly = (text) => /"(?:vendor\/|flight-console-launch\.css)/.test(text);
  assert.ok(versioned(indexHtml).length >= 10);
  assert.deepEqual(versioned(launchHtml).filter((text) => !launchOnly(text)), versioned(indexHtml));
  // In <head>: the sharing tags are gone, search engines are told to skip
  // the page, and launch mode's stylesheet comes after all the others.
  assert.doesNotMatch(launchHtml, /<meta (?:property="og:|name="twitter:)/);
  assert.match(launchHtml, /<meta name="robots" content="noindex">/);
  const sheets = loadingAddresses(launchHtml.slice(0, launchHtml.indexOf('</head>')))
    .filter((a) => /rel="stylesheet"/.test(a.tag)).map((a) => a.address);
  assert.equal(sheets[0], LOCAL_FONTS_CSS);
  assert.equal(sheets[sheets.length - 1], LAUNCH_CSS);
  // The normal page never turns launch mode on or loads anything of its.
  assert.doesNotMatch(indexHtml.replace(/<!--[\s\S]*?-->/g, ''), /FC_LAUNCH/);
  assert.deepEqual(loadingAddresses(indexHtml).map((a) => a.address).filter((address) => /vendor\/|flight-console-launch\.css/.test(address)), []);
});

test('the generator stops and says why when index.html changes under it', () => {
  const broken = (change, message) => assert.throws(() => buildLaunchPage(change(indexHtml)), message);
  // A tag it expects is gone.
  broken((html) => html.replace(/<script id="fc-lib-leaflet"[^>]*><\/script>/, ''), /Did not find the Leaflet script tag/);
  broken((html) => html.replace(/<link rel="stylesheet" href="[^"]*leaflet\.css"[^>]*>/, ''), /Did not find the Leaflet stylesheet tag/);
  broken((html) => html.replace('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', ''), /Did not find the five Google Fonts tags/);
  broken((html) => html.replace(/^\s*<meta (?:property="og:|name="twitter:)[^>]*>\r?\n/gm, ''), /Did not find the og: and twitter: meta tags/);
  // The page asks for fonts or a Leaflet that vendor/ doesn't hold.
  broken((html) => html.replaceAll('Space+Grotesk:wght@700', 'Space+Grotesk:wght@500;700'), /Fetch the fonts again/);
  broken((html) => html.replaceAll(`leaflet/${LEAFLET_VERSION}/`, 'leaflet/1.9.5/'), /vendor\/leaflet\/ holds Leaflet/);
  // The Leaflet script loses an attribute js/main.js watches.
  broken((html) => html.replace(' onerror="this.dataset.state=\'failed\'"></script>', '></script>'), /js\/main\.js needs/);
  // A new tag that needs the network.
  broken((html) => html.replace('</body>', '<script src="https://example.com/extra.js"></script>\n</body>'), /loads from the internet[\s\S]*example\.com\/extra\.js/);
  broken((html) => html.replace('</head>', '<link rel="stylesheet" href="//example.com/extra.css">\n</head>'), /loads from the internet[\s\S]*example\.com\/extra\.css/);
  // Line endings are kept as they are, whichever kind index.html has.
  const unix = buildLaunchPage(sameLines(indexHtml));
  assert.doesNotMatch(unix, /\r/);
  const windows = buildLaunchPage(sameLines(indexHtml).replace(/\n/g, '\r\n'));
  assert.doesNotMatch(windows, /[^\r]\n/);
  assert.equal(sameLines(windows), unix);
});

// ------------------------------------------------------------------
// The local copies in vendor/
// ------------------------------------------------------------------

test('vendor/leaflet holds the same Leaflet files index.html pins by hash', () => {
  const integrityOf = (pattern) => indexHtml.match(pattern)?.[0].match(/integrity="(sha384-[^"]+)"/)?.[1];
  const pinned = {
    [LOCAL_LEAFLET_JS]: integrityOf(/<script id="fc-lib-leaflet"[^>]*>/),
    [LOCAL_LEAFLET_CSS]: integrityOf(/<link rel="stylesheet" href="[^"]*leaflet\.css"[^>]*>/),
  };
  for (const [file, integrity] of Object.entries(pinned)) {
    assert.ok(integrity, `index.html should pin ${file} with a sha384 hash`);
    assert.equal(`sha384-${hash('sha384', fileFor(file), 'base64')}`, integrity, file);
  }
  assert.match(read(path.join(VENDOR_DIR, 'leaflet', 'leaflet.js')), new RegExp(`version="${LEAFLET_VERSION.replace(/\./g, '\\.')}`));
  // The pictures leaflet.css names (the layers button and the default marker).
  for (const m of read(path.join(VENDOR_DIR, 'leaflet', 'leaflet.css')).matchAll(/url\((images\/[^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(VENDOR_DIR, 'leaflet', m[1])), m[1]);
  }
  assert.ok(fs.existsSync(path.join(VENDOR_DIR, 'leaflet', 'images', 'marker-shadow.png')));
  assert.ok(fs.existsSync(path.join(VENDOR_DIR, 'leaflet', 'LICENSE')));
});

test('vendor/cesium holds the CesiumJS release config.js asks for', () => {
  assert.equal(config.CESIUM_VERSION, CESIUM_VENDORED.version,
    `js/config.js asks for CesiumJS ${config.CESIUM_VERSION}, but vendor/cesium/ holds ${CESIUM_VENDORED.version}. Fetch the new release into vendor/cesium/ (vendor/README.md says how).`);
  const cesium = path.join(VENDOR_DIR, 'cesium');
  assert.equal(hash('sha256', path.join(cesium, 'Cesium.js'), 'hex'), CESIUM_VENDORED.sha256);
  assert.ok(read(path.join(cesium, 'Cesium.js')).includes(`CESIUM_VERSION="${CESIUM_VENDORED.version}.0"`));
  // What Cesium fetches from its own folder once it runs.
  for (const file of [
    'Widgets/widgets.css',
    'Workers/createTaskProcessorWorker.js',
    'Workers/createVerticesFromQuantizedTerrainMesh.js',
    'Workers/createGroundPolylineGeometry.js',
    'Workers/transferTypedArrayTest.js',
    'Assets/approximateTerrainHeights.json',
    'Assets/Images/ion-credit.png',
    'ThirdParty/draco_decoder.wasm',
    'LICENSE.md',
  ]) {
    assert.ok(fs.existsSync(path.join(cesium, file)), `vendor/cesium/${file}`);
  }
});

test('vendor/fonts/fonts.css has every font index.html asks Google for, from local files', () => {
  const fontsDir = path.join(VENDOR_DIR, 'fonts');
  const css = read(path.join(fontsDir, 'fonts.css'));
  const rules = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const get = (name) => m[2].match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
    return {
      subset: m[1],
      family: get('font-family')?.replace(/['"]/g, ''),
      weight: get('font-weight'),
      display: get('font-display'),
      range: get('unicode-range'),
      file: m[2].match(/src:\s*url\(([^)]+)\)\s*format\('woff2'\)/)?.[1],
    };
  });
  assert.equal(rules.length, (css.match(/@font-face/g) ?? []).length);
  assert.doesNotMatch(css, /https?:|\/\/fonts\./);

  // What the address in index.html asks for: each family with its weights
  // (a family with no weights listed means 400).
  const wanted = new URL(FONTS_ADDRESS).searchParams.getAll('family').flatMap((entry) => {
    const [family, weights] = entry.split(':wght@');
    return (weights ?? '400').split(';').map((weight) => ({ family, weight }));
  });
  assert.deepEqual(wanted.map((w) => `${w.family} ${w.weight}`), [
    'Barlow Condensed 400', 'Barlow Condensed 500', 'Barlow Condensed 600',
    'Funnel Sans 400', 'Funnel Sans 500', 'Funnel Sans 600',
    'Share Tech Mono 400', 'Space Grotesk 700',
  ]);
  assert.equal(new URL(FONTS_ADDRESS).searchParams.get('display'), 'swap');
  for (const { family, weight } of wanted) {
    const subsets = rules.filter((r) => r.family === family && r.weight === weight).map((r) => r.subset);
    assert.ok(subsets.includes('latin'), `${family} ${weight} needs its latin file`);
  }
  // And nothing index.html doesn't ask for.
  for (const rule of rules) {
    assert.ok(wanted.some((w) => w.family === rule.family && w.weight === rule.weight), `${rule.family} ${rule.weight}`);
    assert.equal(rule.display, 'swap');
    assert.match(rule.range ?? '', /^U\+/);
    assert.match(rule.file ?? '', /^[a-z0-9-]+\.woff2$/);
    const bytes = fs.readFileSync(path.join(fontsDir, rule.file));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', rule.file);
  }
  // Every font file in the folder is used, and each family's license is there.
  const used = new Set(rules.map((r) => r.file));
  assert.deepEqual(fs.readdirSync(fontsDir).filter((name) => name.endsWith('.woff2')).filter((name) => !used.has(name)), []);
  for (const family of new Set(wanted.map((w) => w.family))) {
    assert.ok(fs.existsSync(path.join(fontsDir, `OFL-${family.toLowerCase().replace(/\s+/g, '-')}.txt`)), `license for ${family}`);
  }
});

test('no stylesheet the launch page uses fetches anything from the internet', () => {
  const sheets = loadingAddresses(launchHtml)
    .filter((a) => /rel="stylesheet"/.test(a.tag))
    .map((a) => fileFor(a.address));
  // Cesium's stylesheet is added by js/views/cesium-loader.js, not by a tag.
  sheets.push(path.join(VENDOR_DIR, 'cesium', 'Widgets', 'widgets.css'));
  assert.ok(sheets.length >= 9);
  for (const sheet of sheets) {
    const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /@import\s+(?:url\(\s*)?['"]?\s*(?:https?:)?\/\//i, sheet);
    assert.doesNotMatch(css, /url\(\s*['"]?\s*(?:https?:)?\/\//i, sheet);
  }
});

// ------------------------------------------------------------------
// Where CesiumJS comes from (js/views/cesium-loader.js)
// ------------------------------------------------------------------

test('cesium-loader.js uses the CDN on the normal page and vendor/cesium/ on the launch page', () => {
  // Node is not the launch page, so the default is the CDN, as on index.html.
  const cdn = { baseUrl: config.CESIUM_BASE_URL, jsUrl: config.CESIUM_JS_URL, cssUrl: config.CESIUM_CSS_URL };
  assert.deepEqual(cesiumSource(), cdn);
  assert.deepEqual(cesiumSource(false), cdn);
  assert.match(cdn.jsUrl, /^https:\/\/cesium\.com\/downloads\/cesiumjs\/releases\/1\.146\/Build\/Cesium\/Cesium\.js$/);

  const local = cesiumSource(true);
  assert.ok(local.baseUrl.endsWith('/flight-console/vendor/cesium/'));
  assert.equal(local.jsUrl, `${local.baseUrl}Cesium.js`);
  assert.equal(local.cssUrl, `${local.baseUrl}Widgets/widgets.css`);
  // Worked out from the loader's own address: here, files on this disk.
  assert.equal(path.resolve(fileURLToPath(local.baseUrl)), path.join(VENDOR_DIR, 'cesium'));
  assert.ok(fs.existsSync(fileURLToPath(local.jsUrl)));
  assert.ok(fs.existsSync(fileURLToPath(local.cssUrl)));
});
