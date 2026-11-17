// local-console.js: the page side of LOCAL flights (js/local/).
//
//   Recording   Pressing CONNECT starts a recording as soon as the port
//               opens. The bar shows "REC 02:14" with an amber dot, and
//               STOP. STOP, or the board disconnecting, ends it and asks
//               for a name (the date and time unless one is typed). It's
//               then a LOCAL flight in SAVED FLIGHTS. After a STOP the bar
//               shows RECORD while the board is still connected, to start
//               a new one.
//   Recovery    A recording that a crash or a closed tab left unfinished is
//               offered on the next visit: UNSAVED RECORDING FOUND, with
//               RECOVER and DISCARD (DISCARD asks first).
//   Files       LOAD FILE in SAVED FLIGHTS, or a file dropped anywhere on
//               the page. It takes a raw serial log or the console's own
//               CSV file, told apart by what's in it. The file is read in
//               the browser and kept there as a LOCAL flight. Nothing is
//               uploaded anywhere.
//   Exports     EXPORT RAW LOG and EXPORT CSV under each LOCAL flight, and
//               DELETE (which asks first).
//
// main.js makes it once and passes the serial link's callbacks through
// wrapLink(), so every line is recorded before anything else sees it.
//
// Usage (main.js):
//   const localConsole = createLocalConsole({ savedMenu, navigate, announce });
//   createSerialLink(localConsole.wrapLink({ onLine, onOpen, onClose, ... }));
//   await localConsole.find(id)      // { entry, load() } or null, for openFlight()
//   localConsole.coversLive()        // every connection is safely recorded

import { h, setChildren } from './dom.js?v=2';
import { formatDuration } from '../geo.js?v=3';
import { openFlightDb } from '../local/flight-db.js';
import {
  createRecorder, saveRecording, findUnfinished, findBusy, listSaved, readFlightFile, storeFile,
  openLocalFlight, rawLogText, csvText, exportsFor, exportFileName, defaultName, cleanName,
  isLocalId, lockName, MAX_FILE_BYTES, MAX_NAME, STALE_MS,
} from '../local/local-flights.js';

const $ = (id) => document.getElementById(id);

export function createLocalConsole({ savedMenu, navigate, announce = () => {} }) {
  const els = {
    rec: $('fc-rec'),
    recTime: $('fc-rec-time'),
    recStop: $('fc-rec-stop'),
    recStart: $('fc-rec-start'),
    recover: $('fc-recover'),
    recoverText: $('fc-recover-text'),
    recoverActions: $('fc-recover-actions'),
    fileNote: $('fc-file-note'),
    fileTag: $('fc-file-tag'),
    fileText: $('fc-file-text'),
  };

  // Storage opens in the background. Until it's open, calls wait for it.
  const dbReady = openFlightDb();
  let db = null;
  const lazyDb = {
    listFlights: (...a) => dbReady.then((d) => d.listFlights(...a)),
    getFlight: (...a) => dbReady.then((d) => d.getFlight(...a)),
    putFlight: (...a) => dbReady.then((d) => d.putFlight(...a)),
    addChunk: (...a) => dbReady.then((d) => d.addChunk(...a)),
    readLines: (...a) => dbReady.then((d) => d.readLines(...a)),
    deleteFlight: (...a) => dbReady.then((d) => d.deleteFlight(...a)),
  };

  let linkOpen = false;
  let stopping = false;        // STOP or a disconnect is being handled
  let allRecorded = true;      // every line of every connection this visit is in a recording
  let saved = [];              // the saved LOCAL flights, newest first
  let unfinished = [];         // recordings left behind, newest first
  let recoverAsking = false;   // the recovery line is asking "discard it?"

  const recorder = createRecorder({
    db: lazyDb,
    onState: () => showRec(),
    onProblem: (err) => {
      if (err) {
        allRecorded = false;
        console.warn('Flight Console: the recording could not be stored', err);
        fileNote('RECORDING', `This browser stopped storing the recording (${err.name || 'an error'}). The newest lines are kept on this page until it works again, so don't close it yet.`, 'warn');
      } else if (els.fileNote.dataset.tag === 'RECORDING') {
        hideFileNote();
      }
    },
  });

  // ------------------------------------------------------------------
  // The REC readout in the bar
  // ------------------------------------------------------------------
  let clock = null;
  function showRec() {
    const on = recorder.active;
    els.rec.hidden = !on;
    els.recStart.hidden = on || !linkOpen || stopping;
    if (on && !clock) {
      clock = setInterval(tick, 250);
      tick();
    } else if (!on && clock) {
      clearInterval(clock);
      clock = null;
    }
  }

  function tick() {
    const s = Math.floor(recorder.elapsed() / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    const text = hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
    if (els.recTime.textContent !== text) els.recTime.textContent = text;
  }

  function startRecording() {
    if (recorder.active || !linkOpen) return;
    recorder.start();
    announce('Recording started.');
  }

  els.recStop.addEventListener('click', () => endRecording('stop'));
  els.recStart.addEventListener('click', () => startRecording());

  // ------------------------------------------------------------------
  // The serial link
  // ------------------------------------------------------------------
  function wrapLink(callbacks) {
    return {
      ...callbacks,
      onLine(line, t) {
        recorder.line(line, t);
        callbacks.onLine?.(line, t);
      },
      onOpen() {
        linkOpen = true;
        callbacks.onOpen?.();
        startRecording();
        showRec();
      },
      onClose(info) {
        linkOpen = false;
        callbacks.onClose?.(info);
        if (recorder.active) endRecording('closed', info);
        showRec();
      },
    };
  }

  // Ends the running recording and asks for its name. reason is 'stop' (the
  // STOP button) or 'closed' (the port closed).
  async function endRecording(reason, info = {}) {
    if (!recorder.active || stopping) return;
    stopping = true;
    if (reason === 'stop' && linkOpen) allRecorded = false;   // what comes next isn't recorded
    showRec();
    const record = await recorder.stop();
    try {
      if (!record || !record.lineCount) {
        // Nothing came in, so there's nothing to keep.
        if (record) await lazyDb.deleteFlight(record.id).catch(() => {});
        recorder.release();
        return;
      }
      const ranS = (record.updatedAt - record.createdAt) / 1000;
      const why = reason === 'closed'
        ? `${info.lost ? 'The board was unplugged' : 'The board disconnected'}, so the recording stopped after ${formatDuration(ranS)}.`
        : `The recording ran ${formatDuration(ranS)}.`;
      const choice = await askName({ title: 'SAVE THIS RECORDING', text: `${why} Give it a name, or keep the date and time.`, record });
      if (choice.action === 'save') {
        recorder.release();
        await refresh();
        savedNote(choice.saved);
      } else {
        await lazyDb.deleteFlight(record.id);
        recorder.release();
        announce('The recording was discarded.');
      }
    } catch (err) {
      console.error('Flight Console: the recording could not be finished', err);
      recorder.release();
      fileNote('RECORDING', 'The recording couldn\'t be finished. It will be offered again the next time this page opens.', 'warn');
    } finally {
      stopping = false;
      showRec();
    }
  }

  // ------------------------------------------------------------------
  // The name box
  // ------------------------------------------------------------------
  const dialog = buildDialog();
  document.body.append(dialog.el);

  function buildDialog() {
    const title = h('h2', { id: 'fc-name-title', class: 'fc-dialog-title' });
    const text = h('p', { class: 'fc-dialog-text' });
    const input = h('input', { id: 'fc-name-input', class: 'fc-dialog-input', type: 'text', maxlength: String(MAX_NAME), autocomplete: 'off', spellcheck: 'false' });
    const field = h('div', { class: 'fc-dialog-field' }, h('label', { class: 'fc-dialog-label', for: 'fc-name-input' }, 'NAME'), input);
    const error = h('p', { class: 'fc-dialog-error', role: 'alert', hidden: true });
    const actions = h('div', { class: 'fc-dialog-actions' });
    const form = h('form', { class: 'fc-dialog-body', method: 'dialog' }, title, text, field, error, actions);
    const el = h('dialog', { class: 'fc-dialog', 'aria-labelledby': 'fc-name-title' }, form);
    return { el, title, text, input, field, error, actions, form };
  }

  // Shows the name box for a stopped or recovered recording and saves it.
  // Resolves with { action: 'save', saved } or { action: 'discard' }.
  // Escape saves with the name in the box, so a recording is never lost by
  // backing out.
  function askName({ title, text, record }) {
    const d = dialog;
    return new Promise((resolve) => {
      let busy = false;
      const naming = () => {
        d.title.textContent = title;
        d.text.textContent = text;
        d.field.hidden = false;
        setChildren(d.actions,
          h('button', { type: 'submit', class: 'fc-bkt' }, 'SAVE'),
          h('button', { type: 'button', class: 'fc-bkt', onclick: asking }, 'DISCARD'));
      };
      const asking = () => {
        d.title.textContent = 'DISCARD THIS RECORDING?';
        d.text.textContent = 'It will be deleted from this browser and can\'t be brought back.';
        d.field.hidden = true;
        d.error.hidden = true;
        const keep = h('button', { type: 'button', class: 'fc-bkt', onclick: () => { naming(); d.input.focus(); } }, 'KEEP');
        setChildren(d.actions,
          h('button', { type: 'button', class: 'fc-bkt', onclick: () => finish({ action: 'discard' }) }, 'DISCARD'),
          keep);
        keep.focus();
      };
      const save = async () => {
        if (busy) return;
        busy = true;
        d.error.hidden = true;
        try {
          const savedRecord = await saveRecording(lazyDb, record, d.input.value);
          finish({ action: 'save', saved: savedRecord });
        } catch (err) {
          console.error('Flight Console: the recording could not be saved', err);
          d.error.textContent = `This browser didn't store it (${err?.name || 'an error'}). Free up some space and press SAVE again.`;
          d.error.hidden = false;
        } finally {
          busy = false;
        }
      };
      const onSubmit = (e) => {
        e.preventDefault();
        if (!d.field.hidden) save();
      };
      const onCancel = (e) => {
        e.preventDefault();
        if (d.field.hidden) naming();
        else save();
      };
      const finish = (result) => {
        d.form.removeEventListener('submit', onSubmit);
        d.el.removeEventListener('cancel', onCancel);
        if (d.el.open) d.el.close();
        resolve(result);
      };
      d.form.addEventListener('submit', onSubmit);
      d.el.addEventListener('cancel', onCancel);
      d.input.value = defaultName(record.createdAt);
      d.error.hidden = true;
      naming();
      if (!d.el.open) d.el.showModal();
      d.input.focus();
      d.input.select();
    });
  }

  // ------------------------------------------------------------------
  // Recordings left behind
  // ------------------------------------------------------------------
  async function checkUnfinished() {
    try {
      unfinished = await findUnfinished(lazyDb, { except: recorder.record?.id ?? null });
    } catch (err) {
      console.warn('Flight Console: could not look for unfinished recordings', err);
      unfinished = [];
    }
    recoverAsking = false;
    drawRecover();
    watchBusy();
  }

  // A recording that a tab still holds isn't offered yet. That's another
  // tab still recording, or, after a reload, the old page that hasn't quite
  // let go. Each is looked at again as soon as its lock is free (without
  // Web Locks, once it has gone stale), and offered then if it was left
  // unfinished.
  const watching = new Set();
  async function watchBusy() {
    let busy;
    try {
      busy = await findBusy(lazyDb, { except: recorder.record?.id ?? null });
    } catch {
      return;
    }
    const locks = globalThis.navigator?.locks;
    for (const rec of busy) {
      if (watching.has(rec.id)) continue;
      watching.add(rec.id);
      const again = () => {
        watching.delete(rec.id);
        checkUnfinished();
      };
      if (locks?.request) locks.request(lockName(rec.id), () => {}).then(again, again);
      else setTimeout(again, STALE_MS + 1000);
    }
  }

  function drawRecover() {
    const rec = unfinished[0];
    els.recover.hidden = !rec;
    if (!rec) return;
    const ranS = Math.max(0, ((rec.updatedAt ?? rec.createdAt) - rec.createdAt) / 1000);
    const more = unfinished.length > 1 ? ` ${unfinished.length - 1} more after this one.` : '';
    if (recoverAsking) {
      els.recoverText.textContent = `Discard the recording from ${defaultName(rec.createdAt)} for good?`;
      setChildren(els.recoverActions,
        h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => discardUnfinished(rec) }, 'DISCARD'),
        h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => { recoverAsking = false; drawRecover(); } }, 'KEEP'));
    } else {
      els.recoverText.textContent = `It started ${defaultName(rec.createdAt)} and ran about ${formatDuration(ranS)} before the page closed.${more}`;
      setChildren(els.recoverActions,
        h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => recoverUnfinished(rec) }, 'RECOVER'),
        h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => { recoverAsking = true; drawRecover(); els.recoverActions.firstElementChild?.focus(); } }, 'DISCARD'));
    }
  }

  async function recoverUnfinished(rec) {
    const choice = await askName({ title: 'RECOVER THIS RECORDING', text: `It started ${defaultName(rec.createdAt)}. Give it a name, or keep the date and time.`, record: rec });
    if (choice.action === 'discard') {
      await lazyDb.deleteFlight(rec.id).catch(() => {});
    } else {
      await refresh();
      savedNote(choice.saved);
    }
    await checkUnfinished();
  }

  async function discardUnfinished(rec) {
    await lazyDb.deleteFlight(rec.id).catch(() => {});
    announce('The recording was discarded.');
    await checkUnfinished();
  }

  // ------------------------------------------------------------------
  // The status line for files and recordings
  // ------------------------------------------------------------------
  function fileNote(tag, text, kind = 'info', ...buttons) {
    els.fileNote.dataset.tag = tag;
    els.fileNote.dataset.kind = kind;
    els.fileTag.textContent = tag;
    setChildren(els.fileText, text);
    const old = els.fileNote.querySelectorAll('.fc-file-action');
    for (const b of old) b.remove();
    const close = els.fileNote.querySelector('.fc-status-close');
    for (const b of buttons) close.before(b);
    els.fileNote.hidden = false;
  }

  function hideFileNote() {
    els.fileNote.hidden = true;
    delete els.fileNote.dataset.tag;
  }

  function savedNote(record) {
    const open = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm fc-status-close fc-file-action', onclick: () => { hideFileNote(); navigate({ flight: record.id }); } }, 'OPEN');
    // The note's text is a live region, so screen readers hear it too.
    fileNote('SAVED', `"${record.title}" is in SAVED FLIGHTS, kept in this browser.`, 'info', open);
  }

  // ------------------------------------------------------------------
  // SAVED FLIGHTS
  // ------------------------------------------------------------------
  async function refresh() {
    try {
      saved = await listSaved(lazyDb);
    } catch (err) {
      console.warn('Flight Console: could not read the local flights', err);
      saved = [];
    }
    savedMenu.setLocal({
      flights: saved,
      persistent: db?.persistent ?? true,
      exports: exportsFor,
      onExport: exportFlight,
      onDelete: deleteFlight,
      onLoadFile: pickFile,
    });
  }

  async function exportFlight(id, kind) {
    const record = saved.find((r) => r.id === id) ?? await lazyDb.getFlight(id);
    if (!record) return;
    const data = await lazyDb.readLines(id);
    if (kind === 'raw') {
      download(rawLogText(record, data.lines), exportFileName(record, 'log'), 'text/plain;charset=utf-8');
    } else {
      const text = csvText(record, data);
      if (text) download(text, exportFileName(record, 'csv'), 'text/csv;charset=utf-8');
    }
  }

  async function deleteFlight(id) {
    const record = saved.find((r) => r.id === id);
    await lazyDb.deleteFlight(id);
    await refresh();
    announce(`Deleted "${record?.title ?? 'the flight'}".`);
    // The flight on screen was the one deleted: back to live.
    if (new URLSearchParams(window.location.search).get('flight') === id) {
      savedMenu.close({ focus: false });
      navigate({ track: true });
    }
  }

  function download(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ------------------------------------------------------------------
  // Loading a file
  // ------------------------------------------------------------------
  const picker = h('input', { type: 'file', class: 'fc-file-input', accept: '.log,.txt,.csv,text/plain,text/csv', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) loadFile(file);
  });
  document.body.append(picker);

  function pickFile() {
    savedMenu.close({ focus: false });
    picker.click();
  }

  let loading = false;
  async function loadFile(file, { more = 0 } = {}) {
    if (loading) return;
    loading = true;
    const name = file.name || 'the file';
    try {
      if (file.size > MAX_FILE_BYTES) {
        fileNote('FILE', `${name} is ${Math.round(file.size / 1048576)} MB, and the console only loads files up to ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`, 'warn');
        return;
      }
      fileNote('FILE', `Reading ${name}...`);
      let text;
      try {
        // Decoded by hand so a byte order mark stays (file.text() drops
        // it), and the file exports back exactly as it came in.
        text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await file.arrayBuffer());
      } catch (err) {
        console.warn('Flight Console: could not read the file', err);
        fileNote('FILE', `${name} couldn't be read. Try saving it again and loading the new copy.`, 'warn');
        return;
      }
      // Lets the "Reading" line show before the work starts.
      await new Promise((r) => setTimeout(r, 0));
      const result = readFlightFile(text, file.name);
      if (result.error) {
        fileNote('FILE', {
          empty: `${name} is empty.`,
          unknown: `${name} isn't a flight file the console can read. It takes a raw serial log from the board or the console's own CSV export.`,
          'no-data': `${name} is the right kind of file, but none of its lines have a reading the console can replay.`,
        }[result.error], 'warn');
        return;
      }
      try {
        await storeFile(lazyDb, result.record, result.lines);
      } catch (err) {
        console.error('Flight Console: could not store the file', err);
        fileNote('FILE', `${name} was read, but this browser didn't store it (${err?.name || 'an error'}).`, 'warn');
        return;
      }
      await refresh();
      const extra = more ? ` Only the first file was loaded, so drop the others one at a time.` : '';
      fileNote('FILE', `Loaded ${name}. It's in SAVED FLIGHTS as "${result.record.title}", kept in this browser.${extra}`);
      navigate({ flight: result.record.id });
    } finally {
      loading = false;
    }
  }

  // A file dropped anywhere on the page. A subtle overlay says DROP FLIGHT
  // FILE while one is dragged over.
  const overlay = h('div', { class: 'fc-drop', hidden: true, 'aria-hidden': 'true' }, h('p', { class: 'fc-drop-text' }, 'DROP FLIGHT FILE'));
  document.body.append(overlay);
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    overlay.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer.files ?? [])];
    if (files.length) loadFile(files[0], { more: files.length - 1 });
  });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  els.fileNote.querySelector('.fc-status-close')?.addEventListener('click', () => hideFileNote());
  dbReady.then((d) => {
    db = d;
    refresh();
    checkUnfinished();
  });
  showRec();

  return {
    wrapLink,
    // A LOCAL flight for main.js's openFlight(): { entry, load() }, or null.
    async find(id) {
      if (!isLocalId(id)) return null;
      return openLocalFlight(await dbReady, id);
    },
    // True when leaving the page loses nothing: every connection this visit
    // was recorded from start to end, into storage that lasts.
    coversLive: () => allRecorded && Boolean(db?.persistent) && (!recorder.active || !recorder.failing),
    // For tests: the recorder and storage.
    test: { recorder, db: lazyDb, refresh, checkUnfinished, loadFile },
    cleanName,
  };
}
