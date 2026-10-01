// rocket-bar.js
// One chip per rocket: color dot, name, phase, GPS fix status (in words, not
// only color) and how long ago its last packet arrived. Clicking a chip
// focuses that rocket. A chip flashes briefly when a rocket that isn't
// focused logs an event. Works with 1 rocket or 10: chips wrap on wide
// screens and scroll sideways on phones.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatAge } from '../geo.js';

export function createRocketBar(root, ctx) {
  const { store, config } = ctx;
  const bar = h('div', { class: 'fc-rocketbar', role: 'group', 'aria-label': 'Rockets in this flight' });
  setChildren(root, bar);
  const chips = new Map(); // rocketId -> { button, phase, fix, age }

  function buildChips(rockets) {
    chips.clear();
    setChildren(bar, rockets.map((rocket) => {
      const phase = h('span', {});
      const fix = h('span', {});
      const age = h('span', {});
      const button = h('button', {
        type: 'button',
        class: 'fc-chip',
        style: { '--chip': rocket.profile.color },
        onclick: () => store.focus(rocket.id),
        onanimationend: () => button.classList.remove('fc-chip--flash'),
      },
      h('span', { class: 'fc-dot', style: { '--dot': rocket.profile.color }, 'aria-hidden': 'true' }),
      h('span', {},
        h('span', { class: 'fc-chip-name' }, rocket.profile.name),
        h('span', { class: 'fc-chip-meta' }, phase, fix, age)));
      chips.set(rocket.id, { button, phase, fix, age });
      return button;
    }));
  }

  function render() {
    const rockets = store.getRockets();
    const ids = rockets.map((r) => `${r.id}:${r.profile.name}:${r.profile.color}`).join('|');
    if (bar.dataset.ids !== ids) {
      bar.dataset.ids = ids;
      buildChips(rockets);
    }
    if (!rockets.length) {
      setChildren(bar, h('p', { class: 'fc-wait' }, 'No rockets yet.'));
      bar.dataset.ids = '';
      return;
    }
    const focusedId = store.getFocusedId();
    for (const rocket of rockets) {
      const chip = chips.get(rocket.id);
      if (!chip) continue;
      const d = rocket.derived;
      chip.button.setAttribute('aria-pressed', String(rocket.id === focusedId));
      setText(chip.phase, d ? d.phaseLabel : 'No data yet');
      if (store.isSilent(rocket)) {
        // Quiet for longer than LINK_STALE_S: nothing it last said is current.
        setText(chip.fix, 'No recent packets');
        chip.fix.className = 'fc-fix-no';
      } else if (store.gpsIsQuiet(rocket)) {
        // GPS rows stopped while other rows still arrive: the fix state is unknown.
        setText(chip.fix, 'No recent GPS data');
        chip.fix.className = 'fc-fix-no';
      } else if (rocket.sensorGroups.has('gps')) {
        const good = store.hasFixNow(rocket);
        setText(chip.fix, good ? 'GPS fix' : 'No GPS fix');
        chip.fix.className = good ? 'fc-fix-ok' : 'fc-fix-no';
      } else {
        setText(chip.fix, '');
        chip.fix.className = '';
      }
      const age = store.ageOf(rocket.lastPacketT);
      setText(chip.age, age === null ? '' : `Last packet ${formatAge(age)}`);
    }
  }

  // Flash chips of rockets that aren't focused when they log an event.
  // Replays after a seek are quiet, so they never flash.
  function flash(change) {
    if (change.quiet || !change.newEvents?.length) return;
    const focusedId = store.getFocusedId();
    for (const e of change.newEvents) {
      if (e.rocketId === focusedId) continue;
      const chip = chips.get(String(e.rocketId));
      if (!chip) continue;
      chip.button.classList.remove('fc-chip--flash');
      void chip.button.offsetWidth; // restart the animation
      chip.button.classList.add('fc-chip--flash');
    }
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
    },
  };
}
