// smoke.mjs
// The quick check that launch mode loads with no internet. It starts the
// local server on a test port, opens the launch page in a headless Chrome
// twice (once with the internet blocked, once with the internet up but
// dead), and prints what happened: whether the page started, its
// exceptions and console errors, and every request it tried to make to the
// internet. On the launch page that last list must be empty.
//
// Run it from anywhere:
//   node launch-mode/test/smoke.mjs
//   node launch-mode/test/smoke.mjs --port 8102 --shot C:/some/folder/launch.png
//
// Options:
//   --port N          the test port for the server (default 8102, never 8000)
//   --shot PATH       saves a picture of the page (.png). The second run's
//                     picture is saved next to it with -tarpit in its name.
//   --page FILE       the page in flight-console/ to open (default
//                     launch.html, or index.html while that is missing)
//   --networks LIST   which runs to do: blocked, tarpit, open
//                     (default blocked,tarpit)
//   --wait SECONDS    how long the page gets to start (default 20, and 120
//                     for tarpit, where a page that waits on the internet
//                     is slow)
//   --settle SECONDS  how long to watch the page after it starts (default 4)
//   --system-proxy    starts Chrome without --no-proxy-server, the way a
//                     plain Chrome window runs. In tarpit it then waits
//                     about 30 s on its proxy look-up before any page
//                     loads. launch-mode.bat turns that look-up off.
//
// Exit code: 0 when the page started in every run, 1 when it did not, 2 for
// a problem with the test itself.
//
// Used by: me and the other launch mode checks. See cdp.mjs for the helper
// this is built on.

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchChrome, isExternalUrl, sleep, ROOT } from './cdp.mjs';

const NAMES = {
  blocked: 'Internet blocked (like Wi-Fi off)',
  tarpit: 'Internet up but dead (tarpit: connects, never answers)',
  open: 'Internet open',
};

function readArgs(argv) {
  const args = { port: 8102, shot: null, page: null, networks: ['blocked', 'tarpit'], wait: null, settle: 4, systemProxy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`${name} needs a value`);
      i += 1;
      return value;
    };
    if (name === '--system-proxy') args.systemProxy = true;
    else if (name === '--port') args.port = Number(need());
    else if (name === '--shot') args.shot = need();
    else if (name === '--page') args.page = need();
    else if (name === '--networks') args.networks = need().split(',').map((n) => n.trim()).filter(Boolean);
    else if (name === '--wait') args.wait = Number(need());
    else if (name === '--settle') args.settle = Number(need());
    else throw new Error(`I don't know the option ${name}`);
  }
  if (!Number.isInteger(args.port) || args.port === 8000) throw new Error('--port needs a test port, such as 8102. Port 8000 is the real one.');
  for (const network of args.networks) {
    if (!NAMES[network]) throw new Error(`--networks takes blocked, tarpit and open, not ${network}`);
  }
  if (args.wait !== null && !(args.wait > 0)) throw new Error('--wait needs a number of seconds');
  if (!(args.settle >= 0)) throw new Error('--settle needs a number of seconds');
  return args;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const short = (text, max = 150) => {
  const line = String(text).split('\n')[0];
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

function printList(title, items, format) {
  if (!items.length) {
    console.log(`  ${title}: none`);
    return;
  }
  console.log(`  ${title}: ${items.length}`);
  for (const item of items.slice(0, 40)) console.log(`    - ${format(item)}`);
  if (items.length > 40) console.log(`    - and ${items.length - 40} more`);
}

function requestLine(r) {
  const how = r.pending ? 'no answer yet' : r.failed ? `failed ${r.errorText}` : `answered ${r.status}`;
  const from = r.target === 'page' ? '' : ` (from a ${r.target.replace('_', ' ')})`;
  return `${how}, ${r.resourceType}${from}, ${short(r.url, 130)}`;
}

function shotPath(base, network, first) {
  if (!base) return null;
  if (first) return base;
  const ext = path.extname(base);
  return `${base.slice(0, base.length - ext.length)}-${network}${ext}`;
}

// One run: a fresh Chrome on the given network. Returns true when the page started.
async function run(network, { server, pagePath, args, first }) {
  console.log('');
  console.log(NAMES[network]);
  const waitMs = (args.wait ?? (network === 'tarpit' ? 120 : 20)) * 1000;
  const browser = await launchChrome({ network, systemProxy: args.systemProxy });
  try {
    const page = await browser.newPage();
    const began = Date.now();
    await page.goto(server.url(pagePath), { waitUntil: 'none' });
    let started = false;
    try {
      await page.waitFor(() => window.fcStarted === true, { timeout: waitMs, interval: 50 });
      started = true;
    } catch {
      started = false;
    }
    const startMs = Date.now() - began;
    if (started) {
      // The console screen comes a moment after the code starts.
      await page.waitFor(() => document.body.dataset.fcScreen === 'console', { timeout: 10000, interval: 50 }).catch(() => {});
    }
    const shownMs = Date.now() - began;
    await sleep(args.settle * 1000);

    const state = await page.evaluate(() => ({
      started: window.fcStarted === true,
      screen: document.body.dataset.fcScreen ?? null,
      launch: window.FC_LAUNCH === true,
      hub: typeof window.fcLaunch === 'object' && window.fcLaunch !== null,
      title: document.title,
    })).catch((err) => ({ problem: err.message }));

    console.log(`  Page started (window.fcStarted): ${started ? `yes, ${seconds(startMs)} after opening it` : `NO, not within ${seconds(waitMs)}`}`);
    if (state.problem) {
      console.log(`  The page could not be asked about itself: ${short(state.problem)}`);
    } else {
      console.log(`  Screen showing: ${state.screen ?? 'none'}${state.screen === 'console' ? ` (${seconds(shownMs)} after opening the page)` : ''}`);
      console.log(`  Launch mode on this page: ${state.launch ? 'yes' : 'no'}${state.launch && !state.hub ? ', but window.fcLaunch is missing' : ''}`);
    }

    const all = page.requests();
    const external = all.filter((r) => isExternalUrl(r.url));
    // A local file that is missing or failed. A load the page itself gave
    // up on (canceled) is not counted.
    const localBad = all.filter((r) => /^https?:/i.test(r.url) && !isExternalUrl(r.url)
      && ((r.failed && !/canceled|ERR_ABORTED/.test(r.errorText ?? '')) || (r.status !== null && r.status >= 400)));
    console.log(`  Requests: ${all.length} in all`);
    printList('Exceptions', page.exceptions(), (e) => `${short(e.text)}${e.url ? ` (${short(e.url, 80)}${e.line ? `:${e.line}` : ''})` : ''}`);
    printList('Console errors', page.consoleErrors(), (m) => `${short(m.text)}${m.url ? ` (${short(m.url, 80)})` : ''}`);
    printList('Requests to the internet', external, requestLine);
    printList('Local files that did not load', localBad, requestLine);
    if (browser.tarpit) {
      const hosts = [...new Set(browser.tarpit.connections().map((c) => c.host ?? 'a host that did not say its name'))];
      // Chrome itself calls home too, so this list is longer than the page's own.
      console.log(`  Hosts the browser tried to connect to, Chrome's own included: ${hosts.length ? hosts.join(', ') : 'none'}`);
    }
    const shot = shotPath(args.shot, network, first);
    if (shot) {
      try {
        console.log(`  Picture: ${await page.screenshot(shot)}`);
      } catch (err) {
        console.log(`  The picture could not be saved: ${short(err.message)}`);
      }
    }
    return started;
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  let pageFile = args.page;
  let note = '';
  if (!pageFile) {
    if (fs.existsSync(path.join(ROOT, 'flight-console', 'launch.html'))) {
      pageFile = 'launch.html';
    } else {
      pageFile = 'index.html';
      note = 'flight-console/launch.html does not exist yet, so this opens index.html, the normal page. It is expected to ask for the internet.';
    }
  }
  if (!fs.existsSync(path.join(ROOT, 'flight-console', pageFile))) throw new Error(`There is no flight-console/${pageFile}`);
  const pagePath = `/flight-console/${pageFile}?track`;

  console.log('Launch mode smoke test');
  const server = await startServer({ port: args.port });
  console.log(`Server: ${server.origin}, serving ${server.info.root}${server.owned ? '' : ' (it was already running, and is left running)'}`);
  console.log(`Page: ${pagePath}`);
  console.log(`Chrome: ${args.systemProxy ? 'looks for a proxy first, like a plain Chrome window' : 'no proxy look-up (--no-proxy-server), like launch-mode.bat'}`);
  if (note) console.log(`Note: ${note}`);

  const results = [];
  try {
    for (const network of args.networks) {
      results.push([network, await run(network, { server, pagePath, args, first: results.length === 0 })]);
    }
  } finally {
    await server.stop();
  }

  console.log('');
  const failed = results.filter(([, started]) => !started).map(([network]) => network);
  if (failed.length) console.log(`Result: the page did NOT start with the internet ${failed.join(' and ')}.`);
  else console.log(`Result: the page started in every run (${results.map(([network]) => network).join(', ')}).`);
  return failed.length ? 1 : 0;
}

// The exit code is set and Node is left to end by itself. Everything that
// was started has been closed by now.
process.exitCode = await main().catch((err) => {
  console.error(`smoke.mjs could not run: ${err.message}`);
  return 2;
});
