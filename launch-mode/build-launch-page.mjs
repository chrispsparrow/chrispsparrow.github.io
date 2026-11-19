// build-launch-page.mjs
// Makes flight-console/launch.html, the launch page, from
// flight-console/index.html. The launch page is the Flight Console set up
// for a launch field with no internet: the same page, with launch mode
// turned on and every file it loads coming from this laptop.
//
// launch.html is never edited by hand. It is made here, so the two pages
// can't drift apart: change index.html (or this file), then run this again
// from the repo's root folder:
//   node launch-mode/build-launch-page.mjs           writes launch.html
//   node launch-mode/build-launch-page.mjs --check   only says whether it is up to date
//
// What changes, and nothing else:
//   1. A comment saying the page is generated, and
//      <script>window.FC_LAUNCH = true;</script>, are the first things in
//      <head>. js/launch/launch-mode.js reads that flag.
//   2. The og: and twitter: tags (for sharing a link) go, and a robots tag
//      tells search engines to leave the page out.
//   3. The Google Fonts tags become one link to vendor/fonts/fonts.css.
//   4. The Leaflet stylesheet and script come from vendor/leaflet/ instead
//      of cdnjs. The script keeps its id, async and its onload and onerror
//      attributes, which js/main.js watches.
//   5. flight-console-launch.css is linked after the page's other styles.
// Every other byte is index.html's own, line endings included. (CesiumJS
// has no tag in the page. js/views/cesium-loader.js picks its local copy.)
//
// If a tag this expects isn't in index.html, or index.html gains a new tag
// that loads something from the internet, this stops and says which one,
// instead of writing a launch page that needs the network.
//
// Used by: me, by hand, and flight-console/test/launch-page.test.mjs, which
// fails while launch.html isn't what this makes from the current index.html.
// Needs Node 22 or newer. No packages.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_PATH = path.resolve(HERE, '..', 'flight-console', 'index.html');
export const LAUNCH_PATH = path.resolve(HERE, '..', 'flight-console', 'launch.html');

// What flight-console/vendor/ holds copies of. When index.html moves to
// another Leaflet version or asks Google for other fonts, the copies in
// vendor/ have to be fetched again first (flight-console/vendor/README.md
// says how), and then these two change to match.
export const LEAFLET_VERSION = '1.9.4';
export const FONTS_ADDRESS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=Funnel+Sans:wght@400;500;600&family=Share+Tech+Mono&family=Space+Grotesk:wght@700&display=swap';

// The local files the launch page loads instead, relative to flight-console/.
export const LOCAL_FONTS_CSS = 'vendor/fonts/fonts.css';
export const LOCAL_LEAFLET_CSS = 'vendor/leaflet/leaflet.css';
export const LOCAL_LEAFLET_JS = 'vendor/leaflet/leaflet.js';
export const LAUNCH_CSS = 'flight-console-launch.css';

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function stop(message) {
  throw new Error(`build-launch-page: ${message}`);
}

// Text with every regular expression character escaped, to match it as written.
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The one place a pattern (a global regular expression) matches. Stops when
// it matches nowhere, or more than once.
function findOnce(html, pattern, what) {
  const found = [...html.matchAll(pattern)];
  if (found.length === 0) stop(`Did not find ${what} in index.html. If the page changed there, update this file to match.`);
  if (found.length > 1) stop(`Found ${what} ${found.length} times in index.html, and only one was expected.`);
  return found[0];
}

function splice(html, match, text) {
  return html.slice(0, match.index) + text + html.slice(match.index + match[0].length);
}

// A tag's text without the named attributes (and the space or line break
// in front of each).
function dropAttributes(tag, names) {
  let out = tag;
  for (const name of names) {
    out = out.replace(new RegExp(`\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'))?(?=[\\s>])`), '');
  }
  return out;
}

// ------------------------------------------------------------------
// Tags that load something from the internet
// ------------------------------------------------------------------

// For each kind of tag, the attributes whose address the browser fetches.
// Plain links (<a href>) are not here: nothing loads until someone clicks.
const LOADING_ATTRIBUTES = {
  script: ['src'],
  link: ['href', 'imagesrcset'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  input: ['src'],
  base: ['href'],
};
// <link> kinds that only name another page and fetch nothing.
const NAMING_RELS = new Set(['canonical', 'alternate', 'author', 'help', 'license', 'next', 'prev', 'search', 'me']);

const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ON_THE_WEB = /^\s*(?:https?:)?\/\//i;

function attributesOf(text) {
  const out = {};
  for (const m of text.matchAll(ATTRIBUTE)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// Every place the page would fetch something from another computer when it
// loads: [{ tag, attribute, address }]. tag is the tag as written. Inline
// scripts and styles count too, when an address starting with http:// or
// https:// is written in them. Comments are skipped.
export function internetLoads(html) {
  const loads = [];
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  // Inline code is checked as text, then emptied, so nothing written inside
  // it is read as a tag.
  const noCode = noComments.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (all, open, name, body, close) => {
    for (const m of body.matchAll(/https?:\/\/[^\s'"`)<>]+/gi)) {
      loads.push({ tag: `inline <${name.toLowerCase()}>`, attribute: 'text', address: m[0] });
    }
    return open + close;
  });
  for (const m of noCode.matchAll(TAG)) {
    const name = m[1].toLowerCase();
    const wanted = LOADING_ATTRIBUTES[name];
    if (!wanted) continue;
    const attrs = attributesOf(m[2]);
    if (name === 'link') {
      const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.length > 0 && rels.every((rel) => NAMING_RELS.has(rel))) continue;
    }
    for (const attribute of wanted) {
      const value = attrs[attribute];
      if (value === undefined) continue;
      // srcset and imagesrcset hold a list: "address size, address size".
      const addresses = attribute.endsWith('srcset')
        ? value.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
        : [value];
      for (const address of addresses) {
        if (ON_THE_WEB.test(address)) loads.push({ tag: m[0], attribute, address });
      }
    }
  }
  return loads;
}

// ------------------------------------------------------------------
// The launch page
// ------------------------------------------------------------------

// The launch page's text, made from index.html's text.
export function buildLaunchPage(indexHtml) {
  let html = indexHtml;
  // New lines are written with the line ending index.html uses.
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const lines = (...parts) => parts.map((line) => line + eol).join('');

  // 1. The note that the page is generated, and the launch flag, first in
  //    <head> so the flag is set before any other script or stylesheet.
  const head = findOnce(html, /<head>\r?\n/g, 'the <head> tag at the end of its line');
  html = splice(html, head, head[0] + lines(
    '  <!--',
    '    This file is generated. Do not edit it by hand.',
    '    It is the launch page: the Flight Console set up for a launch field',
    '    with no internet. It is made from index.html by',
    '      node launch-mode/build-launch-page.mjs',
    '    run from the repo\'s root folder. To change this page, change',
    '    index.html (or that script) and run the command again.',
    '    flight-console/test/launch-page.test.mjs fails while the two pages',
    '    don\'t match.',
    '    What is different from index.html: the script below turns launch mode',
    '    on (js/launch/launch-mode.js reads it), the fonts and Leaflet come',
    '    from vendor/ instead of the internet, flight-console-launch.css is',
    '    added, the tags for sharing a link are gone, and search engines are',
    '    told to leave the page out. CesiumJS has no tag in either page. With',
    '    launch mode on, js/views/cesium-loader.js loads it from vendor/cesium/.',
    '    Comments further down are index.html\'s own, so a few still talk about',
    '    Google Fonts and cdnjs.',
    '  -->',
    '  <script>window.FC_LAUNCH = true;</script>',
  ));

  // 2. The sharing tags go. The robots tag takes the first one's place.
  const social = [...html.matchAll(/^([ \t]*)<meta (?:property="og:|name="twitter:)[^>]*>\r?\n/gm)];
  if (social.length === 0) stop('Did not find the og: and twitter: meta tags in index.html. If they were taken out there, take this step out too.');
  // (Last to first, so the places found above stay right while lines go.)
  for (const m of [...social].reverse()) {
    html = splice(html, m, m === social[0] ? lines(`${m[1]}<meta name="robots" content="noindex">`) : '');
  }

  // 3. Google Fonts: two preconnects, the preload, the stylesheet that is
  //    switched on when it arrives, and the copy for when JavaScript is off.
  const gap = '\\r?\\n[ \\t]*';
  const fonts = findOnce(html, new RegExp(
    literal('<link rel="preconnect" href="https://fonts.googleapis.com">') + gap +
    literal('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>') + gap +
    '<link rel="preload" as="style" href="([^"]*)">' + gap +
    '<link rel="stylesheet" href="([^"]*)" media="print" onload="this\\.media=\'all\'">' + gap +
    '<noscript><link rel="stylesheet" href="([^"]*)"></noscript>', 'g'), 'the five Google Fonts tags (two preconnects, the preload, the stylesheet and its noscript copy)');
  for (const address of fonts.slice(1, 4)) {
    if (address !== FONTS_ADDRESS) {
      stop(`index.html asks Google Fonts for\n  ${address}\nbut ${LOCAL_FONTS_CSS} was made from\n  ${FONTS_ADDRESS}\nFetch the fonts again (flight-console/vendor/README.md says how), then update FONTS_ADDRESS in this file.`);
    }
  }
  html = splice(html, fonts, `<link rel="stylesheet" href="${LOCAL_FONTS_CSS}">`);

  // 4. Leaflet, from vendor/ instead of cdnjs. The integrity check goes with
  //    the CDN: the local files are the same bytes (the test checks them
  //    against the hashes in index.html).
  const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/';
  const fromCdnjs = (tag, attribute, file, local) => {
    const address = tag.match(new RegExp(`\\s${attribute}="([^"]*)"`))?.[1] ?? '';
    if (!address.startsWith(cdn)) stop(`The Leaflet tag doesn't load from cdnjs any more:\n  ${tag}\nUpdate this file to match.`);
    if (address !== `${cdn}${LEAFLET_VERSION}/${file}`) {
      stop(`index.html loads ${address}, but flight-console/vendor/leaflet/ holds Leaflet ${LEAFLET_VERSION}. Fetch that version into vendor/leaflet/ (flight-console/vendor/README.md says how), then update LEAFLET_VERSION in this file.`);
    }
    const out = dropAttributes(tag, ['integrity', 'crossorigin', 'referrerpolicy'])
      .replace(new RegExp(`(\\s${attribute}=")[^"]*(")`), `$1${local}$2`);
    return out;
  };

  const leafletCss = findOnce(html, /<link rel="stylesheet" href="[^"]*\/leaflet\.css"[^>]*>/g, 'the Leaflet stylesheet tag');
  html = splice(html, leafletCss, fromCdnjs(leafletCss[0], 'href', 'leaflet.css', LOCAL_LEAFLET_CSS));

  const leafletJs = findOnce(html, /<script id="fc-lib-leaflet"[^>]*><\/script>/g, 'the Leaflet script tag (id="fc-lib-leaflet")');
  const localJs = fromCdnjs(leafletJs[0], 'src', 'leaflet.js', LOCAL_LEAFLET_JS);
  // js/main.js finds the script by its id and reads data-state, which these
  // two attributes set.
  for (const part of [' async', 'onload="this.dataset.state=\'loaded\'"', 'onerror="this.dataset.state=\'failed\'"']) {
    if (!localJs.includes(part)) stop(`The Leaflet script tag has lost ${part.trim()}, which js/main.js needs:\n  ${leafletJs[0]}`);
  }
  html = splice(html, leafletJs, localJs);

  // 5. Launch mode's own styles, after the last stylesheet in <head>.
  const headEnd = html.indexOf('</head>');
  if (headEnd === -1) stop('Did not find the </head> tag in index.html.');
  const sheets = [...html.slice(0, headEnd).matchAll(/^([ \t]*)<link rel="stylesheet"[^>]*>[ \t]*\r?\n/gm)];
  if (sheets.length === 0) stop('Did not find a stylesheet tag on a line of its own in the <head> of index.html.');
  const last = sheets[sheets.length - 1];
  html = splice(html, last, last[0] + lines(
    `${last[1]}<!-- Launch mode's own styles. Only this page loads them. -->`,
    `${last[1]}<link rel="stylesheet" href="${LAUNCH_CSS}">`,
  ));

  // Anything left that would need the network is a tag this file doesn't
  // know about yet.
  const loads = internetLoads(html);
  if (loads.length > 0) {
    stop(`index.html has ${loads.length === 1 ? 'a tag that loads' : 'tags that load'} from the internet, and the launch page has to work without it:\n` +
      loads.map((load) => `  ${load.address}  (${load.attribute} of ${load.tag.replace(/\s+/g, ' ')})`).join('\n') +
      '\nSave a local copy in flight-console/vendor/ and add a step for it in this file.');
  }
  return html;
}

// ------------------------------------------------------------------
// Run from the command line
// ------------------------------------------------------------------

function main() {
  const relative = (file) => path.relative(path.resolve(HERE, '..'), file).split(path.sep).join('/');
  const check = process.argv.includes('--check');
  const built = buildLaunchPage(fs.readFileSync(INDEX_PATH, 'utf8'));
  if (check) {
    const current = fs.existsSync(LAUNCH_PATH) ? fs.readFileSync(LAUNCH_PATH, 'utf8') : null;
    if (current === built) {
      console.log(`${relative(LAUNCH_PATH)} is up to date.`);
      return;
    }
    console.error(current === null
      ? `${relative(LAUNCH_PATH)} doesn't exist yet. Run node launch-mode/build-launch-page.mjs to make it.`
      : `${relative(LAUNCH_PATH)} is out of date. Run node launch-mode/build-launch-page.mjs to make it again.`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(LAUNCH_PATH, built);
  console.log(`Wrote ${relative(LAUNCH_PATH)} from ${relative(INDEX_PATH)} (${Buffer.byteLength(built)} bytes).`);
}

const runDirectly = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (runDirectly) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
