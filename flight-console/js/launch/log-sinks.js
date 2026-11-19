// log-sinks.js: the two files launch mode's flight log is written to, apart
// from the copy the browser keeps in its own storage (js/local/).
//
//   createDiskSink()     the file the user picked, written with the File
//                        System Access API
//   createServerSink()   flight-logs/<name>.log, written by the local server
//                        (launch-mode/server.mjs) from POST
//                        /launch-mode/log/append?name=<name>
//
// Both copy one log text (createLogText() in log-format.js), which only
// ever grows. A sink remembers how many of the text's lines its file has,
// and each cycle() adds the lines after that. The rules for both:
//   - One cycle at a time. A second call while one runs starts nothing.
//   - A cycle that fails changes nothing the sink remembers, so the same
//     lines go again on the next one, in order. Nothing is dropped.
//   - Before it writes, a sink asks how big its file is. The file is a copy
//     of the text from its start, so its size says exactly how many lines it
//     holds (lineAtBytes()). That is how a write whose end was never heard
//     (a close() that failed, a request that timed out) is never done twice.
//
// THE DISK FILE. A FileSystemWritableFileStream writes into a hidden swap
// file, and the real file only changes when the stream is closed. A stream
// left open for a whole flight would lose all of it in a crash. So each
// cycle opens a stream that keeps what the file has, goes to the end, writes
// the new lines and closes. After a crash the file has every line up to the
// last cycle that finished.
//
// flight-log.js makes them and decides when a cycle runs (about once a
// second, and at once when the page is hidden). No DOM here, so Node can
// test them with a stand-in file handle and a stand-in fetch.

import { otherFileName } from './log-format.js';

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

// The most one request to the server carries, in bytes. A longer backlog
// goes in several requests, one after the other.
export const MAX_POST_BYTES = 256 * 1024;
// A request up to this size is marked keepalive, so the browser finishes
// sending it even if the page closes right after. (Browsers refuse bigger
// keepalive bodies.)
export const KEEPALIVE_MAX_BYTES = 48 * 1024;
// How long (ms) the server gets to answer one request.
export const POST_TIMEOUT_MS = 5000;

// ------------------------------------------------------------------
// The disk file
// ------------------------------------------------------------------

// text is the log (createLogText()). Give it a file with use(handle), a
// FileSystemFileHandle from the save box (or, in a test, from the browser's
// private file system).
//   cycle({ urgent })   writes the lines the file doesn't have yet. Resolves
//                       true when the file has every line, false when the
//                       write failed (see error) or there is no file. urgent
//                       runs one more cycle right after the one in progress.
//   state()             { name, lines, bytes, pending, lastWriteAt, error, busy }
export function createDiskSink({ text, now = () => Date.now(), onChange = () => {} }) {
  let handle = null;
  let turn = 0;            // goes up with every new file, so a cycle on the old one is ignored
  let base = null;         // the file's size before this log's first line, null until it is read
  let written = 0;         // lines of the log that are in the file
  let busy = null;         // the running cycle's promise
  let again = false;
  let error = null;
  let lastWriteAt = null;
  let lastStartAt = 0;

  function use(next) {
    handle = next ?? null;
    turn += 1;
    base = null;
    written = 0;
    error = null;
    lastWriteAt = null;
    onChange();
  }

  async function run(mine, file) {
    const size = (await file.getFile()).size;
    if (mine !== turn) return;
    // Whatever the file already held stays. This log goes after it.
    if (base === null) base = size;
    const own = size - base;
    const k = text.lineAtBytes(own);
    if (k >= 0) {
      // The usual case. Also a write that landed although its close()
      // reported an error, or a file put back to an older copy.
      written = k;
    } else if (own < text.bytesAt(written)) {
      // The file lost part of the log. All of it goes in again, at the end.
      base = size;
      written = 0;
    } else {
      // Something else added to the file. This log carries on at its end.
      base = size - text.bytesAt(written);
    }
    const upto = text.count;
    if (written >= upto) return;
    const data = encoder.encode(text.text(written, upto));
    const stream = await file.createWritable({ keepExistingData: true });
    try {
      await stream.seek(size);
      await stream.write(data);
    } catch (err) {
      // Nothing reaches the real file before close(), so this is safe.
      try { await stream.abort(); } catch { /* already gone */ }
      throw err;
    }
    await stream.close();
    if (mine !== turn) return;
    written = upto;
    lastWriteAt = now();
  }

  function cycle({ urgent = false } = {}) {
    if (!handle) return Promise.resolve(false);
    if (busy) {
      if (urgent) again = true;
      return busy;
    }
    if (written >= text.count && !error) return Promise.resolve(true);
    lastStartAt = now();
    const mine = turn;
    busy = run(mine, handle).then(
      () => { if (mine === turn) error = null; },
      (err) => { if (mine === turn) error = err ?? new Error('the file could not be written'); },
    ).then(() => {
      busy = null;
      onChange();
      if (again) {
        again = false;
        return cycle();
      }
      return !error && written >= text.count;
    });
    return busy;
  }

  return {
    use,
    cycle,
    get handle() { return handle; },
    get lastStartAt() { return lastStartAt; },
    state: () => ({
      name: handle?.name ?? '',
      lines: text.dataAt(written),
      bytes: text.bytesAt(written),
      pending: text.count - written,
      lastWriteAt,
      error,
      busy: Boolean(busy),
    }),
  };
}

// ------------------------------------------------------------------
// The server's copy
// ------------------------------------------------------------------

// What went wrong with a request, as an Error with a kind:
//   'unknown'   no answer, or the server hit a problem while writing. The
//               lines may or may not be in the file.
//   'refused'   the server answered and wrote nothing
//   'absent'    this address is not the launch mode server at all
function problem(kind, message) {
  return Object.assign(new Error(message), { kind });
}

// text is the log, name the file's name in flight-logs/, url the server's
// append address (without the ?name= part).
//   cycle({ urgent })   sends the lines the server doesn't have yet.
//                       Resolves true when it has every line.
//   beacon()            the page is closing: sends what is left in one last
//                       request that outlives the page (see below). Returns
//                       how many lines it sent.
//   state()             { state, name, lines, bytes, pending, lastOkAt, error, busy }
//                       state is 'unknown' before the first answer, then
//                       'saving', 'failing' (it will keep trying) or 'none'
//                       (this address has no launch mode server)
//
// THE LAST REQUEST. When the page closes, a cycle can't wait for answers.
// beacon() sends the lines after the ones already on their way, with
// navigator.sendBeacon (or a keepalive fetch), which the browser finishes
// after the page is gone. Its answer is never read, so if the page lives on
// after all (a page kept in the back and forward cache), the next cycle asks
// the file's size first and carries on from what really landed.
export function createServerSink({
  text,
  name,
  url,
  fetch = (...args) => globalThis.fetch(...args),
  sendBeacon = (to, data) => globalThis.navigator?.sendBeacon?.(to, data) ?? false,
  now = () => Date.now(),
  timeoutMs = POST_TIMEOUT_MS,
  rename = otherFileName,
  onChange = () => {},
}) {
  let fileName = name;
  let bytes = null;        // the file's size after the last answer, null before the first one
  let sent = 0;            // lines of the log the server has
  let unsure = false;      // a send's end was never heard, so the size has to be asked first
  let recheck = false;     // beacon() sent lines whose answer is never heard
  let inflight = null;     // { upto, keepalive } for the lines on their way now
  let busy = null;
  let again = false;
  let state = 'unknown';
  let error = null;
  let lastOkAt = null;
  let lastStartAt = 0;
  let failures = 0;        // cycles that failed in a row

  const target = () => `${url}?name=${encodeURIComponent(fileName)}`;

  // Sends bytes to add to the file and returns the file's size afterward.
  // Sending nothing adds nothing, and still answers with the size.
  async function post(data) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res;
    let body = null;
    try {
      res = await fetch(target(), {
        method: 'POST',
        body: data,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        cache: 'no-store',
        keepalive: data.length <= KEEPALIVE_MAX_BYTES,
        signal: abort.signal,
      });
      try { body = await res.json(); } catch { body = null; }
    } catch (err) {
      throw problem('unknown', abort.signal.aborted ? 'the local server did not answer in time' : `the local server did not answer (${err?.message ?? err})`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && body?.ok === true && Number.isFinite(body.bytes)) return body.bytes;
    if (res.status === 404 || res.status === 405 || res.status === 501 || (res.ok && !body)) {
      throw problem('absent', 'this page was not opened from the launch mode server');
    }
    const why = typeof body?.error === 'string' ? body.error : `the local server answered ${res.status}`;
    throw problem(res.status >= 500 ? 'unknown' : 'refused', why);
  }

  // Lines from `from` that fit in one request (always at least one).
  function batchEnd(from) {
    let to = from + 1;
    const limit = text.bytesAt(from) + MAX_POST_BYTES;
    while (to < text.count && text.bytesAt(to + 1) <= limit) to += 1;
    return to;
  }

  // The file isn't a copy of this log's start (another page took the name,
  // or something else wrote to it). This log starts again in a file of its
  // own, so no file ever holds two logs mixed together.
  function startOver() {
    fileName = rename(fileName);
    bytes = null;
    sent = 0;
    unsure = false;
    recheck = false;
  }

  async function run() {
    // The loop ends when the server has every line. It can only go round
    // again without sending when a file had to be started over.
    for (let round = 0; round < 10000; round += 1) {
      if (bytes === null) {
        // First word with this file. It must be new and empty.
        const size = await post(EMPTY);
        if (size !== 0) {
          startOver();
          continue;
        }
        bytes = 0;
        sent = 0;
      } else if (unsure || recheck) {
        recheck = false;
        const size = await post(EMPTY);
        unsure = false;
        const k = text.lineAtBytes(size);
        if (k < 0) {
          startOver();
          continue;
        }
        sent = k;
        bytes = size;
      }
      if (sent >= text.count) return;
      const upto = batchEnd(sent);
      const data = encoder.encode(text.text(sent, upto));
      unsure = true;
      inflight = { upto, keepalive: data.length <= KEEPALIVE_MAX_BYTES };
      let size;
      try {
        size = await post(data);
      } catch (err) {
        // A refusal means nothing was written, so there is nothing to ask.
        if (err.kind !== 'unknown') unsure = false;
        throw err;
      } finally {
        inflight = null;
      }
      unsure = false;
      const k = text.lineAtBytes(size);
      if (k < 0) {
        startOver();
        continue;
      }
      sent = k;
      bytes = size;
      lastOkAt = now();
    }
  }

  function cycle({ urgent = false } = {}) {
    if (busy) {
      if (urgent) again = true;
      return busy;
    }
    if (bytes !== null && !unsure && !recheck && sent >= text.count && state === 'saving') return Promise.resolve(true);
    lastStartAt = now();
    busy = run().then(
      () => { state = 'saving'; error = null; failures = 0; },
      (err) => { state = err?.kind === 'absent' ? 'none' : 'failing'; error = err; failures += 1; },
    ).then(() => {
      busy = null;
      onChange();
      if (again) {
        again = false;
        return cycle();
      }
      return state === 'saving' && sent >= text.count;
    });
    return busy;
  }

  // See THE LAST REQUEST above. Nothing goes when the server was never
  // heard from, when what it has is not known (a send's end was never
  // heard), or when the request on its way now would not outlive the page
  // (a line after a gap would be worse than a line missing at the end).
  function beacon() {
    if (state === 'none' || bytes === null) return 0;
    if (busy ? !inflight || !inflight.keepalive : unsure || recheck) return 0;
    const from = busy ? inflight.upto : sent;
    let to = from;
    while (to < text.count && text.bytesAt(to + 1) - text.bytesAt(from) <= KEEPALIVE_MAX_BYTES) to += 1;
    if (to === from) return 0;
    const body = text.text(from, to);
    let ok = false;
    try {
      ok = Boolean(sendBeacon(target(), new Blob([body], { type: 'text/plain;charset=utf-8' })));
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        fetch(target(), { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true, cache: 'no-store' }).catch(() => {});
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) return 0;
    recheck = true;
    return to - from;
  }

  return {
    cycle,
    beacon,
    get lastStartAt() { return lastStartAt; },
    get failures() { return failures; },
    state: () => ({
      state,
      name: fileName,
      lines: text.dataAt(sent),
      bytes: bytes ?? 0,
      pending: text.count - sent,
      lastOkAt,
      error,
      busy: Boolean(busy),
    }),
  };
}
