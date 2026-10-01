// rocket-bar.js
// One chip per rocket, only for flights with two or more rockets (with one
// rocket the mount stays empty, so CSS hides it). Each chip shows the
// rocket's color dot, name, phase, GPS fix status (in words, not only
// color) and how long ago its last packet arrived. Clicking a chip focuses
// that rocket. A chip flashes briefly when a rocket that isn't focused logs
// an event (never on the quiet replay after a seek). With less motion the
// flash is a still outline that clears on its own.
// Chips share the row on wide screens and scroll sideways on phones.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler, prefersReducedMotion } from './dom.js';
import { formatAge } from '../geo.js';

// How long a flashed chip stays marked, in ms. Matches the CSS animation.
const FLASH_MS = 1400;

export function createRocketBar(root, ctx) {
  const { store, config } = ctx;
  const bar = h('div', { class: 'fc-rocketbar', role: 'group', 'aria-label': 'Rockets in this flight' });
  const chips = new Map(); // rocketId -> { button, phase, fix, age, timer }
  let shownFocusId = null;  // the focused rocket the bar last scrolled to

  function buildChips(rockets) {
    clearFlashes();
    chips.clear();
    shownFocusId = null;
    setChildren(bar, rockets.map((rocket) => {
      const phase = h('span', { class: 'fc-chip-phase' });
      const fix = h('span', {});
      const age = h('span', { class: 'fc-chip-age' });
      const button = h('button', {
        type: 'button',
        class: 'fc-chip',
        style: { '--chip': rocket.profile.color },
        onclick: () => store.focus(rocket.id),
        onanimationend: () => button.classList.remove('fc-chip--flash'),
      },
      h('span', { class: 'fc-chip-head' },
        h('span', { class: 'fc-dot', style: { '--dot': rocket.profile.color }, 'aria-hidden': 'true' }),
        h('span', { class: 'fc-chip-name' }, rocket.profile.name)),
      h('span', { class: 'fc-chip-meta' }, phase, fix, age));
      chips.set(rocket.id, { button, phase, fix, age, timer: null });
      return button;
    }));
  }

  function render() {
    const rockets = store.getRockets();
    // One rocket (or none): nothing to pick between, so the bar stays out.
    if (rockets.length < 2) {
      if (root.firstChild) {
        clearFlashes();
        chips.clear();
        bar.dataset.ids = '';
        root.replaceChildren();
      }
      return;
    }
    if (bar.parentNode !== root) setChildren(root, bar);
    const ids = rockets.map((r) => `${r.id}:${r.profile.name}:${r.profile.color}`).join('|');
    if (bar.dataset.ids !== ids) {
      bar.dataset.ids = ids;
      buildChips(rockets);
    }

    const focusedId = store.getFocusedId();
    if (focusedId !== shownFocusId && chips.has(focusedId)) {
      shownFocusId = focusedId;
      keepInView(chips.get(focusedId).button);
    }
    for (const rocket of rockets) {
      const chip = chips.get(rocket.id);
      if (!chip) continue;
      const d = rocket.derived;
      chip.button.setAttribute('aria-pressed', String(rocket.id === focusedId));
      setText(chip.phase, d ? d.phaseLabel : 'No data yet');
      let fixText = '';
      let fixClass = '';
      if (store.isSilent(rocket)) {
        // Quiet for longer than LINK_STALE_S: nothing it last said is current.
        fixText = 'No recent packets';
        fixClass = 'fc-chip-fix fc-chip-fix--no';
      } else if (store.gpsIsQuiet(rocket)) {
        // GPS rows stopped while other rows still arrive: the fix state is unknown.
        fixText = 'No recent GPS data';
        fixClass = 'fc-chip-fix fc-chip-fix--no';
      } else if (rocket.sensorGroups.has('gps')) {
        const good = store.hasFixNow(rocket);
        fixText = good ? 'GPS fix' : 'No GPS fix';
        fixClass = good ? 'fc-chip-fix fc-chip-fix--ok' : 'fc-chip-fix fc-chip-fix--no';
      }
      setText(chip.fix, fixText);
      if (chip.fix.className !== fixClass) chip.fix.className = fixClass;
      const age = store.ageOf(rocket.lastPacketT);
      setText(chip.age, age === null ? '' : `Last packet ${formatAge(age)}`);
    }
  }

  // On phones the chips scroll sideways: keep the focused one in view,
  // without moving the page up or down.
  function keepInView(button) {
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    const start = button.offsetLeft - 4;
    const end = button.offsetLeft + button.offsetWidth + 4 - bar.clientWidth;
    let left = null;
    if (start < bar.scrollLeft) left = start;
    else if (end > bar.scrollLeft) left = end;
    if (left !== null) bar.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }

  // Flash chips of rockets that aren't focused when they log an event.
  // Replays after a seek are quiet, so they never flash. The timer clears
  // the mark when there is no animation to end it (less motion).
  function flash(change) {
    if (change.quiet || !change.newEvents?.length) return;
    const focusedId = store.getFocusedId();
    for (const e of change.newEvents) {
      if (String(e.rocketId) === String(focusedId)) continue;
      const chip = chips.get(String(e.rocketId));
      if (!chip) continue;
      chip.button.classList.remove('fc-chip--flash');
      void chip.button.offsetWidth; // restart the animation
      chip.button.classList.add('fc-chip--flash');
      clearTimeout(chip.timer);
      chip.timer = setTimeout(() => chip.button.classList.remove('fc-chip--flash'), FLASH_MS);
    }
  }

  function clearFlashes() {
    for (const chip of chips.values()) clearTimeout(chip.timer);
  }

  const scheduler = createScheduler(render, { maxFps: config.ROCKET_BAR_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'rockets' || change.type === 'focus' || change.type === 'clear' || change.type === 'reset') scheduler.flush();
    else scheduler.schedule();
    flash(change);
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      clearFlashes();
    },
  };
}
