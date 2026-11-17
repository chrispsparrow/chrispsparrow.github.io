// map-controls.js
// The map's controls row on Track a Rocket, as plain page elements with no
// behavior yet: [ SATELLITE ] [ DARK MAP ] [ 3D ], [x] FOLLOW BOARD, the
// KEY's toggle, and the camera group ([ WHOLE FLIGHT ] [ RESET VIEW ]),
// hidden at first.
//
// map-view.js builds the real row with it and wires it up. globe-poster.js
// builds a copy while the page's code is still downloading, only to measure
// the room the row takes along the bottom of the 3D view, so the globe's
// poster lands exactly where the Earth will be. Both use this one function,
// so the copy always matches the real row.
//
// Used by: map-view.js and globe-poster.js. No imports.

export function buildMapControls() {
  const make = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') el.className = value;
      else if (key === 'hidden') el.hidden = Boolean(value);
      else if (key === 'checked') el.checked = Boolean(value);
      else el.setAttribute(key, value);
    }
    el.append(...children);
    return el;
  };
  const button = (text, pressable = true) => make('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', ...(pressable ? { 'aria-pressed': 'false' } : {}) }, text);

  // Satellite and Dark map are the two map backgrounds, and 3D swaps the
  // map for the 3D view.
  const satelliteBtn = button('SATELLITE');
  const darkBtn = button('DARK MAP');
  const threeBtn = button('3D');
  const viewPick = make('div', { class: 'fc-map-ctl-group', role: 'group', 'aria-label': 'Map view' }, satelliteBtn, darkBtn, threeBtn);
  // FOLLOW BOARD: one setting for both views.
  const followBox = make('input', { type: 'checkbox', checked: true });
  const followLabel = make('label', { class: 'fc-bkt-check' }, followBox, make('span', {}, 'FOLLOW BOARD'));
  // The KEY: map-view.js puts the legend in the box, after the toggle.
  const keyToggle = make('summary', { class: 'fc-bkt fc-bkt--sm fc-map-key-toggle' }, 'KEY');
  const keyBox = make('details', { class: 'fc-map-key' }, keyToggle);
  // The camera buttons, only while a saved flight is on screen.
  const wholeBtn = button('WHOLE FLIGHT');
  const resetBtn = button('RESET VIEW', false);
  const cameraPick = make('div', { class: 'fc-map-ctl-group', role: 'group', 'aria-label': 'Camera', hidden: true }, wholeBtn, resetBtn);

  const controls = make('div', { class: 'fc-map-ctl' }, viewPick, followLabel, keyBox, cameraPick);
  return { controls, viewPick, satelliteBtn, darkBtn, threeBtn, followBox, followLabel, keyBox, keyToggle, cameraPick, wholeBtn, resetBtn };
}
