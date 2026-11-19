// capture.js: the test capture. It plays a saved receiver capture (by
// default test/radio-board-rx-capture.log) into the console as if the
// receiver were sending it, so the whole page can be checked before a
// flight with nothing plugged in.
//
// THE SAME PATH AS THE REAL PORT. Each line goes to ctx.live.handlers, the
// very handlers the serial link calls: onOpen() first, then onLine(line, t)
// with t the computer's clock when the line is handed over, then onClose().
// The link's states go to onLink() the way serial-link.js reports them. So
// the source detector, the flight feed, the recorder, the flight log and
// every view behave exactly as with the real port. The replay path (the
// player and a saved flight's store) is never used.
//
// THE PACE comes from the lines' own clocks (capture-plan.js): at speed 1
// a status line and a packet go out each second, as the receiver sent them.
// The panel offers 5 and 20 times faster too.
//
// THE SHIFT. The capture was recorded near 35.12, -117.12, far outside the
// saved map of the launch field. With "move to the field" on, every lat=
// and lon= in its PKT lines is moved by one fixed offset so the first fix
// lands on the field's center. The log's header lines say by how much.
//
// IT IS PLAINLY A TEST. While it plays, a status line under the bar says it
// is a test capture and not live data, CONNECT reads DISCONNECT (which stops
// it), and its logs are named test-capture-... (flight-log.js). The browser
// copy is saved by itself as "Test capture, <date and time>". It refuses to
// start while a real port is open, or once a real connection has put data
// on the live view, so a test never mixes with the flight.
//
// FOR AUTOMATED RUNS the address can start it once the console is up:
//   launch.html?track&capture=1             the default file
//   launch.html?track&capture=<path>        another file on this server,
//                                           relative to the page
//   &speed=<n>                              1 is real time (the default)
//   &shift=field | none                     field is the default
//
// createCapturePlayer({ hub, ctx }) -> hub.parts.capture:
//   play({ url, speed, shift })  resolves when the capture ends, with
//                                { ok, reason, sent, total }. ok is false
//                                when it was stopped or refused.
//   stop()                       stops it (as DISCONNECT does)
//   status()                     { playing, state, sent, total, speed,
//                                  shift, file, durationS, last }
//                                state is 'idle', 'loading' or 'playing'.
//                                shift is 'field' when the positions were
//                                moved, else 'none'. last is the last
//                                capture's { sent, total, reason }.
//
// Used by: js/launch/launch-mode.js (startLaunchMode). Launch page only.

import { h, setText, createScheduler } from '../views/dom.js?v=2';
import { planCapture, cleanSpeed, SPEEDS } from './capture-plan.js';

// The capture the panel plays: 253 lines the receiver printed on
// 2026-11-17 while a Dogtooth board sat on a desk.
export const DEFAULT_CAPTURE = new URL('../../test/radio-board-rx-capture.log', import.meta.url).href;
// How long (ms) the capture file gets to load from the local server.
const FETCH_TIMEOUT_MS = 8000;
// How long (ms) an automated start waits for the console to be on screen.
const WAIT_FOR_CONSOLE_MS = 20000;
// What the link says while a capture plays (the serial link's LINK_TEXT
// says the same things about the real port).
const LINK_WORDS = {
  opening: 'Starting the test capture',
  open: 'Playing a test capture, not live data',
  closing: 'Stopping the test capture',
  closed: 'Test capture ended',
};
const LINK_BUSY = new Set(['picking', 'opening', 'open', 'closing']);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const speedWords = (speed) => (speed === 1 ? 'real speed' : `${speed} times real speed`);

export function createCapturePlayer({ hub, ctx }) {
  const live = ctx.live;
  let run = null;     // the capture loading or playing now
  let last = null;    // { sent, total, reason, file, speed } of the last one
  let message = null; // { text, kind } a sentence under the controls

  // Calls one of the console's handlers. Like the serial link, an error in
  // one never stops the capture.
  function hand(name, ...args) {
    try {
      live.handlers?.[name]?.(...args);
    } catch (err) {
      console.error(`Launch mode: the test capture's ${name} failed`, err);
    }
  }

  // Why a capture can't start now, or null when it can.
  function refusal() {
    if (run) return 'A test capture is already playing.';
    if (LINK_BUSY.has(live.link?.link)) return 'A port is open, so the test capture can\'t play. Test captures only play while nothing is connected.';
    const realData = hub.parts.log?.liveData?.() === 'real' && (live.stores?.flight?.getTotals?.().samples ?? 0) > 0;
    if (realData) return 'The live view has data from a real connection, and a test capture would mix with it. Reload the page to test again.';
    return null;
  }

  // The capture's address: this server only.
  function resolve(url) {
    const u = new URL(url || DEFAULT_CAPTURE, globalThis.location?.href ?? DEFAULT_CAPTURE);
    if (globalThis.location && u.origin !== location.origin) return null;
    return u;
  }

  async function load(u) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(u.href, { cache: 'no-store', signal: abort.signal });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function play({ url = DEFAULT_CAPTURE, speed = 1, shift = 'field' } = {}) {
    const why = refusal();
    if (why) {
      say(why, 'warn');
      return Promise.resolve({ ok: false, reason: why, sent: 0, total: 0 });
    }
    const u = resolve(url);
    if (!u) {
      const text = 'The capture has to come from this laptop\'s server, so it was not played.';
      say(text, 'warn');
      return Promise.resolve({ ok: false, reason: text, sent: 0, total: 0 });
    }
    const pace = cleanSpeed(speed);
    const file = decodeURIComponent(u.pathname.replace(/^\/(flight-console\/)?/, ''));
    const mine = { state: 'loading', file, speed: pace, sent: 0, total: 0 };
    run = mine;
    say('', 'info');
    draw();
    return new Promise((done) => {
      mine.done = done;
      start(mine, u, shift === 'none' ? null : hub.settings?.field?.center ?? null, shift !== 'none');
    });
  }

  async function start(mine, u, target, wantShift) {
    let text;
    try {
      text = await load(u);
    } catch (err) {
      run = null;
      const reason = `The capture ${mine.file} did not load (${err?.name === 'AbortError' ? 'no answer' : err?.message ?? err}).`;
      say(reason, 'warn');
      mine.done({ ok: false, reason, sent: 0, total: 0 });
      return;
    }
    if (run !== mine) {
      mine.done({ ok: false, reason: 'stopped', sent: 0, total: 0 });
      return;
    }
    // A port may have opened while the file loaded.
    run = null;
    const why = refusal();
    if (why) {
      say(why, 'warn');
      mine.done({ ok: false, reason: why, sent: 0, total: 0 });
      return;
    }
    run = mine;
    const plan = planCapture(text, { name: mine.file, speed: mine.speed, target });
    if (!plan.lines.length) {
      run = null;
      const reason = `${mine.file} has no lines to play.`;
      say(reason, 'warn');
      mine.done({ ok: false, reason, sent: 0, total: 0 });
      return;
    }
    Object.assign(mine, { state: 'playing', plan, total: plan.lines.length, shift: plan.shift ? 'field' : 'none', shiftBy: plan.shift });
    if (wantShift && !plan.shift) {
      say(target ? `The positions were not moved, because ${plan.shiftNote}.` : 'The positions were not moved, because the field\'s center did not load.', 'warn');
    }

    // Test data from an earlier capture leaves the live view first.
    const log = hub.parts.log;
    if (log?.liveData?.() === 'test') log.clearTestData();
    log?.expectTest?.({ notes: plan.notes });
    hand('onNote', '', 'info');
    hand('onLink', 'opening', LINK_WORDS.opening);
    hand('onOpen');
    hand('onLink', 'open', LINK_WORDS.open);
    showBanner(mine);
    mine.startedPerf = performance.now();
    step(mine);
  }

  // Hands over every line whose time has come, then waits for the next.
  // A tab the browser slows down catches up in order.
  function step(mine) {
    if (run !== mine || mine.state !== 'playing') return;
    const elapsed = (performance.now() - mine.startedPerf) / 1000;
    const { lines, times } = mine.plan;
    while (mine.sent < mine.total && times[mine.sent] <= elapsed + 0.001) {
      hand('onLine', lines[mine.sent], Date.now());
      mine.sent += 1;
    }
    draw();
    if (mine.sent >= mine.total) {
      finish(mine, 'ended');
      return;
    }
    mine.timer = setTimeout(() => step(mine), Math.max(0, (times[mine.sent] - elapsed) * 1000));
  }

  function finish(mine, reason) {
    if (run !== mine) return;
    clearTimeout(mine.timer);
    run = null;
    if (mine.state === 'playing') {
      if (reason === 'stopped') hand('onLink', 'closing', LINK_WORDS.closing);
      hand('onClose', { lost: false });
      hand('onLink', 'closed', LINK_WORDS.closed);
    }
    last = { sent: mine.sent, total: mine.total, reason, file: mine.file, speed: mine.speed };
    hideBanner();
    if (reason === 'ended') ctx.announce?.(`The test capture ended. It played all ${fmt(mine.total)} lines.`);
    draw();
    mine.done?.({ ok: reason === 'ended', reason, sent: mine.sent, total: mine.total });
  }

  function stop() {
    if (run) finish(run, 'stopped');
    return Promise.resolve();
  }

  function status() {
    const r = run;
    return {
      playing: r?.state === 'playing',
      state: r?.state ?? 'idle',
      sent: r?.sent ?? 0,
      total: r?.total ?? 0,
      speed: r?.speed ?? null,
      shift: r?.shift ?? null,
      shiftBy: r?.shiftBy ?? null,
      file: r?.file ?? null,
      durationS: r?.plan?.durationS ?? null,
      last,
    };
  }

  // ------------------------------------------------------------------
  // The status line under the bar while a capture plays
  // ------------------------------------------------------------------
  const bannerText = h('span', { id: 'fcl-test-text' });
  const banner = h('div', { id: 'fcl-test-banner', class: 'fc-status-line fc-status-line--warn fcl-test-banner', role: 'status', hidden: true },
    h('p', { class: 'fc-status-text' }, h('span', { class: 'fc-status-tag' }, 'TEST CAPTURE'), ' ', bannerText),
    h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm fc-status-close', onclick: () => { stop(); } }, 'STOP'));
  ctx.root?.querySelector('.fc-status')?.prepend(banner);

  function showBanner(mine) {
    setText(bannerText, `Playing ${mine.file} at ${speedWords(mine.speed)}${mine.shift === 'field' ? ', moved to the launch field' : ''}. This is not live data.`);
    banner.hidden = false;
  }
  function hideBanner() { banner.hidden = true; }

  // ------------------------------------------------------------------
  // The controls in the launch panel
  // ------------------------------------------------------------------
  const slot = hub.parts.panel?.slots?.capture ?? null;
  const els = {};
  if (slot) {
    els.speed = h('select', { id: 'fcl-cap-speed', class: 'fcl-input fcl-cap-select' },
      SPEEDS.map((s) => h('option', { value: String(s) }, s === 1 ? '1X, REAL TIME' : `${s}X`)));
    els.shift = h('input', { id: 'fcl-cap-shift', type: 'checkbox', checked: true });
    els.play = h('button', { id: 'fcl-cap-play', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: onPlay }, 'PLAY TEST CAPTURE');
    els.stop = h('button', { id: 'fcl-cap-stop', type: 'button', class: 'fc-bkt fc-bkt--sm', hidden: true, onclick: () => { stop(); } }, 'STOP');
    els.state = h('p', { id: 'fcl-cap-state', class: 'fcl-cap-state', role: 'status' });
    els.msg = h('p', { id: 'fcl-cap-msg', class: 'fcl-msg fcl-cap-msg', hidden: true });
    els.root = h('div', { class: 'fcl-cap' },
      h('p', { class: 'fcl-msg fcl-cap-about' }, 'Plays a saved receiver capture through the same path as the real port, to check the page before the flight.'),
      h('div', { class: 'fcl-cap-form' },
        h('label', { class: 'fcl-field fcl-cap-field', for: 'fcl-cap-speed' }, h('span', { class: 'fcl-field-name' }, 'SPEED'), els.speed),
        h('label', { class: 'fcl-cap-check', for: 'fcl-cap-shift' }, els.shift, h('span', {}, 'MOVE IT TO THE LAUNCH FIELD'))),
      h('p', { class: 'fcl-actions' }, els.play, els.stop),
      els.state,
      els.msg);
    slot.replaceChildren(els.root);
  }

  function onPlay() {
    play({
      url: DEFAULT_CAPTURE,
      speed: Number(els.speed.value),
      shift: els.shift.checked ? 'field' : 'none',
    });
  }

  function say(text, kind = 'info') {
    message = text ? { text, kind } : null;
    draw();
  }

  function render() {
    if (!slot) return;
    const st = status();
    const busy = st.state !== 'idle';
    els.play.hidden = busy;
    els.stop.hidden = !busy;
    els.speed.disabled = busy;
    els.shift.disabled = busy || !hub.settings?.field?.center;
    let text = '';
    let kind = 'info';
    if (st.state === 'loading') text = 'LOADING THE CAPTURE';
    else if (st.playing) {
      text = `PLAYING. NOT LIVE DATA. ${fmt(st.sent)} OF ${fmt(st.total)} LINES AT ${st.speed}X`;
      kind = 'warn';
    } else if (last) {
      text = last.reason === 'ended'
        ? `THE LAST TEST PLAYED ALL ${fmt(last.total)} LINES`
        : `THE LAST TEST STOPPED AFTER ${fmt(last.sent)} OF ${fmt(last.total)} LINES`;
    }
    setText(els.state, text);
    els.state.hidden = !text;
    els.state.dataset.kind = kind;
    els.msg.hidden = !message;
    if (message) {
      setText(els.msg, message.text);
      els.msg.dataset.kind = message.kind;
    }
  }
  const scheduler = createScheduler(render, { maxFps: 8 });
  function draw() { scheduler.schedule(); }
  render();

  // ------------------------------------------------------------------
  // Starting by itself from the address (automated runs)
  // ------------------------------------------------------------------
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  if (params.has('capture')) {
    const value = params.get('capture');
    const url = !value || value === '1' || value === 'true' ? DEFAULT_CAPTURE : value;
    const speed = cleanSpeed(params.get('speed') ?? 1);
    const shift = params.get('shift') === 'none' ? 'none' : 'field';
    if (els.speed && SPEEDS.includes(speed)) els.speed.value = String(speed);
    if (els.shift) els.shift.checked = shift === 'field';
    const began = Date.now();
    const ready = () => (ctx.getScreen?.() === 'track' && ctx.getStage?.()) || Date.now() - began > WAIT_FOR_CONSOLE_MS;
    const wait = () => {
      if (ready()) play({ url, speed, shift });
      else setTimeout(wait, 100);
    };
    setTimeout(wait, 0);
  }

  return { play, stop, status };
}
