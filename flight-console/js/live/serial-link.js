// serial-link.js: the board's USB serial port, opened with the Web Serial
// API and read line by line. Moved here from the Bench Console's main.js.
//
// It knows nothing about what the lines say. Every finished line goes to
// onLine(line, t), where t is when it arrived, in ms on the computer's
// clock. sources.js works out what is talking, and bench-panel.js and
// bench-feed.js read it.
//
// Usage:
//   const link = createSerialLink({
//     onLine(line, t) {},          // every finished line
//     onLink(state, text) {},      // 'idle', 'picking', 'opening', 'open', 'closing', 'closed' or 'lost'
//     onNote(text, kind) {},       // a friendly note for the page, '' clears it. kind is 'info' or 'warn'
//     onOpen() {},                 // the port just opened, a new connection starts
//     onClose({ lost }) {},        // the port closed. lost is true when the board went away
//   });
//   link.supported                 // false in browsers without Web Serial
//   button.onclick = () => link.connect();
//
// Launch mode (js/launch/flight-log.js) also opens a port the browser
// already has leave to use, with no picker:
//   const ports = await link.granted();
//   link.connect({ port: ports[0] });
// After a lost port it opens the receiver again by itself, and tries until
// it works. Those tries are quiet: a try that fails changes nothing on the
// page, and connect() resolves false.
//   const opened = await link.connect({ port, quiet: true, still: () => stillWanted });
// It also swaps two of the link's own notes for its own words:
//   link.useNotes({ lost: '', busy: '...' });
//
// No DOM here. It needs navigator.serial only when connect() runs.

export const BAUD = 115200;
const MAX_LINE = 4096;              // a "line" longer than this is cut, so noise can't grow forever

// The notes the link writes by itself: the board went away, and the port
// would not open. useNotes() swaps one for a page's own words.
export const LINK_NOTES = {
  lost: 'The board was unplugged or stopped answering. Plug it back in and press CONNECT.',
  busy: 'The port didn\'t open. Another program is probably using it, so close any serial monitor and press CONNECT again.',
};

// What the page says for each state of the link.
export const LINK_TEXT = {
  idle: 'Not connected',
  picking: 'Pick the board in the list',
  opening: 'Connecting',
  open: `Connected at ${BAUD.toLocaleString('en-US')} baud`,
  closing: 'Disconnecting',
  closed: 'Disconnected',
  lost: 'Board unplugged',
};

// True when this browser has the Web Serial API (Chrome and Edge on a
// desktop or laptop).
export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function createSerialLink({ onLine, onLink, onNote, onOpen, onClose } = {}) {
  const supported = serialSupported();
  const notes = { ...LINK_NOTES };
  const state = {
    port: null,
    reader: null,
    loop: null,
    keepReading: false,
    lost: false,
    link: 'idle',
    wasOpen: false,     // a port was open at some point, so "Disconnected" fits better than "Not connected"
    trying: false,      // a quiet connect() is opening a port right now
  };

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  function setLink(link) {
    state.link = link;
    onLink?.(link, LINK_TEXT[link]);
  }

  function note(text, kind = 'info') {
    onNote?.(text, kind);
  }

  const restingState = () => (state.wasOpen ? 'closed' : 'idle');

  // Opens a port. With no port given, the browser's picker asks for one,
  // which needs a click. A port from granted() opens without the picker.
  // Resolves true once the port is open, false when it is not.
  //
  // quiet is for a page that reconnects by itself (launch mode): the try
  // shows nothing while it runs, and one that fails leaves the link's state
  // and its note as they were. still() is asked once the port has opened.
  // If it says false (the page stopped waiting in the meantime), the port
  // is closed again and no connection starts.
  async function connect({ port: given = null, quiet = false, still = null } = {}) {
    if (!supported || state.port || state.trying || state.link === 'picking' || state.link === 'opening') return false;
    if (quiet) return connectQuietly(given, still);
    note('');
    let port = given;
    if (!port) {
      setLink('picking');
      try {
        port = await navigator.serial.requestPort();
      } catch (err) {
        setLink(restingState());
        if (err.name === 'NotFoundError') note('No port was picked, so nothing changed.');
        else if (err.name === 'SecurityError') note('The browser blocked access to serial ports on this page.', 'warn');
        else note(`The port list didn't open (${err.message}).`, 'warn');
        return false;
      }
    }

    setLink('opening');
    try {
      await port.open({ baudRate: BAUD });
    } catch (err) {
      setLink(restingState());
      note(notes.busy, 'warn');
      console.warn('Flight Console: port.open failed', err);
      return false;
    }
    await started(port);
    return true;
  }

  // The quiet kind of connect() (see above). It needs a port, since a
  // picker can't be shown without a click.
  async function connectQuietly(port, still) {
    if (!port) return false;
    // Set until the connection has started, so a second connect() can't
    // begin in the middle of this one.
    state.trying = true;
    try {
      try {
        await port.open({ baudRate: BAUD });
      } catch {
        // Not ready yet, or another program has it. The page tries again.
        return false;
      }
      if (still && !still()) {
        try { await port.close(); } catch { /* it may be gone again */ }
        return false;
      }
      note('');
      await started(port);
      return true;
    } finally {
      state.trying = false;
    }
  }

  // The port is open: the connection starts.
  async function started(port) {
    // The SAMD21's USB serial reports "connected" only while DTR is on. Most
    // systems turn it on when the port opens. This makes sure.
    try { await port.setSignals({ dataTerminalReady: true }); } catch { /* not every port supports it */ }

    state.port = port;
    state.keepReading = true;
    state.lost = false;
    state.wasOpen = true;
    onOpen?.();
    setLink('open');
    state.loop = readLoop(port);
  }

  // The ports this page was given leave to open on an earlier CONNECT and
  // that are plugged in now. Opening one of them needs no click.
  async function granted() {
    if (!supported) return [];
    try {
      return await navigator.serial.getPorts();
    } catch {
      return [];
    }
  }

  async function disconnect() {
    if (!state.port) return;
    state.keepReading = false;
    setLink('closing');
    try { await state.reader?.cancel(); } catch { /* already closed */ }
    await state.loop;
  }

  // Reads until Disconnect or until the board goes away. Some read errors
  // (a dropped byte, a framing error) don't close the port. The browser
  // hands over a fresh stream and reading goes on.
  async function readLoop(port) {
    const decoder = new TextDecoder();
    let buffer = '';
    while (port.readable && state.keepReading) {
      const reader = port.readable.getReader();
      state.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = takeLines(buffer);
        }
      } catch (err) {
        if (err.name === 'NetworkError') state.lost = true;
        else note(`Some data was lost while reading (${err.name}), but the page is still reading.`, 'warn');
      } finally {
        reader.releaseLock();
        state.reader = null;
      }
    }
    try { await port.close(); } catch { /* the board may already be gone */ }
    if (state.port === port) state.port = null;
    const lost = state.keepReading || state.lost;
    // The listener keeps a block cut off by the disconnect, with what it had.
    onClose?.({ lost });
    if (lost) {
      setLink('lost');
      note(notes.lost, 'warn');
    } else {
      setLink('closed');
    }
    state.keepReading = false;
  }

  // Unplugging the board fires this even when a read is waiting.
  function onSerialDisconnect(e) {
    if (e.target !== state.port) return;
    state.lost = true;
    state.reader?.cancel().catch(() => {});
  }

  // Splits off every finished line and returns the unfinished rest. Each
  // line is taken off the buffer before it is handed on, and an error in
  // the listener is caught here, so one bad line can't stop the reading or
  // make the same lines go out again with the next chunk.
  function takeLines(buffer) {
    const now = Date.now();
    let start = 0;
    let nl;
    while ((nl = buffer.indexOf('\n', start)) !== -1) {
      const line = buffer.slice(start, nl).replace(/\r$/, '');
      start = nl + 1;
      sendLine(line, now);
    }
    let rest = buffer.slice(start);
    if (rest.length > MAX_LINE) {
      const long = rest;
      rest = '';
      sendLine(long, now);
    }
    return rest;
  }

  function sendLine(line, t) {
    try {
      onLine?.(line, t);
    } catch (err) {
      console.error('Flight Console: error handling a serial line', err);
    }
  }

  if (supported) navigator.serial.addEventListener('disconnect', onSerialDisconnect);

  return {
    connect,
    disconnect,
    granted,
    get link() { return state.link; },
    get open() { return state.link === 'open'; },
    // The open port, or null.
    get port() { return state.port; },
    supported,
    // Swaps the link's own notes (LINK_NOTES) for a page's words. '' shows
    // no note at all for that case.
    useNotes(next = {}) {
      for (const key of Object.keys(LINK_NOTES)) {
        if (typeof next[key] === 'string') notes[key] = next[key];
      }
    },
    // Stops listening for unplugged boards. Call it when the page is done
    // with this link (after disconnect()).
    destroy() {
      if (supported) navigator.serial.removeEventListener('disconnect', onSerialDisconnect);
    },
  };
}
