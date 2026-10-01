// fleet.js
// Who each rocket is: its ID, display name, map label name (callsign), color
// and board description.
// A flight's manifest entry registers its rockets in order, so the first
// rocket always gets the first palette color. A rocket ID nobody registered
// (for example a new board heard live) is added automatically with the next
// palette color and a plain name, so no sample is ever dropped.
// Used by: store.js (every rocket gets a profile), main.js and add_flight.mjs.
// No DOM.

import { ROCKET_PALETTE } from './config.js';

// Boards I know about. Their details fill in anything a manifest leaves out,
// and they name rockets heard live before any manifest exists. The ID is the
// node ID the firmware sends (Config::kNodeId). callsign is the name on the
// rocket's label on the map, in capitals. It is only used while the rocket
// keeps this board's name, so a different board that also sends node ID 1
// (every board does until it gets its own number) isn't labeled as mine.
export const KNOWN_ROCKETS = Object.freeze([
  Object.freeze({ id: '1', name: 'GPS and radio board', callsign: 'DOGTOOTH GPS RADIO', board: 'SAMD21, SAM-M8Q GPS and E22 LoRa radio' }),
]);

// The map label name: the known board's callsign while the rocket keeps that
// board's name, otherwise its display name in capitals.
function callsignFor(name, knownProfile) {
  if (knownProfile?.callsign && name === knownProfile.name) return knownProfile.callsign;
  return name.toUpperCase();
}

export function createFleet(known = KNOWN_ROCKETS) {
  const knownById = new Map(known.map((k) => [String(k.id), k]));
  const profiles = new Map();
  let nextColor = 0;

  function takeColor() {
    const color = ROCKET_PALETTE[nextColor % ROCKET_PALETTE.length];
    nextColor += 1;
    return color;
  }

  // Adds a rocket, or updates the details of one already added. Fields left
  // out (or null) keep what is already known.
  function register({ id, name, board, color } = {}) {
    const key = String(id);
    const existing = profiles.get(key) ?? knownById.get(key) ?? {};
    const finalName = name || existing.name || `Rocket ${key}`;
    const profile = Object.freeze({
      id: key,
      name: finalName,
      callsign: callsignFor(finalName, knownById.get(key)),
      board: board || existing.board || null,
      color: color || existing.color || takeColor(),
      auto: false,
    });
    profiles.set(key, profile);
    return profile;
  }

  // The profile for an ID, creating one if this ID is new.
  function get(id) {
    const key = String(id);
    const found = profiles.get(key);
    if (found) return found;
    const knownProfile = knownById.get(key);
    const name = knownProfile?.name ?? `Rocket ${key}`;
    const profile = Object.freeze({
      id: key,
      name,
      callsign: callsignFor(name, knownProfile),
      board: knownProfile?.board ?? null,
      color: takeColor(),
      auto: !knownProfile,
    });
    profiles.set(key, profile);
    return profile;
  }

  function list() {
    return [...profiles.values()];
  }

  function reset() {
    profiles.clear();
    nextColor = 0;
  }

  return { register, get, list, reset };
}
