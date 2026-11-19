// launch-log-browser.mjs: the browser checks for launch mode's flight log
// and test capture (js/launch/flight-log.js and js/launch/capture.js), in a
// real headless Chrome with the internet blocked. It uses the launch mode
// test rig (launch-mode/test/cdp.mjs) and the local server on a test port.
// It is not a node --test file (Chrome takes a few minutes), so run it by
// hand from the website folder:
//
//   node flight-console/test/launch-log-browser.mjs
//   node flight-console/test/launch-log-browser.mjs --port 8105 --out C:/some/folder capture close
//
// The checks (all of them when none is named):
//   capture   the capture at 20x through the live path: every line reaches
//             the flight store, the server copy on disk, a file from the
//             browser's private file system (useFileHandle) and IndexedDB
//   close     closing the tab in the middle of a capture, then RECOVER
//   kill      killing Chrome in the middle of a capture, then RECOVER
//   restore   a real connection (a stand-in port), Chrome killed, RECOVER:
//             the flight is back on the live view and CONNECT carries it on
//   load      the server copy and a recording's raw log export load back
//             with LOAD FILE and replay
//   realtime  speed 1 for 32 s: a status line and a packet each second, and
//             the disk file keeps up
//   tarpit    the capture with the internet up but dead
//   connect   CONNECT on the launch page: the save box, a granted port, a
//             cancelled save box, a lost port and a reconnect
//   normal    the normal page (index.html): no log, no capture, no save box,
//             the recorder's 2 s chunks, LOAD FILE of a flight log
//
// THE STAND-IN PORT. Headless Chrome has no serial ports and can't show a
// save box, so the checks that need them put a stand-in for
// navigator.serial and showSaveFilePicker in the page before its code
// runs. The page's own serial-link.js reads the stand-in's stream exactly
// as it reads a real port. The stand-in asks for a click the way Chrome
// does (navigator.userActivation), so the CONNECT flow is tested honestly.
//
// It prints one line per check with the real numbers, and ends with exit
// code 1 if any failed. The files it made in flight-logs/ are deleted at
// the end, and the pictures are left in --out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchChrome, sleep, ROOT } from '../../launch-mode/test/cdp.mjs';
import { planCapture } from '../js/launch/capture-plan.js';

const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  if (i < 0) return fallback;
  const value = ARGS[i + 1];
  ARGS.splice(i, 2);
  return value;
};
const PORT = Number(opt('--port', '8105'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'fc-launch-log')));
const ALL = ['capture', 'close', 'kill', 'restore', 'load', 'realtime', 'tarpit', 'connect', 'normal'];
const WANT = ARGS.length ? ARGS : ALL;
if (PORT === 8000) throw new Error('Port 8000 is the real server. Use a test port.');
fs.mkdirSync(OUT, { recursive: true });

const LOGS = path.join(ROOT, 'flight-logs');
const CAPTURE = fs.readFileSync(path.join(ROOT, 'flight-console/test/radio-board-rx-capture.log'), 'utf8');
const CAPTURE_LINES = CAPTURE.split(/\r?\n/).filter((l) => l !== '');
const FIELD = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch-mode/field.json'), 'utf8')).center;
const SHIFTED = planCapture(CAPTURE, { target: FIELD }).lines;
const PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}) > /;

const results = [];
const made = new Set();          // flight-logs/ files this run made
const logsBefore = new Set(fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []);
const profiles = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// What the page puts in front of its own code for the stand-in port and save box.
const FAKE = `(() => {
  const enc = new TextEncoder();
  const fake = window.__fake = { requestCalls: 0, pickerCalls: 0, pickerMode: 'opfs', pickerDelayMs: 0, granted: false, opens: 0, pickerOpts: null };
  const port = {
    readable: null,
    controller: null,
    async open() { fake.opens += 1; port.readable = new ReadableStream({ start(c) { port.controller = c; } }); },
    async setSignals() {},
    async close() { port.readable = null; },
    getInfo() { return {}; },
    send(text) { port.controller.enqueue(enc.encode(text)); },
    unplug() { const c = port.controller; port.readable = null; c.error(new DOMException('The device has been lost.', 'NetworkError')); },
  };
  fake.port = port;
  const serial = {
    async requestPort() {
      fake.requestCalls += 1;
      if (!navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      fake.granted = true;
      return port;
    },
    async getPorts() { return fake.granted ? [port] : []; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  window.showSaveFilePicker = async (opts) => {
    fake.pickerCalls += 1;
    fake.pickerOpts = opts;
    if (fake.pickerDelayMs) await new Promise((r) => setTimeout(r, fake.pickerDelayMs));
    if (fake.pickerMode === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
    const dir = await navigator.storage.getDirectory();
    fake.pickedName = 'picked-' + Math.random().toString(36).slice(2, 8) + '-' + opts.suggestedName;
    return dir.getFileHandle(fake.pickedName, { create: true });
  };
})();`;

// A flight log's text checked against the receiver lines it should hold.
function compareLog(text, expected) {
  const problems = [];
  const lines = text.split('\n');
  if (lines.at(-1) !== '') problems.push('the file does not end with a line feed');
  lines.pop();
  if (lines[0] !== '# Dogtooth flight log') problems.push(`first line is ${JSON.stringify(lines[0])}`);
  if (!/^# started /.test(lines[1] ?? '')) problems.push('no "# started" line');
  if (!/^# written by the Flight Console launch page$/.test(lines[2] ?? '')) problems.push('no "# written by" line');
  if (!/^# each line: /.test(lines[3] ?? '')) problems.push('no "# each line" line');
  const data = [];
  let lastT = -Infinity;
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    const m = PREFIX.exec(line);
    if (!m) { problems.push(`a line with no time: ${line.slice(0, 60)}`); continue; }
    const t = Date.parse(m[1]);
    if (!(t >= lastT)) problems.push(`time goes back at ${m[1]}`);
    lastT = t;
    data.push(line.slice(m[0].length));
  }
  if (data.length !== expected.length) problems.push(`${data.length} receiver lines, expected ${expected.length}`);
  const firstDiff = data.findIndex((l, i) => l !== expected[i]);
  if (firstDiff >= 0) problems.push(`line ${firstDiff + 1} differs: ${data[firstDiff]?.slice(0, 50)}`);
  return { ok: !problems.length, problems, data };
}

const readServerLog = (name) => fs.readFileSync(path.join(LOGS, name), 'utf8');
const noteFiles = (status) => { for (const l of status?.logs ?? []) if (l.server) made.add(l.server); };

async function openPage(browser, server, url, { fake = false } = {}) {
  const page = await browser.newPage();
  if (fake) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE });
  await page.goto(server.url(url));
  await page.waitFor(() => window.fcStarted === true, { timeout: 30000, message: 'the console did not start' });
  if (url.includes('launch.html')) {
    await page.waitFor(() => window.fcLaunch?.parts?.log && window.fcLaunch?.parts?.capture, { timeout: 30000, message: 'launch mode\'s log and capture did not start' });
  }
  return page;
}

const logStatus = (page) => page.evaluate(() => window.fcLaunch.parts.log.status());
const capStatus = (page) => page.evaluate(() => window.fcLaunch.parts.capture.status());

// Waits until every copy of the shown log has every line.
async function settled(page, { browserLines = null, timeout = 20000 } = {}) {
  await page.waitFor((want) => {
    const s = window.fcLaunch.parts.log.status();
    const fileOk = s.file.state !== 'saving' || s.file.pending === 0;
    const serverOk = s.server.state === 'none' || s.server.pending === 0;
    const browserOk = want === null || s.browser.lines === want;
    return fileOk && serverOk && browserOk;
  }, { timeout, args: [browserLines], message: 'the copies did not catch up' });
  return logStatus(page);
}

// The OPFS file the tests give the log.
async function giveOpfsFile(page, name) {
  return page.evaluate(async (fileName) => {
    const dir = await navigator.storage.getDirectory();
    try { await dir.removeEntry(fileName); } catch { /* not there */ }
    const handle = await dir.getFileHandle(fileName, { create: true });
    window.__opfs = handle;
    return window.fcLaunch.parts.log.useFileHandle(handle);
  }, name);
}
const readOpfs = (page, name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  return (await (await dir.getFileHandle(fileName)).getFile()).text();
}, name);

// The page's saved LOCAL flights, newest first, with their line counts.
const savedFlights = (page) => page.evaluate(async () => {
  const db = window.fcLaunch?.ctx?.localConsole?.test?.db;
  const all = (await db.listFlights()).filter((r) => r.status === 'saved').sort((a, b) => b.createdAt - a.createdAt);
  const out = [];
  for (const r of all) {
    const data = await db.readLines(r.id);
    out.push({ id: r.id, title: r.title, test: Boolean(r.test), source: r.source, sampleCount: r.sampleCount, lines: data.lines, times: data.times?.length ?? 0, originalName: r.originalName });
  }
  return out;
});

// Clicks RECOVER and then SAVE in the name box. Returns the recover line's text.
async function recover(page, shot) {
  await page.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed' });
  const text = await page.evaluate(() => document.getElementById('fc-recover').textContent.replace(/\s+/g, ' ').trim());
  if (shot) await page.screenshot(shot);
  await page.click('#fc-recover-actions button');
  await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not open' });
  const name = await page.evaluate(() => document.getElementById('fc-name-input').value);
  await page.click('dialog.fc-dialog button[type="submit"]');
  await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
  return { text, name };
}

// A recording that stops opens the name box. SAVE it and wait until it closes.
async function saveNameBox(page) {
  await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not open' });
  await page.click('dialog.fc-dialog button[type="submit"]');
  await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
}

// Waits for the capture to have sent at least n lines and to be between a
// packet and the next status line (0.9 s at real speed), so the count is
// exact when the page goes away.
async function midCapture(page, n) {
  return page.waitFor((want) => {
    const s = window.fcLaunch.parts.capture.status();
    return s.playing && s.sent >= want && s.sent % 2 === 0 ? s.sent : false;
  }, { timeout: 90000, interval: 20, args: [n], message: 'the capture never got that far' });
}

// ------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------
const server = await startServer({ port: PORT });
const blockedTimes = {};
let fullServerLog = null;        // the capture check's server copy (for load)
const restoredForLoad = [];      // { id, lines } restored recordings to load back

async function runCapture(network) {
  const browser = await launchChrome({ network });
  try {
    const began = Date.now();
    const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=20&shift=field');
    const up = Date.now() - began;
    await page.waitFor(() => window.fcLaunch.parts.capture.status().playing, { timeout: 30000, message: 'the capture never started' });
    const playing = Date.now() - began;
    noteFiles(await logStatus(page));
    const given = await giveOpfsFile(page, 'opfs-capture-check.log');
    await sleep(1500);
    await page.screenshot(path.join(OUT, `capture-${network}-playing.png`));
    const ended = await page.waitFor(() => window.fcLaunch.parts.capture.status().last, { timeout: 60000, message: 'the capture never ended' });
    const done = Date.now() - began;
    const status = await settled(page, { browserLines: 253 });
    noteFiles(status);
    await sleep(800);
    await page.screenshot(path.join(OUT, `capture-${network}-ended.png`));
    const feed = await page.evaluate(() => {
      const live = window.fcLaunch.ctx.live;
      const rocket = live.stores.flight.getRocket('1');
      return { counts: live.flightFeed.counts, samples: rocket?.samples.length ?? 0, first: rocket?.samples[0]?.gps ?? null, mode: live.mode };
    });
    return { browser, page, status, ended, feed, given, timing: { up, playing, done } };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

try {
  if (WANT.includes('capture')) {
    const run = await runCapture('blocked');
    const { page, status, ended, feed, timing } = run;
    blockedTimes.capture = timing;
    try {
      check('capture: played every line', ended.reason === 'ended' && ended.sent === 253, `sent ${ended.sent} of ${ended.total}, reason ${ended.reason}, ${timing.done - timing.playing} ms from start to end at 20x`);
      check('capture: every packet reached the flight store', feed.counts.samples === 126 && feed.samples === 126 && feed.counts.bad === 0,
        `feed ${JSON.stringify(feed.counts)}, rocket 1 has ${feed.samples} samples, live mode ${feed.mode}`);
      check('capture: the first fix is on the field', Math.abs(feed.first.lat - FIELD.lat) < 1e-6 && Math.abs(feed.first.lon - FIELD.lon) < 1e-6,
        `first fix ${feed.first.lat}, ${feed.first.lon}, field ${FIELD.lat}, ${FIELD.lon}`);
      const serverText = readServerLog(status.server.name);
      fullServerLog = { name: status.server.name, text: serverText };
      const cmp = compareLog(serverText, SHIFTED);
      check('capture: the server copy has every line in order with valid times', cmp.ok && /^test-capture-\d{4}-\d{2}-\d{2}-\d{6}-page\.log$/.test(status.server.name),
        `flight-logs/${status.server.name}: ${cmp.data.length} receiver lines${cmp.problems.length ? `, problems: ${cmp.problems.join('; ')}` : ', all 253 the same as the capture (moved), times never go back'}`);
      check('capture: the header says it is a test and how it was moved', /# test capture, not live data: test\/radio-board-rx-capture\.log, played at 20 times real speed\n# every lat= and lon= in its PKT lines was moved by \+9\.7018213 and \+43\.9517297 degrees/.test(serverText),
        serverText.split('\n').slice(4, 6).join(' | '));
      const opfs = await readOpfs(page, 'opfs-capture-check.log');
      check('capture: a private file system file given through useFileHandle gets the same lines', opfs === serverText,
        `${opfs.length} bytes, ${opfs === serverText ? 'byte for byte the same as the server copy' : 'DIFFERENT from the server copy'}; status file ${JSON.stringify({ state: status.file.state, lines: status.file.lines, pending: status.file.pending })}`);
      const saved = await savedFlights(page);
      const test = saved.find((r) => r.test);
      const same = test && test.lines.length === 253 && test.lines.every((l, i) => l === SHIFTED[i]);
      check('capture: IndexedDB has every line', same && test.times === 253,
        test ? `"${test.title}" has ${test.lines.length} lines (${same ? 'all the same as the capture' : 'NOT the same'}), ${test.times} arrival times, browser status ${JSON.stringify(status.browser)}` : 'no test recording was saved');
      const external = page.externalRequests();
      const hosts = [...new Set(external.map((r) => new URL(r.url).host))];
      const mine = page.requests().filter((r) => /\/launch-mode\/(ping|log\/append)/.test(r.url));
      check('capture: the log only talked to this laptop', mine.every((r) => new URL(r.url).hostname === 'localhost'),
        `${mine.length} requests to /launch-mode/ (all localhost). Other pages' parts asked the internet for: ${hosts.join(', ') || 'nothing'}`);
      check('capture: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions, console errors: ${page.consoleErrors().map((m) => m.text.slice(0, 80)).join(' | ') || 'none'}`);
    } finally {
      await run.browser.close();
    }
  }

  if (WANT.includes('close') || WANT.includes('kill')) {
    const profile = path.join(OUT, `profile-c-${process.pid}`);
    profiles.push(profile);
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      if (WANT.includes('close')) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
        await page.waitFor(() => window.fcLaunch.parts.log.status().logs.length, { timeout: 30000 });
        noteFiles(await logStatus(page));
        const sent = await midCapture(page, 40);
        const before = await logStatus(page);
        noteFiles(before);
        await page.close();
        const page2 = await openPage(browser, server, '/flight-console/launch.html?track');
        const { text } = await recover(page2, path.join(OUT, 'close-recover-offer.png'));
        await sleep(500);
        const saved = await savedFlights(page2);
        const back = saved.find((r) => r.test);
        const n = back?.lines.length ?? 0;
        const same = back && back.lines.every((l, i) => l === SHIFTED[i]);
        const serverN = compareLog(readServerLog(before.server.name), SHIFTED.slice(0, sent)).data.length;
        check('close: closing the tab mid-capture, then RECOVER, brings every line back', back && n === sent && same,
          `${sent} lines sent before the tab closed, ${n} came back from IndexedDB (${same ? 'all the same lines in order' : 'NOT the same'}), "${back?.title}". The server copy has ${serverN}. Offer said: ${text}`);
        if (back) restoredForLoad.push({ id: back.id, lines: n, what: 'closed tab' });
        await page2.screenshot(path.join(OUT, 'close-recovered.png'));
        await page2.close();
      }
      if (WANT.includes('kill')) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
        await page.waitFor(() => window.fcLaunch.parts.log.status().logs.length, { timeout: 30000 });
        noteFiles(await logStatus(page));
        const sent = await midCapture(page, 30);
        const before = await logStatus(page);
        noteFiles(before);
        await browser.kill();
        browser = await launchChrome({ network: 'blocked', userDataDir: profile });
        const page2 = await openPage(browser, server, '/flight-console/launch.html?track');
        const { text } = await recover(page2, path.join(OUT, 'kill-recover-offer.png'));
        await sleep(500);
        const saved = await savedFlights(page2);
        const back = saved.find((r) => r.test && r.lines.length < 200 && !restoredForLoad.some((x) => x.id === r.id));
        const n = back?.lines.length ?? 0;
        const same = back && back.lines.every((l, i) => l === SHIFTED[i]);
        const serverN = compareLog(readServerLog(before.server.name), SHIFTED.slice(0, sent)).data.length;
        check('kill: killing Chrome mid-capture, then RECOVER, brings every line back', back && n === sent && same,
          `${sent} lines sent before Chrome was killed, ${n} came back from IndexedDB (${same ? 'all the same lines in order' : 'NOT the same'}). The server copy has ${serverN}. Offer said: ${text}`);
        if (back) restoredForLoad.push({ id: back.id, lines: n, what: 'killed Chrome' });
        await page2.close();
      }
      if (WANT.includes('load') && restoredForLoad.length) {
        const page = await openPage(browser, server, '/flight-console/launch.html?track');
        for (const r of restoredForLoad) {
          const out = await page.evaluate(async (id) => {
            const lc = window.fcLaunch.ctx.localConsole;
            const mod = await import('/flight-console/js/local/local-flights.js');
            const record = await lc.test.db.getFlight(id);
            const data = await lc.readLines(id);
            const text = mod.rawLogText(record, data.lines);
            const name = mod.exportFileName(record, 'log');
            await lc.test.loadFile(new File([text], name));
            const all = await lc.test.db.listFlights();
            const loaded = all.filter((x) => x.source === 'file' && x.originalName === name).sort((a, b) => b.createdAt - a.createdAt)[0];
            const flight = await (await lc.find(loaded.id)).load();
            return { name, sampleCount: loaded.sampleCount, replaySamples: flight.samples.length, packets: data.lines.filter((l) => l.startsWith('PKT ')).length };
          }, r.id);
          check(`load: the raw log export of the recording recovered after a ${r.what} replays`, out.replaySamples === out.packets && out.sampleCount === out.packets,
            `${out.name}: ${r.lines} lines, ${out.packets} packets, loaded with ${out.sampleCount} samples, the replay has ${out.replaySamples}`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('restore')) {
    const profile = path.join(OUT, `profile-r-${process.pid}`);
    profiles.push(profile);
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open' });
      const first = CAPTURE_LINES.slice(0, 60);
      for (let i = 0; i < first.length; i += 10) {
        await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, first.slice(i, i + 10));
        await sleep(300);
      }
      await page.waitFor(() => window.fcLaunch.parts.log.status().browser.lines === 60, { timeout: 10000, message: 'the browser copy did not reach 60 lines' });
      const before = await logStatus(page);
      noteFiles(before);
      await browser.kill();
      browser = await launchChrome({ network: 'blocked', userDataDir: profile });
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await recover(page2, path.join(OUT, 'restore-offer.png'));
      await page2.waitFor(() => window.fcLaunch.parts.log.status().restored, { timeout: 15000, message: 'the recording did not go back on the live view' });
      await sleep(1200);
      await page2.screenshot(path.join(OUT, 'restore-back-on-screen.png'));
      const back = await page2.evaluate(() => {
        const live = window.fcLaunch.ctx.live;
        const rocket = live.stores.flight.getRocket('1');
        return {
          restored: window.fcLaunch.parts.log.status().restored,
          samples: rocket?.samples.length ?? 0,
          fix: window.fcLaunch.parts.panel?.status?.().fix ?? null,
          liveData: window.fcLaunch.parts.log.liveData(),
          logLines: window.fcLaunch.parts.log.status().lines,
        };
      });
      check('restore: a recovered flight is back on the live view, without being logged again', back.samples === 30 && back.restored?.lines === 60 && back.logLines === 0,
        `60 lines recorded before the kill, ${back.restored?.lines} played back, rocket 1 has ${back.samples} samples, the panel's fix is ${back.fix ? `${back.fix.lat}, ${back.fix.lon} (${back.fix.source})` : 'missing'}, the new log has ${back.logLines} lines`);
      // CONNECT carries the same flight on.
      await page2.click('#bc-connect');
      await page2.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open again' });
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(60, 80));
      await page2.waitFor(() => window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples.length === 40, { timeout: 10000, message: 'the new packets did not join the flight' });
      const carried = await page2.evaluate(() => {
        const live = window.fcLaunch.ctx.live;
        const s = live.stores.flight.getRocket('1').samples;
        return { n: s.length, seqs: s.map((x) => x.extra.seq), restarts: live.flightFeed.counts.restarts };
      });
      const continuous = carried.seqs.every((q, i) => i === 0 || q === carried.seqs[i - 1] + 1);
      check('restore: CONNECT carries the same flight on', carried.n === 40 && continuous && carried.restarts === 0,
        `rocket 1 has ${carried.n} samples, sequence ${carried.seqs[0]} to ${carried.seqs.at(-1)} with ${continuous ? 'no gap' : 'a GAP'}, ${carried.restarts} restarts`);
      noteFiles(await logStatus(page2));
      if (WANT.includes('load')) {
        const saved = (await savedFlights(page2)).find((r) => !r.test && r.source === 'recording');
        if (saved) restoredForLoad.push({ id: saved.id, lines: saved.lines.length, what: 'real connection and a killed Chrome' });
        const out = await page2.evaluate(async (id) => {
          const lc = window.fcLaunch.ctx.localConsole;
          const mod = await import('/flight-console/js/local/local-flights.js');
          const record = await lc.test.db.getFlight(id);
          const data = await lc.readLines(id);
          const text = mod.rawLogText(record, data.lines);
          await lc.test.loadFile(new File([text], 'restored-export.log'));
          const loaded = (await lc.test.db.listFlights()).filter((x) => x.originalName === 'restored-export.log')[0];
          return { sampleCount: loaded?.sampleCount, lines: data.lines.length };
        }, saved?.id);
        check('load: the raw log export of the recovered real recording replays', out.sampleCount === 30, `${out.lines} lines exported, loaded with ${out.sampleCount} samples (30 packets)`);
      }
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('load') && fullServerLog) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track');
      const file = path.join(LOGS, fullServerLog.name);
      await page.setFiles('input.fc-file-input', [file]);
      await page.waitFor((name) => /Loaded /.test(document.getElementById('fc-file-text')?.textContent ?? '') && location.search.includes('flight=local-'), { timeout: 20000, args: [fullServerLog.name], message: 'LOAD FILE did not load the server copy' });
      const out = await page.evaluate(async (name) => {
        const lc = window.fcLaunch.ctx.localConsole;
        const loaded = (await lc.test.db.listFlights()).find((x) => x.originalName === name);
        const flight = await (await lc.find(loaded.id)).load();
        return { sampleCount: loaded.sampleCount, replay: flight.samples.length, first: flight.samples[0]?.gps, durationS: loaded.durationS };
      }, fullServerLog.name);
      await sleep(3000);
      await page.screenshot(path.join(OUT, 'load-server-copy.png'));
      check('load: the server copy loads with LOAD FILE and replays like the capture', out.sampleCount === 126 && out.replay === 126,
        `${fullServerLog.name}: ${out.sampleCount} samples, the replay has ${out.replay}, ${out.durationS} s of data, first fix ${out.first?.lat}, ${out.first?.lon}`);
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('realtime')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/launch.html?track&capture=1&speed=1&shift=field');
      await page.waitFor(() => window.fcLaunch.parts.capture.status().playing, { timeout: 30000, message: 'the capture never started' });
      noteFiles(await logStatus(page));
      await giveOpfsFile(page, 'opfs-realtime-check.log');
      const samples = [];
      const start = Date.now();
      while (Date.now() - start < 32500) {
        samples.push(await page.evaluate(() => {
          const c = window.fcLaunch.parts.capture.status();
          const s = window.fcLaunch.parts.log.status();
          return { at: Date.now(), sent: c.sent, file: s.file.lines, filePending: s.file.pending, ago: s.file.lastWriteAgoMs, cycle: s.file.cycleMs, server: s.server.lines, browser: s.browser.lines };
        }));
        await sleep(1000);
      }
      const first = samples[1];
      const last = samples.at(-1);
      const seconds = (last.at - first.at) / 1000;
      const rate = (last.sent - first.sent) / seconds;
      const behind = samples.slice(1).map((x) => x.sent - x.file);
      const ages = samples.slice(1).map((x) => x.ago);
      const browserBehind = samples.slice(1).map((x) => x.sent - x.browser);
      check('realtime: a status line and a packet each second', rate > 1.9 && rate < 2.1,
        `${last.sent - first.sent} lines in ${seconds.toFixed(1)} s = ${rate.toFixed(2)} lines a second`);
      // A cycle starts at most once a second, and lines come 0.1 s and 0.9 s
      // apart, so up to 3 lines and about 2 s are normal between writes.
      const cycles = samples.slice(1).map((x) => x.cycle).filter(Number.isFinite);
      check('realtime: the disk cycles keep up', Math.max(...behind) <= 3 && Math.max(...ages) < 2500,
        `the file was at most ${Math.max(...behind)} lines behind and its newest write at most ${Math.max(...ages)} ms old over ${samples.length - 1} looks (a disk cycle took ${Math.min(...cycles)} to ${Math.max(...cycles)} ms); the browser copy at most ${Math.max(...browserBehind)} lines behind`);
      noteFiles(await logStatus(page));
      await page.evaluate(() => window.fcLaunch.parts.capture.stop());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('tarpit')) {
    const run = await runCapture('tarpit');
    try {
      const { status, ended, feed, timing, browser } = run;
      const cmp = compareLog(readServerLog(status.server.name), SHIFTED);
      const hosts = browser.tarpit?.connections?.().map((c) => c.host ?? c.name ?? JSON.stringify(c)) ?? [];
      check('tarpit: the capture and the log are not slowed by dead requests', ended.sent === 253 && feed.counts.samples === 126 && cmp.ok && timing.done - timing.playing < 9000,
        `page up in ${timing.up} ms, capture playing at ${timing.playing} ms and done ${timing.done - timing.playing} ms later (6.3 s of capture at 20x)${blockedTimes.capture ? `, blocked run took ${blockedTimes.capture.done - blockedTimes.capture.playing} ms` : ''}; server copy ${cmp.ok ? 'complete' : cmp.problems.join('; ')}; dead connections tried: ${[...new Set(hosts)].slice(0, 6).join(', ') || 'none'}`);
    } finally {
      await run.browser.close();
    }
  }

  if (WANT.includes('connect')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      // 1. A fresh visit: the save box, then the port list in the same click.
      const page = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open' });
      let fake = await page.evaluate(() => ({ ...window.__fake, port: undefined }));
      await sleep(300);
      const awake = await page.evaluate(() => window.fcLaunch.parts.log.status().wakeLock);
      check('connect: one click asks where to save, then opens the port', fake.pickerCalls === 1 && fake.requestCalls === 1 && /^flight-\d{4}-\d{2}-\d{2}-\d{4}\.log$/.test(fake.pickerOpts?.suggestedName ?? ''),
        `save box shown ${fake.pickerCalls} time, suggested ${fake.pickerOpts?.suggestedName}, port list ${fake.requestCalls} time; screen wake lock held: ${awake}`);
      await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 20));
      await sleep(300);
      noteFiles(await logStatus(page));
      // 2. The cable comes out.
      await page.evaluate(() => window.__fake.port.unplug());
      await page.waitFor(() => window.fcLaunch.parts.log.status().lostAt, { timeout: 10000, message: 'the lost port was not noticed' });
      await sleep(1500);
      await page.screenshot(path.join(OUT, 'connect-lost.png'));
      const lostText = await page.evaluate(() => document.getElementById('fcl-log-msg')?.textContent ?? '');
      // On the launch page the recording saves itself with no name box
      // (js/views/local-console.js), so nothing covers the launch panel.
      await page.waitFor(() => document.getElementById('fc-file-tag')?.textContent === 'SAVED', { timeout: 10000, message: 'the recording was not saved after the lost port' });
      check('connect: a lost port saves the recording with no name box', !(await page.evaluate(() => document.querySelector('dialog.fc-dialog')?.open)),
        await page.evaluate(() => document.getElementById('fc-file-text')?.textContent ?? ''));
      // 3. Plugged back in: CONNECT opens the granted port with no save box and no port list.
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open again' });
      await page.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(20, 40));
      let st = await settled(page);
      noteFiles(st);
      fake = await page.evaluate(() => ({ ...window.__fake, port: undefined }));
      const picked = await readOpfs(page, fake.pickedName);
      const pickedCmp = compareLog(picked, CAPTURE_LINES.slice(0, 40));
      const serverText = readServerLog(st.server.name);
      check('connect: a lost port is said plainly, and the reconnect keeps the same files', lostText.includes('was lost') && fake.pickerCalls === 1 && fake.requestCalls === 1 &&
        pickedCmp.ok && picked === serverText && /\n# connection closed [^\n]+\n# connected [^\n]+\n/.test(picked),
        `message: "${lostText}"; save box ${fake.pickerCalls} time, port list ${fake.requestCalls} time in all; the picked file has ${pickedCmp.data.length} lines with "# connection closed" and "# connected" between, ${picked === serverText ? 'the same as' : 'DIFFERENT from'} flight-logs/${st.server.name}`);
      // 4. A real port is open: the test capture refuses.
      const refused = await page.evaluate(() => window.fcLaunch.parts.capture.play());
      check('connect: the test capture refuses while a port is open', refused.ok === false && /port is open/.test(refused.reason), refused.reason);
      // 5. Leaving with the port open asks first.
      const dialogsBefore = page.dialogs().length;
      await page.reload({ waitUntil: 'load' }).catch(() => {});
      const asked = page.dialogs().slice(dialogsBefore).filter((d) => d.type === 'beforeunload').length;
      check('connect: the browser asks before leaving while a port is open', asked >= 1, `${asked} "leave this page?" box`);
      await page.close();

      // 6. A cancelled save box: the port still opens, and CHOOSE FILE later writes everything.
      const page2 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page2.evaluate(() => { window.__fake.pickerMode = 'cancel'; });
      await page2.click('#bc-connect');
      await page2.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open after a cancelled save box' });
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 30));
      await sleep(1200);
      await page2.screenshot(path.join(OUT, 'connect-cancelled.png'));
      st = await logStatus(page2);
      const warn = await page2.evaluate(() => ({
        disk: document.getElementById('fcl-log-disk')?.textContent,
        row: document.querySelector('.fcl-log-row--disk')?.dataset.state,
        choose: !document.getElementById('fcl-log-choose')?.hidden,
        msg: document.getElementById('fcl-log-msg')?.textContent,
      }));
      check('connect: a cancelled save box still connects and says so plainly', st.file.state === 'cancelled' && warn.row === 'warn' && warn.choose && st.server.lines === 30 && st.browser.lines === 30,
        `disk row "${warn.disk}" (${warn.row}), CHOOSE FILE shown: ${warn.choose}, server ${st.server.lines} lines, browser ${st.browser.lines} lines, message "${warn.msg}"`);
      await page2.evaluate(() => { window.__fake.pickerMode = 'opfs'; });
      await page2.click('#fcl-log-choose');
      await page2.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(30, 40));
      st = await settled(page2);
      noteFiles(st);
      const late = await readOpfs(page2, st.file.name);
      const lateCmp = compareLog(late, CAPTURE_LINES.slice(0, 40));
      check('connect: CHOOSE FILE later writes everything so far and carries on', st.file.state === 'saving' && lateCmp.ok,
        `${st.file.name}: ${lateCmp.data.length} lines${lateCmp.problems.length ? `, ${lateCmp.problems.join('; ')}` : ', every line from the start'}`);
      await page2.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page2.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page2.close();

      // 7. A save box that takes longer than the click lasts: the second click opens the port list.
      const page3 = await openPage(browser, server, '/flight-console/launch.html?track', { fake: true });
      await page3.evaluate(() => { window.__fake.pickerDelayMs = 5600; });
      await page3.click('#bc-connect');
      // No looking in the meantime: the rig's evaluate() counts as a click,
      // which would keep the first click's leave to open the port list alive.
      await sleep(7500);
      const note = await page3.evaluate(() => document.getElementById('bc-link-note').textContent);
      const calls1 = await page3.evaluate(() => window.__fake.requestCalls);
      await page3.click('#bc-connect');
      await page3.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the second click did not open the port' });
      const calls2 = await page3.evaluate(() => ({ picker: window.__fake.pickerCalls, request: window.__fake.requestCalls }));
      check('connect: when the click no longer counts, a second CONNECT opens the port list', /CONNECT again/.test(note) && calls1 === 0 && calls2.picker === 1 && calls2.request === 1,
        `after the slow save box: "${note}"; port list calls ${calls1} then ${calls2.request}; save box ${calls2.picker} time`);
      // 8. A test capture, then a real connection: the test leaves the live view.
      noteFiles(await logStatus(page3));
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
      await page3.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 5000 });
      await page3.evaluate(() => document.querySelector('dialog.fc-dialog')?.open || new Promise((r) => setTimeout(r, 300)));
      if (await page3.evaluate(() => Boolean(document.querySelector('dialog.fc-dialog')?.open))) await saveNameBox(page3);
      const played = await page3.evaluate(() => window.fcLaunch.parts.capture.play({ speed: 100, shift: 'field' }));
      const afterTest = await page3.evaluate(() => window.fcLaunch.ctx.live.stores.flight.getTotals().samples);
      await page3.click('#bc-connect');
      await page3.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open after the test' });
      const cleared = await page3.evaluate(() => window.fcLaunch.ctx.live.stores.flight.getTotals().samples);
      await page3.evaluate((lines) => { for (const l of lines) window.__fake.port.send(`${l}\r\n`); }, CAPTURE_LINES.slice(0, 10));
      await sleep(400);
      const real = await page3.evaluate(() => ({ samples: window.fcLaunch.ctx.live.stores.flight.getTotals().samples, lat: window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples[0]?.gps.lat, logs: window.fcLaunch.parts.log.status().logs }));
      check('connect: a real connection after a test capture starts with a clean live view', played.ok && afterTest === 126 && cleared === 0 && real.samples === 5 && Math.abs(real.lat - 35.1234567) < 1e-7,
        `the test put ${afterTest} samples on the live view, CONNECT cleared it to ${cleared}, then 5 real packets went in at ${real.lat}; logs ${real.logs.map((l) => `${l.kind}: ${l.server}`).join(', ')}`);
      for (const l of real.logs) made.add(l.server);
      await page3.evaluate(() => window.fcLaunch.ctx.live.link.disconnect());
    } finally {
      await browser.close();
    }
  }

  if (WANT.includes('normal')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/index.html?track', { fake: true });
      const bare = await page.evaluate(() => ({
        hub: typeof window.fcLaunch,
        panel: Boolean(document.getElementById('fc-launch-panel')),
        banner: Boolean(document.getElementById('fcl-test-banner')),
        log: Boolean(document.getElementById('fcl-log-lines')),
      }));
      await page.click('#bc-connect');
      await page.waitFor(() => document.getElementById('bc-connect').dataset.state === 'open', { timeout: 10000, message: 'the port did not open on the normal page' });
      // Ten lines a second for six seconds, like a busy board.
      for (let i = 0; i < 60; i += 1) {
        await page.evaluate((line) => window.__fake.port.send(`${line}\r\n`), CAPTURE_LINES[i]);
        await sleep(100);
      }
      await sleep(2500);
      const chunks = await page.evaluate(() => new Promise((resolve, reject) => {
        const req = indexedDB.open('dogtooth-flight-console');
        req.onsuccess = () => {
          const tx = req.result.transaction(['chunks', 'flights'], 'readonly');
          const all = tx.objectStore('chunks').getAll();
          const flights = tx.objectStore('flights').getAll();
          tx.oncomplete = () => resolve({ chunks: all.result.map((c) => c.lines.length), flights: flights.result.map((f) => f.status) });
        };
        req.onerror = () => reject(req.error);
      }));
      const fake = await page.evaluate(() => ({ picker: window.__fake.pickerCalls, request: window.__fake.requestCalls }));
      const launchRequests = page.requests().filter((r) => r.url.includes('/launch-mode/') || r.url.includes('/launch/'));
      check('normal: no launch mode on the normal page', bare.hub === 'undefined' && !bare.panel && !bare.banner && !bare.log && fake.picker === 0 && fake.request === 1 && launchRequests.filter((r) => r.url.includes('/launch-mode/')).length === 0,
        `fcLaunch ${bare.hub}, launch panel ${bare.panel}, test banner ${bare.banner}, log status ${bare.log}, save box ${fake.picker} times, port list ${fake.request} time, requests to /launch-mode/: ${launchRequests.filter((r) => r.url.includes('/launch-mode/')).length}`);
      const total = chunks.chunks.reduce((a, b) => a + b, 0);
      check('normal: the recorder still writes a chunk every 2 s', total === 60 && chunks.chunks.length >= 3 && chunks.chunks.length <= 5,
        `60 lines over 6 s went into ${chunks.chunks.length} chunks of ${chunks.chunks.join(', ')} lines (2 s chunks give 3 or 4; the launch page's 250 ms would give about 24)`);
      await page.evaluate(() => document.getElementById('bc-connect').click());
      await saveNameBox(page);
      if (fullServerLog) {
        await page.setFiles('input.fc-file-input', [path.join(LOGS, fullServerLog.name)]);
        await page.waitFor(() => location.search.includes('flight=local-'), { timeout: 20000, message: 'LOAD FILE did not open the flight on the normal page' });
        const loaded = await page.evaluate(() => document.getElementById('fc-file-text')?.textContent ?? '');
        check('normal: LOAD FILE takes a launch flight log on the normal page too', /Loaded /.test(loaded), loaded);
      }
      check('normal: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    } finally {
      await browser.close();
    }
  }
} catch (err) {
  check('the run itself', false, err.stack ?? String(err));
} finally {
  await server.stop();
  // The files this run made in flight-logs/: exactly the ones its pages
  // named. Other programs may be writing there at the same time, so
  // nothing else is touched.
  let deleted = 0;
  for (const name of made) {
    if (logsBefore.has(name) || !fs.existsSync(path.join(LOGS, name))) continue;
    try {
      fs.unlinkSync(path.join(LOGS, name));
      deleted += 1;
    } catch (err) {
      console.log(`could not delete flight-logs/${name}: ${err.message}`);
    }
  }
  const others = (fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []).filter((n) => !logsBefore.has(n));
  console.log(`flight-logs/: deleted the ${deleted} files this run made.${others.length ? ` New files from something else, left alone: ${others.join(', ')}` : ''}`);
  for (const p of profiles) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* a file still held */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length} of ${results.length} checks passed. Pictures in ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
