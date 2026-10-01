// player.js
// The playback clock for recorded flights. It merges every rocket's samples
// into one time-ordered list and feeds them to the store as a simulated
// clock runs (real elapsed time x speed). Every sample is fed, in order, at
// every speed: a fast frame just feeds a bigger batch.
//
// Seeking resets the store and re-feeds every sample up to the new time, so
// the detectors and views end up exactly where they would have been.
//
// The store never depends on the player. A live source can feed the store
// directly and this file is simply not used.
//
// Used by: main.js (creates it), controls.js and mission-header.js (read its
// state and call play, pause, seek). No DOM, but it uses the browser's
// requestAnimationFrame when it exists.

import { PLAYBACK_SPEEDS, DEFAULT_SPEED, MAX_FRAME_STEP_S } from './config.js';

export function createPlayer({
  store,
  speeds = PLAYBACK_SPEEDS,
  defaultSpeed = DEFAULT_SPEED,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  clock = () => globalThis.performance.now(),
} = {}) {
  const listeners = new Set();
  let samples = [];
  let index = 0;          // next sample to feed
  let t0 = null;          // first sample time
  let tEnd = null;        // last sample time
  let time = null;        // current playback time (data seconds)
  let speed = defaultSpeed;
  let playing = false;
  let ended = false;
  let frameId = null;
  let lastFrameMs = null;
  let scrubbing = false;
  let playAfterScrub = false;
  let destroyed = false;

  // Loads a flight. `allSamples` can hold several rockets in any order.
  function load(allSamples) {
    stopFrames();
    samples = allSamples
      .filter((s) => s && Number.isFinite(s.t))
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.t - b.s.t || a.i - b.i) // stable: equal times keep file order
      .map((x) => x.s);
    t0 = samples.length ? samples[0].t : null;
    tEnd = samples.length ? samples[samples.length - 1].t : null;
    playing = false;
    ended = false;
    index = 0;
    time = t0;
    if (samples.length) feedUpTo(t0, { quiet: true });
    emit();
  }

  // Feeds every sample with t <= target, as one batch.
  function feedUpTo(target, { quiet = false } = {}) {
    const start = index;
    while (index < samples.length && samples[index].t <= target) index += 1;
    store.addSamples(samples.slice(start, index), { time: target, quiet });
  }

  function frame(ms) {
    frameId = null;
    if (!playing || destroyed) return;
    const stepS = lastFrameMs === null ? 0 : Math.min((ms - lastFrameMs) / 1000, MAX_FRAME_STEP_S);
    lastFrameMs = ms;
    time = Math.min(tEnd, time + stepS * speed);
    feedUpTo(time);
    if (time >= tEnd && index >= samples.length) {
      playing = false;
      ended = true;
      lastFrameMs = null;
    } else {
      frameId = requestFrame(frame);
    }
    emit();
  }

  function play() {
    if (!samples.length || playing || destroyed) return;
    if (ended) { seek(t0); }
    playing = true;
    ended = false;
    lastFrameMs = null;
    if (requestFrame) frameId = requestFrame(frame);
    emit();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    stopFrames();
    emit();
  }

  function toggle() {
    if (playing) pause(); else play();
  }

  function setSpeed(x) {
    if (!speeds.includes(x)) return;
    speed = x;
    emit();
  }

  // Jumps to data time t: reset the store and re-feed everything up to t.
  function seek(t) {
    if (!samples.length || !Number.isFinite(t)) return;
    const target = Math.max(t0, Math.min(tEnd, t));
    store.reset();
    index = 0;
    time = target;
    feedUpTo(target, { quiet: true });
    ended = target >= tEnd && index >= samples.length;
    if (ended && playing) {
      playing = false;
      stopFrames();
    }
    lastFrameMs = null;
    emit();
  }

  // Starts over from the first sample and plays.
  function replay() {
    seek(t0);
    ended = false;
    play();
  }

  // The scrub bar pauses playback while it is being dragged.
  function beginScrub() {
    if (scrubbing) return;
    scrubbing = true;
    playAfterScrub = playing;
    pause();
    emit();
  }

  function endScrub() {
    if (!scrubbing) return;
    scrubbing = false;
    if (playAfterScrub && !ended) play();
    playAfterScrub = false;
    emit();
  }

  function stopFrames() {
    if (frameId !== null && cancelFrame) cancelFrame(frameId);
    frameId = null;
    lastFrameMs = null;
  }

  function getState() {
    return { playing, speed, speeds, time, t0, tEnd, ended, scrubbing, sampleCount: samples.length, fed: index };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit() {
    const state = getState();
    for (const listener of [...listeners]) {
      try { listener(state); } catch (err) { console.error('Flight Console player listener error:', err); }
    }
  }

  function destroy() {
    destroyed = true;
    playing = false;
    stopFrames();
    listeners.clear();
    samples = [];
  }

  return { load, play, pause, toggle, setSpeed, seek, replay, beginScrub, endScrub, getState, subscribe, destroy };
}
