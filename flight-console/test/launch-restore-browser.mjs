// launch-restore-browser.mjs: two launch day checks in a real headless
// Chrome with the internet blocked, through the launch mode test rig
// (launch-mode/test/cdp.mjs) and the local server on a test port.
//
//   restore   A real connection (the stand-in port below), Chrome killed,
//             then RECOVER. The launch panel's LAST PACKET, the fix's age,
//             the OLD FIX state and the saved fix in localStorage
//             (fc-launch-last-fix) must show when the packets really came,
//             not when RECOVER put them back on screen
//             (js/launch/launch-panel.js, lastArrival() in
//             js/live/flight-feed.js). The ages keep counting up after.
//   capture   The test capture at real speed: LAST PACKET counts up between
//             packets and starts again at each one, and keeps counting once
//             the capture stops. The capture saves itself as "Test capture".
//   closed    A real connection, then a lost port, then the cable goes back
//             in (the page reconnects by itself) and DISCONNECT by hand. On
//             the launch page neither opens the SAVE THIS RECORDING box
//             (js/views/local-console.js): each recording is in SAVED
//             FLIGHTS under its date and time, a status line says so, and
//             COPY COORDINATES works at once.
//   normal    The normal page (index.html): the box still opens after a
//             lost port and after DISCONNECT, and a replug waits for
//             CONNECT.
//
// It is not a node --test file (it needs Chrome), so run it by hand from
// the website folder:
//
//   node flight-console/test/launch-restore-browser.mjs
//   node flight-console/test/launch-restore-browser.mjs --port 8122 --out C:/some/folder closed normal
//
// It prints one line per check with the real numbers, saves pictures in
// --out, deletes the files its pages made in flight-logs/, and ends with
// exit code 1 if any check failed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchChrome, sleep, ROOT } from '../../launch-mode/test/cdp.mjs';

const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  if (i < 0) return fallback;
  const value = ARGS[i + 1];
  ARGS.splice(i, 2);
  return value;
};
const PORT = Number(opt('--port', '8122'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'fc-launch-restore')));
const ALL = ['restore', 'capture', 'closed', 'normal'];
const WANT = ARGS.length ? ARGS : ALL;
if (PORT === 8000) throw new Error('Port 8000 is the real server. Use a test port.');
fs.mkdirSync(OUT, { recursive: true });

const LOGS = path.join(ROOT, 'flight-logs');
const CAPTURE_LINES = fs.readFileSync(path.join(ROOT, 'flight-console/test/radio-board-rx-capture.log'), 'utf8').split(/\r?\n/).filter(Boolean);
const LAUNCH = '/flight-console/launch.html?track';

const results = [];
const made = new Set();
const logsBefore = new Set(fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []);
const profiles = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// The stand-in for navigator.serial and the save box, the same one
// launch-log-browser.mjs uses (its comment there says more). The page's
// serial-link.js reads its stream as it reads a real port.
//   __fake.unplug()   the cable comes out: the stream fails, the port
//                     leaves getPorts(), and "disconnect" fires
//   __fake.replug()   plugged back in: a NEW port object, as in Chrome, and
//                     "connect" fires
const FAKE = `(() => {
  const enc = new TextEncoder();
  const fake = window.__fake = { requestCalls: 0, pickerCalls: 0, granted: false, plugged: true, opens: 0, openTries: 0, made: 0 };
  const heard = { connect: new Set(), disconnect: new Set() };
  const tell = (type, port) => {
    for (const fn of [...heard[type]]) {
      try { fn({ type, target: port, port }); } catch (err) { console.error(err); }
    }
  };
  function makePort() {
    fake.made += 1;
    const port = {
      n: fake.made,
      gone: false,
      readable: null,
      controller: null,
      async open() {
        fake.openTries += 1;
        if (port.gone || !fake.plugged) throw new DOMException('Failed to open serial port.', 'NetworkError');
        fake.opens += 1;
        port.readable = new ReadableStream({ start(c) { port.controller = c; } });
      },
      async setSignals() {},
      async close() { port.readable = null; },
      getInfo() { return { usbVendorId: 0x239a, usbProductId: 0x800b }; },
      send(text) { port.controller.enqueue(enc.encode(text)); },
      unplug() { fake.unplug(); },
    };
    return port;
  }
  fake.port = makePort();
  Object.defineProperty(fake, 'unplug', { enumerable: false, value: () => {
    const port = fake.port;
    fake.plugged = false;
    port.gone = true;
    const c = port.controller;
    port.readable = null;
    port.controller = null;
    if (c) c.error(new DOMException('The device has been lost.', 'NetworkError'));
    tell('disconnect', port);
  } });
  Object.defineProperty(fake, 'replug', { enumerable: false, value: () => {
    fake.port = makePort();
    fake.plugged = true;
    tell('connect', fake.port);
  } });
  Object.defineProperty(navigator, 'serial', { value: {
    async requestPort() {
      fake.requestCalls += 1;
      if (!navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      fake.granted = true;
      return fake.port;
    },
    async getPorts() { return fake.granted && fake.plugged ? [fake.port] : []; },
    addEventListener(type, fn) { if (heard[type]) heard[type].add(fn); },
    removeEventListener(type, fn) { if (heard[type]) heard[type].delete(fn); },
  }, configurable: true });
  window.showSaveFilePicker = async (opts) => {
    fake.pickerCalls += 1;
    const dir = await navigator.storage.getDirectory();
    fake.pickedName = 'picked-' + Math.random().toString(36).slice(2, 8) + '-' + opts.suggestedName;
    return dir.getFileHandle(fake.pickedName, { create: true });
  };
})();`;

async function openPage(browser, server, url, { fake = true } = {}) {
  const page = await browser.newPage();
  if (fake) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE });
  await page.goto(server.url(url));
  await page.waitFor(() => window.fcStarted === true, { timeout: 40000, message: 'the console did not start' });
  if (url.includes('launch.html')) {
    // The parts start one after the other (panel, log, capture), so the
    // last one is waited for too. A check that plays the capture at once
    // would otherwise find it missing on a slow start.
    await page.waitFor(() => window.fcLaunch?.parts?.panel && window.fcLaunch?.parts?.log && window.fcLaunch?.parts?.capture, { timeout: 40000, message: 'launch mode did not start' });
  }
  return page;
}

const noteFiles = async (page) => {
  const logs = await page.evaluate(() => window.fcLaunch?.parts?.log?.status?.().logs ?? []);
  for (const l of logs) if (l.server) made.add(l.server);
};
const panel = (page) => page.evaluate(() => window.fcLaunch.parts.panel.status());
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const dialogOpen = (page) => page.evaluate(() => [...document.querySelectorAll('dialog')].some((d) => d.open));
// "1:05 AGO" as seconds.
const agoS = (words) => {
  const m = /^(?:(\d+):)?(\d+):(\d\d) AGO/.exec(words ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};
// A time of day in the page's words, like the panel's "AT 14:02:11".
const clockOf = (page, ms) => page.evaluate((t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}, ms);

// Sends receiver lines through the stand-in port two at a time, like the
// receiver's status line and packet each second (faster: every pairMs).
// Returns the page's clock when each PKT line went in.
async function sendLines(page, lines, pairMs) {
  const pktMs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const pair = lines.slice(i, i + 2);
    const at = await page.evaluate((part) => {
      const t = Date.now();
      for (const l of part) window.__fake.port.send(`${l}\r\n`);
      return t;
    }, pair);
    if (pair.some((l) => l.startsWith('PKT '))) pktMs.push(at);
    await sleep(pairMs);
  }
  return pktMs;
}

// The page's saved LOCAL flights, newest first.
const savedFlights = (page) => page.evaluate(async () => {
  const db = window.fcLaunch?.ctx?.localConsole?.test?.db;
  const { defaultName } = await import('/flight-console/js/local/local-flights.js');
  const all = (await db.listFlights()).filter((r) => r.status === 'saved').sort((a, b) => b.createdAt - a.createdAt);
  return all.map((r) => ({ id: r.id, title: r.title, test: Boolean(r.test), lineCount: r.lineCount, defaultName: defaultName(r.createdAt) }));
});

// Whether a real click in the middle of COPY COORDINATES lands on it (no
// box over it), and what it then copies.
//
// The button can move once while this runs: about 5 s after the last
// packet the fix turns old, the panel gains a line that says so, and the
// button goes down by that line. A click sent in that instant lands where
// the button was. So when nothing was copied and the button is not where
// it was, the click is made again (moves says how often that happened). A
// button that stayed put and copied nothing still fails the check.
async function copyNow(page, browser, server) {
  await browser.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
  const look = () => page.evaluate(() => {
    const b = document.getElementById('fcl-copy');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: Math.round(r.top), onTop: b === hit || b.contains(hit), disabled: b.disabled, hit: hit ? `${hit.tagName.toLowerCase()}#${hit.id}.${hit.className}` : null };
  });
  const began = Date.now();
  let onTop;
  let copied;
  let moves = 0;
  for (;;) {
    onTop = await look();
    await page.click('#fcl-copy');
    await sleep(250);
    copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== 'nothing yet' || moves >= 2 || (await look()).top === onTop.top) break;
    moves += 1;
  }
  return { ...onTop, copied, moves, words: await text(page, '#fcl-copied'), ms: Date.now() - began };
}

const server = await startServer({ port: PORT });

try {
  // ------------------------------------------------------------------
  // restore
  // ------------------------------------------------------------------
  if (WANT.includes('restore')) {
    const profile = path.join(OUT, `profile-r-${process.pid}`);
    profiles.push(profile);
    let browser = await launchChrome({ network: 'blocked', userDataDir: profile });
    try {
      const page = await openPage(browser, server, LAUNCH);
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the stand-in port did not open' });
      await noteFiles(page);
      const pktMs = await sendLines(page, CAPTURE_LINES.slice(0, 40), 500);
      const lastPktMs = pktMs.at(-1);
      // localStorage needs a few seconds to reach the disk before a crash.
      await sleep(6500);
      const before = await page.evaluate(() => ({
        fix: window.fcLaunch.parts.panel.status().fix,
        saved: JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'),
        packet: document.getElementById('fcl-packet').textContent,
        browserLines: window.fcLaunch.parts.log.status().browser.lines,
      }));
      check('restore: live, LAST PACKET and the saved fix are the real arrival times', Math.abs(before.fix.packetWallMs - lastPktMs) < 200 && Math.abs(before.saved.packetMs - lastPktMs) < 200 && Math.abs(before.saved.fixMs - lastPktMs) < 200 && before.browserLines === 40,
        `last PKT sent at ${lastPktMs}; panel ${before.fix.packetWallMs}, saved packetMs ${before.saved.packetMs}, fixMs ${before.saved.fixMs}; "${before.packet}"; ${before.browserLines} lines in the browser copy`);
      await browser.kill();

      browser = await launchChrome({ network: 'blocked', userDataDir: profile });
      const page2 = await openPage(browser, server, LAUNCH);
      await page2.waitFor(() => !document.getElementById('fc-recover').hidden, { timeout: 30000, message: 'UNSAVED RECORDING FOUND never showed' });
      // A few more seconds, so the moment of RECOVER is far from the real times.
      await sleep(4000);
      const reloadView = await panel(page2);
      // From here, every state the panel shows is noted, to catch a flash of
      // CURRENT FIX while the recording goes back on screen.
      await page2.evaluate(() => {
        window.__whys = [];
        const look = () => {
          const w = document.getElementById('fcl-fix-state').textContent;
          if (window.__whys.at(-1) !== w) window.__whys.push(w);
        };
        new MutationObserver(look).observe(document.getElementById('fcl-fix-state'), { childList: true, characterData: true, subtree: true });
        look();
      });
      await page2.click('#fc-recover-actions button');
      await page2.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the RECOVER name box did not open' });
      await page2.click('dialog.fc-dialog button[type="submit"]');
      const restoredAt = await page2.waitFor(() => (window.fcLaunch.parts.log.status().restored ? Date.now() : false), { timeout: 15000, interval: 20, message: 'the recording did not go back on the live view' });
      await sleep(300);
      const after = await page2.evaluate(() => ({
        now: Date.now(),
        fix: window.fcLaunch.parts.panel.status().fix,
        saved: JSON.parse(localStorage.getItem('fc-launch-last-fix') ?? 'null'),
        packet: document.getElementById('fcl-packet').textContent,
        state: document.getElementById('fcl-fix-state').textContent,
        detail: document.getElementById('fcl-fix-detail').textContent,
        feed: window.fcLaunch.ctx.live.flightFeed.lastArrival('1'),
        samples: window.fcLaunch.ctx.live.stores.flight.getRocket('1')?.samples.length ?? 0,
      }));
      const realAge = (after.now - lastPktMs) / 1000;
      const clock = await clockOf(page2, lastPktMs);
      const restoreClock = await clockOf(page2, restoredAt);
      // The test notes its clock just before the line goes into the port,
      // and the page stamps the line when it reads it, a few ms later. So
      // the two are close, not equal. RECOVER came seconds after both.
      check('restore: the 20 packets are back on the live view', after.samples === 20 && Math.abs(after.feed - lastPktMs) <= 100,
        `rocket 1 has ${after.samples} samples, lastArrival('1') is ${after.feed}, ${after.feed - lastPktMs} ms after the last PKT was sent (${lastPktMs}); RECOVER put it back ${restoredAt - lastPktMs} ms after that`);
      check('restore: LAST PACKET says when the packet really came, not when RECOVER put it back',
        Math.abs(agoS(after.packet) - realAge) <= 2 && after.packet.endsWith(`AT ${clock}`) && Math.abs(after.fix.packetWallMs - lastPktMs) < 2000 && Math.abs(after.fix.packetAgeS - realAge) < 2,
        `"${after.packet}", real age ${realAge.toFixed(1)} s, the packet came at ${clock} and RECOVER put it back at ${restoreClock}; status packetWallMs off by ${after.fix.packetWallMs - lastPktMs} ms, packetAgeS ${after.fix.packetAgeS.toFixed(2)} s`);
      check('restore: the fix\'s own age and the OLD FIX state use the real time',
        Math.abs(after.fix.ageS - realAge) < 2 && Math.abs(after.fix.wallMs - lastPktMs) < 2000 && Math.abs(agoS(after.state.replace(/^OLD FIX, FROM /, '')) - realAge) <= 2 &&
        after.fix.why === 'no-packets' && after.state.startsWith('OLD FIX, FROM ') && after.detail === 'Packets from the rocket have stopped.',
        `"${after.state}" "${after.detail}", ageS ${after.fix.ageS.toFixed(2)} s, wallMs off by ${after.fix.wallMs - lastPktMs} ms, why ${after.fix.why}`);
      check('restore: the saved copy in localStorage keeps the real times',
        Math.abs(after.saved.fixMs - lastPktMs) < 2000 && Math.abs(after.saved.packetMs - lastPktMs) < 2000,
        `fixMs off by ${after.saved.fixMs - lastPktMs} ms, packetMs off by ${after.saved.packetMs - lastPktMs} ms (the moment of RECOVER is ${restoredAt - lastPktMs} ms after the packet)`);
      const whys = await page2.evaluate(() => window.__whys);
      check('restore: no flash of CURRENT FIX while the recording goes back', !whys.some((w) => w.startsWith('CURRENT')),
        `the panel's state line went ${whys.map((w) => `"${w}"`).join(' then ')} (before RECOVER: ${reloadView.fix?.source}, ${reloadView.fix?.why})`);
      await page2.screenshot(path.join(OUT, 'restore-after-recover.png'));
      // It keeps counting up.
      await sleep(4000);
      const later = await page2.evaluate(() => ({ now: Date.now(), fix: window.fcLaunch.parts.panel.status().fix, packet: document.getElementById('fcl-packet').textContent }));
      const laterAge = (later.now - lastPktMs) / 1000;
      check('restore: the ages keep counting up', later.fix.packetAgeS - after.fix.packetAgeS > 3.5 && Math.abs(later.fix.packetAgeS - laterAge) < 2 && Math.abs(agoS(later.packet) - laterAge) <= 2 && later.packet.endsWith(`AT ${clock}`),
        `"${after.packet}" then 4 s later "${later.packet}" (real age ${laterAge.toFixed(1)} s)`);
      await page2.screenshot(path.join(OUT, 'restore-4s-later.png'));
      check('restore: no exceptions', page2.exceptions().length === 0, `${page2.exceptions().length} exceptions`);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // capture
  // ------------------------------------------------------------------
  if (WANT.includes('capture')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, LAUNCH, { fake: false });
      const played = page.evaluate(() => { window.fcLaunch.parts.capture.play({ speed: 1, shift: 'field' }); return true; });
      await played;
      await page.waitFor(() => window.fcLaunch.parts.panel.status().fix, { timeout: 30000, message: 'no fix from the capture' });
      await noteFiles(page);
      // About 5 s of looks, 10 a second.
      const looks = await page.evaluate(async () => {
        const out = [];
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const f = window.fcLaunch.parts.panel.status().fix;
          out.push({ at: Date.now(), age: f.packetAgeS, wall: f.packetWallMs, words: document.getElementById('fcl-packet').textContent });
          await new Promise((r) => setTimeout(r, 100));
        }
        return out;
      });
      const packets = new Set(looks.map((l) => l.wall)).size;
      let rises = 0;
      let drops = 0;
      let bad = 0;
      for (let i = 1; i < looks.length; i++) {
        const a = looks[i - 1];
        const b = looks[i];
        if (b.wall === a.wall) {
          if (b.age > a.age) rises += 1;
          if (b.age < a.age - 0.001) bad += 1;
        } else if (b.age < a.age) drops += 1;
        if (Math.abs((b.at - b.wall) / 1000 - b.age) > 0.3) bad += 1;
      }
      check('capture: LAST PACKET counts up between packets and starts again at each one', packets >= 4 && rises > looks.length * 0.6 && drops >= packets - 2 && bad === 0,
        `${looks.length} looks over 5 s: ${packets} packets, the age rose between ${rises} pairs of looks and fell back at ${drops} new packets, ${bad} looks out of step; ages ${looks.filter((_, i) => i % 5 === 0).map((l) => l.age.toFixed(1)).join(', ')}`);
      await page.screenshot(path.join(OUT, 'capture-playing.png'));
      await page.evaluate(() => window.fcLaunch.parts.capture.stop());
      const stopped = await panel(page);
      await sleep(3000);
      const later = await panel(page);
      check('capture: the age keeps counting once the capture stops', later.fix.packetAgeS - stopped.fix.packetAgeS > 2.5 && later.fix.packetWallMs === stopped.fix.packetWallMs && later.fix.test === true,
        `${stopped.fix.packetAgeS.toFixed(1)} s, then ${later.fix.packetAgeS.toFixed(1)} s, the same packet, marked as a test: ${later.fix.test}`);
      await page.waitFor(() => !window.fcLaunch.ctx.localConsole.recording().active, { timeout: 10000 });
      await sleep(500);
      const saved = await savedFlights(page);
      check('capture: the test capture still saves itself as "Test capture"', saved[0]?.test && saved[0].title === `Test capture, ${saved[0].defaultName}` && !(await dialogOpen(page)),
        `"${saved[0]?.title}", name box open: ${await dialogOpen(page)}`);
      await noteFiles(page);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // closed
  // ------------------------------------------------------------------
  if (WANT.includes('closed')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, LAUNCH);
      await page.click('#bc-connect');
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open' });
      await noteFiles(page);
      await sendLines(page, CAPTURE_LINES.slice(0, 20), 150);
      await page.waitFor(() => window.fcLaunch.parts.log.status().browser.lines === 20, { timeout: 10000, message: 'the browser copy did not reach 20 lines' });
      const firstId = await page.evaluate(() => window.fcLaunch.ctx.localConsole.recording().id);

      // The cable comes out.
      await page.evaluate(() => window.__fake.port.unplug());
      await page.waitFor(() => window.fcLaunch.parts.log.status().lostAt, { timeout: 10000, message: 'the lost port was not noticed' });
      await page.waitFor(() => document.getElementById('fc-file-tag')?.textContent === 'SAVED' && !document.getElementById('fc-file-note').hidden, { timeout: 10000, message: 'no saved note after the lost port' });
      // Give a name box every chance to show up.
      await sleep(1500);
      const lostOpen = await dialogOpen(page);
      const lostNote = await text(page, '#fc-file-text');
      const lostCopy = await copyNow(page, browser, server);
      let saved = await savedFlights(page);
      const first = saved.find((r) => r.id === firstId);
      check('closed: a lost port opens no name box', !lostOpen, `name box open: ${lostOpen}`);
      check('closed: the recording is in SAVED FLIGHTS under its date and time', first && !first.test && first.title === first.defaultName && first.lineCount === 20,
        first ? `"${first.title}", ${first.lineCount} lines` : 'not saved');
      check('closed: a status line says where it went', lostNote === `The recording stopped after ${lostNote.match(/after (.+?)\./)?.[1]}. "${first?.title}" is in SAVED FLIGHTS, kept in this browser.` && !/[—;]/.test(lostNote),
        `SAVED ${lostNote}`);
      check('closed: COPY COORDINATES works straight away', lostCopy.onTop && !lostCopy.disabled && /^-?\d+\.\d{6}, -?\d+\.\d{6}$/.test(lostCopy.copied) && lostCopy.words === `COPIED ${lostCopy.copied}`,
        `the click landed on ${lostCopy.onTop ? 'the button' : lostCopy.hit}, copied "${lostCopy.copied}", the panel said "${lostCopy.words}"${lostCopy.moves ? ` (clicked again ${lostCopy.moves} time, because the button moved down when the fix turned old)` : ''}`);
      await page.screenshot(path.join(OUT, 'closed-lost-port.png'));

      // Plugged back in: the page reconnects by itself (js/launch/
      // flight-log.js), and the next recording starts with nothing clicked.
      await page.evaluate(() => window.__fake.replug());
      await page.waitFor(() => window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'the port did not open again by itself' });
      await sendLines(page, CAPTURE_LINES.slice(20, 40), 150);
      await page.waitFor(() => window.fcLaunch.parts.log.status().browser.lines === 20, { timeout: 10000, message: 'the second recording did not reach 20 lines' });
      const rec = await page.evaluate(() => window.fcLaunch.ctx.localConsole.recording());
      check('closed: the reconnect starts the next recording', rec.active && rec.id !== firstId && rec.lineCount === 20,
        `recording ${rec.active ? 'on' : 'off'}, ${rec.id === firstId ? 'the SAME id' : 'a new id'}, ${rec.lineCount} lines`);

      // DISCONNECT by hand.
      await page.evaluate(() => { document.getElementById('fc-file-note').hidden = true; });
      await page.click('#bc-connect');
      await page.waitFor(() => !window.fcLaunch.ctx.live.link.open, { timeout: 10000, message: 'DISCONNECT did not close the port' });
      await page.waitFor(() => document.getElementById('fc-file-tag')?.textContent === 'SAVED' && !document.getElementById('fc-file-note').hidden, { timeout: 10000, message: 'no saved note after DISCONNECT' });
      await sleep(1500);
      const handOpen = await dialogOpen(page);
      const handNote = await text(page, '#fc-file-text');
      const handCopy = await copyNow(page, browser, server);
      const handWant = (await panel(page)).copyText;
      saved = await savedFlights(page);
      const second = saved.find((r) => r.id === rec.id);
      check('closed: DISCONNECT opens no name box either', !handOpen, `name box open: ${handOpen}`);
      check('closed: that recording is in SAVED FLIGHTS too, with a note', second && second.title === second.defaultName && second.lineCount === 20 && handNote.startsWith('The recording stopped after ') && handNote.endsWith(`"${second.title}" is in SAVED FLIGHTS, kept in this browser.`),
        `"${second?.title}", ${second?.lineCount} lines; SAVED ${handNote}`);
      check('closed: COPY COORDINATES works straight away after DISCONNECT', handCopy.onTop && handCopy.copied === handWant && handCopy.words === `COPIED ${handCopy.copied}`,
        `the click landed on ${handCopy.onTop ? 'the button' : handCopy.hit}, copied "${handCopy.copied}", the last fix is "${handWant}", the panel said "${handCopy.words}"${handCopy.moves ? ` (clicked again ${handCopy.moves} time, because the button moved down when the fix turned old)` : ''}`);
      await page.screenshot(path.join(OUT, 'closed-disconnect.png'));
      // Both in the SAVED FLIGHTS menu.
      await page.click('#fc-saved-button');
      await sleep(400);
      const listed = await page.evaluate(() => [...document.querySelectorAll('.fc-dd-local-item .fc-dd-name')].map((e) => e.textContent.trim()));
      check('closed: SAVED FLIGHTS lists both', [first?.title, second?.title].every((t) => listed.some((l) => l.startsWith(t))), listed.join(' | '));
      await page.screenshot(path.join(OUT, 'closed-saved-flights.png'));
      await noteFiles(page);
      check('closed: no exceptions', page.exceptions().length === 0, `${page.exceptions().length} exceptions`);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------
  // normal
  // ------------------------------------------------------------------
  if (WANT.includes('normal')) {
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await openPage(browser, server, '/flight-console/index.html?track');
      await page.click('#bc-connect');
      await page.waitFor(() => document.getElementById('bc-connect').dataset.state === 'open', { timeout: 10000, message: 'the port did not open on the normal page' });
      await sendLines(page, CAPTURE_LINES.slice(0, 10), 150);
      await sleep(500);
      await page.evaluate(() => window.__fake.port.unplug());
      await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'no name box after a lost port on the normal page' });
      const lost = await page.evaluate(() => ({ title: document.getElementById('fc-name-title').textContent, text: document.querySelector('.fc-dialog-text').textContent, name: document.getElementById('fc-name-input').value }));
      await page.screenshot(path.join(OUT, 'normal-lost-port-box.png'));
      check('normal: a lost port still opens SAVE THIS RECORDING', lost.title === 'SAVE THIS RECORDING' && /^The board was unplugged/.test(lost.text),
        `"${lost.title}": ${lost.text} Name "${lost.name}"`);
      await page.click('dialog.fc-dialog button[type="submit"]');
      await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
      // Plugged back in. The normal page waits for CONNECT: only the launch
      // page opens a lost port again by itself.
      const triesBefore = await page.evaluate(() => window.__fake.openTries);
      await page.evaluate(() => window.__fake.replug());
      await sleep(3500);
      const waited = await page.evaluate(() => ({ state: document.getElementById('bc-connect').dataset.state, tries: window.__fake.openTries, note: document.getElementById('bc-link-note').textContent }));
      check('normal: a replug does not reconnect by itself', waited.state === 'lost' && waited.tries === triesBefore && waited.note === 'The board was unplugged or stopped answering. Plug it back in and press CONNECT.',
        `3.5 s after the replug: link ${waited.state}, ${waited.tries - triesBefore} opens tried, note "${waited.note}"`);
      await page.click('#bc-connect');
      await page.waitFor(() => document.getElementById('bc-connect').dataset.state === 'open', { timeout: 10000, message: 'the port did not open again' });
      await sendLines(page, CAPTURE_LINES.slice(10, 20), 150);
      await sleep(500);
      await page.click('#bc-connect');
      await page.waitFor(() => document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'no name box after DISCONNECT on the normal page' });
      const hand = await page.evaluate(() => ({ title: document.getElementById('fc-name-title').textContent, text: document.querySelector('.fc-dialog-text').textContent }));
      check('normal: DISCONNECT still opens SAVE THIS RECORDING', hand.title === 'SAVE THIS RECORDING' && /^The board disconnected/.test(hand.text), `"${hand.title}": ${hand.text}`);
      await page.click('dialog.fc-dialog button[type="submit"]');
      await page.waitFor(() => !document.querySelector('dialog.fc-dialog')?.open, { timeout: 10000, message: 'the name box did not close' });
      check('normal: no launch mode and no exceptions', await page.evaluate(() => typeof window.fcLaunch === 'undefined') && page.exceptions().length === 0,
        `fcLaunch ${await page.evaluate(() => typeof window.fcLaunch)}, ${page.exceptions().length} exceptions`);
    } finally {
      await browser.close();
    }
  }
} catch (err) {
  check('the run itself', false, err.stack ?? String(err));
} finally {
  await server.stop();
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
  console.log(`flight-logs/: deleted the ${deleted} files this run made.`);
  for (const p of profiles) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* a file still held */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length} of ${results.length} checks passed. Pictures in ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
