// flight-db.js: where this browser keeps LOCAL flights, the ones recorded
// from a board on the USB cable and the ones loaded from a file. Nothing in
// here ever leaves the browser.
//
// It uses IndexedDB. Two stores:
//   flights   one record per flight, keyed by id:
//               { id, status, title, createdAt, updatedAt, source,
//                 fileName, kind, eol, trailingEol, lineCount, byteCount,
//                 durationS, sampleCount, blockCount }
//             status is 'recording' while a recording runs (and after a
//             crash, until it's recovered or thrown away) and 'saved' after.
//   chunks    the flight's lines, a few seconds' worth at a time, keyed by
//             [id, seq]: { id, seq, lines, times }. times holds when each
//             line arrived (ms on the computer's clock), or is null for a
//             loaded file.
//
// When the browser won't open IndexedDB (some private windows, or blocked
// site data), the same calls work on a copy in memory instead, and
// `persistent` is false. Those flights last until the page closes. Node's
// tests use the memory copy too.
//
// No DOM here.
//
// Usage:
//   const db = await openFlightDb();
//   await db.putFlight(record);
//   await db.addChunk(id, seq, lines, times);
//   const { lines, times } = await db.readLines(id);
//   await db.deleteFlight(id);

const DB_NAME = 'dogtooth-flight-console';
const DB_VERSION = 1;

export async function openFlightDb({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (indexedDB) {
    try {
      return idbStore(await openIdb(indexedDB, name));
    } catch (err) {
      console.warn('Flight Console: this browser won\'t store flights, so they are kept in memory', err);
    }
  }
  return memoryStore();
}

function openIdb(indexedDB, name) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(name, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('flights')) db.createObjectStore('flights', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the database is blocked by another tab'));
  });
}

// Runs fn(stores) in one transaction and resolves with what fn returned
// once the transaction has finished (so the data is really stored).
function run(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    tx.oncomplete = () => resolve(result?.req ? result.req.result : result);
    tx.onabort = () => reject(tx.error ?? new Error('the transaction was cancelled'));
    tx.onerror = () => {};   // onabort follows with the error
    try {
      result = fn(stores);
    } catch (err) {
      tx.abort();
      reject(err);
    }
  });
}

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

function idbStore(db) {
  // Another tab asked for a newer version: let it have the database.
  db.onversionchange = () => db.close();
  return {
    persistent: true,
    listFlights: () => run(db, ['flights'], 'readonly', (s) => ({ req: s.flights.getAll() })),
    getFlight: (id) => run(db, ['flights'], 'readonly', (s) => ({ req: s.flights.get(id) })).then((r) => r ?? null),
    putFlight: (record) => run(db, ['flights'], 'readwrite', (s) => { s.flights.put(record); }),
    // A chunk and the flight's record together, so the record's counts
    // always match the lines that are stored.
    addChunk: (id, seq, lines, times, record = null) => run(db, ['flights', 'chunks'], 'readwrite', (s) => {
      s.chunks.put({ id, seq, lines, times });
      if (record) s.flights.put(record);
    }),
    readLines: (id) => run(db, ['chunks'], 'readonly', (s) => ({ req: s.chunks.getAll(chunkRange(id)) })).then(joinChunks),
    deleteFlight: (id) => run(db, ['flights', 'chunks'], 'readwrite', (s) => {
      s.flights.delete(id);
      s.chunks.delete(chunkRange(id));
    }),
  };
}

function memoryStore() {
  const flights = new Map();
  const chunks = new Map();     // id -> Map(seq -> chunk)
  const copy = (x) => (x == null ? x : structuredClone(x));
  return {
    persistent: false,
    listFlights: async () => [...flights.values()].map(copy),
    getFlight: async (id) => copy(flights.get(id)) ?? null,
    putFlight: async (record) => { flights.set(record.id, copy(record)); },
    addChunk: async (id, seq, lines, times, record = null) => {
      if (!chunks.has(id)) chunks.set(id, new Map());
      chunks.get(id).set(seq, copy({ id, seq, lines, times }));
      if (record) flights.set(record.id, copy(record));
    },
    readLines: async (id) => joinChunks([...(chunks.get(id)?.values() ?? [])].map(copy)),
    deleteFlight: async (id) => {
      flights.delete(id);
      chunks.delete(id);
    },
  };
}

// The chunks, in order, as one list of lines and one of times. times is
// null when no chunk has them (a loaded file).
function joinChunks(list) {
  const sorted = [...(list ?? [])].sort((a, b) => a.seq - b.seq);
  const lines = [];
  const times = [];
  let timed = false;
  for (const c of sorted) {
    for (let i = 0; i < c.lines.length; i++) {
      lines.push(c.lines[i]);
      const t = c.times ? c.times[i] : null;
      if (t != null) timed = true;
      times.push(t ?? null);
    }
  }
  return { lines, times: timed ? times : null };
}
