// Checks js/live/serial-link.js with a fake serial port: lines split across
// USB chunks come out whole, and a listener that throws on one line doesn't
// stop the reading or send the same lines again.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/serial-link.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A port that hands over these chunks, then waits like a quiet board.
function fakePort(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    readable: new ReadableStream({
      pull(ctrl) {
        if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
        else return new Promise(() => {});
      },
    }),
    async open() {},
    async setSignals() {},
    async close() {},
  };
}

let nextPort = null;
Object.defineProperty(globalThis.navigator, 'serial', {
  value: Object.assign(new EventTarget(), { requestPort: async () => nextPort }),
  configurable: true,
});
const { createSerialLink } = await import('../js/live/serial-link.js');

// Connects to a port with these chunks and returns every line handed on,
// plus the notes the link showed.
async function readAll(chunks, onLine = () => {}) {
  nextPort = fakePort(chunks);
  const lines = [];
  const notes = [];
  const link = createSerialLink({
    onLine(line) { lines.push(line); onLine(line); },
    onNote(text) { if (text) notes.push(text); },
  });
  await link.connect();
  await new Promise((r) => setTimeout(r, 50));
  await link.disconnect();
  link.destroy();
  return { lines, notes };
}

test('lines split across chunks come out whole, without their \\r', async () => {
  const { lines } = await readAll(['HEART', 'BEAT #1\r\nLAT', 'ITUDE: 42.3\r\n', 'half a line']);
  assert.deepEqual(lines, ['HEARTBEAT #1', 'LATITUDE: 42.3']);
});

test('a listener that throws on one line doesn\'t stop the rest', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { lines, notes } = await readAll(['A1\nA2\nBAD\nA3\n', 'B1\nB2\n', 'C1\n'], (line) => {
      if (line === 'BAD') throw new TypeError('listener bug');
    });
    assert.deepEqual(lines, ['A1', 'A2', 'BAD', 'A3', 'B1', 'B2', 'C1']);
    assert.deepEqual(notes, [], 'no "data was lost" note');
  } finally {
    console.error = original;
  }
});
