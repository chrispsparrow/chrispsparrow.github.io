// controls.js
// Playback controls under the map: play and pause (Replay at the end),
// the 1x, 5x and 20x speed buttons, a scrub bar with the recording time,
// and jump buttons for the focused rocket's events. The jump buttons come
// from a separate detector that pre-scanned the whole flight when it
// loaded. They only move the playback. They never put events in the log
// before the flight reaches them.
// Used by: main.js. Talks to the player and reads the store.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatClock } from '../geo.js';
import { FLIGHT_EVENT_TYPES, EVENT_LABELS } from '../detector.js';

export function createControls(root, ctx) {
  const { store, player, config } = ctx;

  const playButton = h('button', { type: 'button', class: 'fc-btn fc-btn-primary fc-play', onclick: onPlay }, 'Play');
  const speedButtons = player.getState().speeds.map((x) =>
    h('button', { type: 'button', class: 'fc-btn', 'aria-pressed': 'false', onclick: () => player.setSpeed(x) }, `${x}x`));
  const scrub = h('input', {
    type: 'range',
    class: 'fc-scrub',
    id: 'fc-scrub',
    min: '0',
    max: '1',
    step: 'any',
    value: '0',
    'aria-label': 'Position in the recording',
  });
  const time = h('span', { class: 'fc-time', 'aria-live': 'off' });
  const jumps = h('div', { class: 'fc-jumps', role: 'group', 'aria-label': 'Jump to an event' });

  setChildren(root, h('section', { class: 'fc-panel fc-controls', 'aria-label': 'Playback controls' },
    h('div', { class: 'fc-controls-row' },
      playButton,
      h('div', { class: 'fc-seg', role: 'group', 'aria-label': 'Playback speed' }, speedButtons)),
    h('div', { class: 'fc-controls-row' },
      h('div', { class: 'fc-scrub-wrap' }, scrub, time)),
    h('div', { class: 'fc-controls-row' }, jumps)));

  function onPlay() {
    const s = player.getState();
    if (s.ended) player.replay();
    else player.toggle();
  }

  // ------------------------------------------------------------------
  // Scrub bar: playback pauses while it is dragged, and each move seeks
  // (at most once per frame).
  // ------------------------------------------------------------------
  let dragging = false;
  let pendingSeek = null;
  const seekScheduler = createScheduler(() => {
    if (pendingSeek !== null) player.seek(pendingSeek);
    pendingSeek = null;
  }, { maxFps: config.SCRUB_SEEKS_PER_S });

  function startDrag() {
    if (dragging) return;
    dragging = true;
    player.beginScrub();
  }
  function endDrag() {
    if (!dragging) return;
    seekScheduler.flush();
    dragging = false;
    player.endScrub();
  }
  scrub.addEventListener('pointerdown', startDrag);
  scrub.addEventListener('input', () => {
    pendingSeek = Number(scrub.value);
    seekScheduler.schedule();
  });
  scrub.addEventListener('change', () => {
    pendingSeek = Number(scrub.value);
    seekScheduler.flush();
    endDrag();
  });
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);
  scrub.addEventListener('blur', endDrag);

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  function renderPlayer() {
    const s = player.getState();
    const hasData = s.sampleCount > 0;
    playButton.disabled = !hasData;
    setText(playButton, s.ended ? 'Replay' : s.playing ? 'Pause' : 'Play');
    speedButtons.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(s.speeds[i] === s.speed));
      b.disabled = !hasData;
    });
    scrub.disabled = !hasData;
    if (hasData) {
      if (scrub.min !== String(s.t0)) scrub.min = String(s.t0);
      if (scrub.max !== String(s.tEnd)) scrub.max = String(s.tEnd);
      if (!dragging) scrub.value = String(s.time);
      const elapsed = formatClock(s.time - s.t0);
      const total = formatClock(s.tEnd - s.t0);
      setText(time, `${elapsed} of ${total}`);
      scrub.setAttribute('aria-valuetext', `${elapsed} of ${total}`);
    } else {
      setText(time, 'No data');
    }
  }

  function renderJumps() {
    const rocket = store.getFocused();
    const prescan = rocket?.prescan ?? {};
    const found = FLIGHT_EVENT_TYPES.filter((type) => prescan[type]);
    const key = `${rocket?.id ?? ''}:${found.join(',')}`;
    if (jumps.dataset.key === key) return;
    jumps.dataset.key = key;
    if (!found.length) {
      setChildren(jumps, h('span', { class: 'fc-jumps-label' }, 'No events to jump to for this rocket.'));
      return;
    }
    setChildren(jumps,
      h('span', { class: 'fc-jumps-label' }, 'Jump to'),
      found.map((type) => {
        const e = prescan[type];
        return h('button', {
          type: 'button',
          class: 'fc-btn',
          onclick: () => player.seek(e.confirmedT ?? e.t),
        }, EVENT_LABELS[type]);
      }));
  }

  const playerScheduler = createScheduler(renderPlayer, { maxFps: config.CONTROLS_MAX_FPS });
  const unsubscribePlayer = player.subscribe(() => playerScheduler.schedule());
  const unsubscribeStore = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'rockets' || change.type === 'clear') renderJumps();
  });
  renderPlayer();
  renderJumps();

  return {
    destroy() {
      unsubscribePlayer();
      unsubscribeStore();
      playerScheduler.cancel();
      seekScheduler.cancel();
    },
  };
}
