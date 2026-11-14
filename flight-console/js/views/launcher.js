// launcher.js
// The landing at /flight-console/ (no ?track or ?flight= in the address).
//
//   createLanding(root)
//     index.html holds all of the landing's text: the title and the two
//     buttons. This does two things to it:
//       - types the title out letter by letter, then leaves the blinking
//         "_" cursor after it. With reduced motion the whole title shows
//         at once (and the cursor doesn't blink, see the theme's CSS).
//       - starts the moving ocean currents with the two hidden tuna behind
//         the hero (hero-currents.js). They pause by themselves while the
//         landing is hidden, the tab is in the background or the hero is
//         scrolled away, and show one still frame with reduced motion.
//     Returns { destroy() }, which stops both.
//
// main.js calls createLanding() only the first time the landing shows, so
// the title types once per page load and not again each time the visitor
// comes back from the console inside the page.
//
// The saved flights live in the console's SAVED FLIGHTS dropdown
// (saved-menu.js). Used by: main.js.

import { startCurrents } from '../hero-currents.js?v=3';

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------

const TYPE_START_MS = 300;   // the wait before the first letter
const TYPE_LETTER_MS = 85;   // the time between letters
const FONT_WAIT_MS = 800;    // typing waits this long at most for the title's font

// ------------------------------------------------------------------
// Landing
// ------------------------------------------------------------------

// root is the landing <section>.
export function createLanding(root) {
  const canvas = root.querySelector('.fc-hero-water-canvas');
  const textBox = root.querySelector('.fc-hero-stack');
  const stopTyping = typeTitle(root.querySelector('.fc-hero-title'));
  // Started once and left running: it stops drawing on its own whenever
  // there is nothing to see. A real-data currents animation could take its
  // place later by exporting the same start function shape.
  let stopCurrents = null;
  try {
    stopCurrents = canvas ? startCurrents(canvas, { textBox }) : null;
  } catch (err) {
    // A background that fails must never take the page down. The hero is
    // then the title and the buttons on the plain near-black page.
    console.error('Flight Console: the hero background failed to start', err);
  }
  return {
    destroy() {
      stopTyping();
      stopCurrents?.();
      stopCurrents = null;
    },
  };
}

// ------------------------------------------------------------------
// The typed title
// ------------------------------------------------------------------

// The title's HTML is
//   <h1 aria-label="FLIGHT CONSOLE"><span class="fc-hero-typed">FLIGHT CONSOLE</span>
//     <span class="fc-cursor">_</span><span class="fc-hero-rest"></span></h1>
// with the three spans hidden from screen readers, which read the label
// once. Typing moves the letters one at a time from the rest span (which
// the CSS keeps invisible but still as wide as its letters) to the typed
// span, so the title is its full width from the start and nothing moves.
// The cursor sits between them, so it follows the letters. While it types
// the cursor holds still (the is-typing class), and blinks once it's done.
// Returns a function that stops the typing and shows the whole title.
function typeTitle(title) {
  const typed = title?.querySelector('.fc-hero-typed');
  const rest = title?.querySelector('.fc-hero-rest');
  if (!typed || !rest) return () => {};
  const text = title.getAttribute('aria-label') || typed.textContent;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (still) return () => {};

  let shown = 0;
  let timer = 0;
  let done = false;
  const render = () => {
    typed.textContent = text.slice(0, shown);
    rest.textContent = text.slice(shown);
  };
  const finish = () => {
    done = true;
    clearTimeout(timer);
    shown = text.length;
    render();
    title.classList.remove('is-typing');
  };
  const next = () => {
    if (done) return;
    shown += 1;
    render();
    if (shown >= text.length) finish();
    else timer = setTimeout(next, TYPE_LETTER_MS);
  };

  render();
  title.classList.add('is-typing');
  // Start once the fonts that are loading are in (or after FONT_WAIT_MS),
  // so the letters don't change shape halfway through.
  const fontsIn = document.fonts?.ready ?? Promise.resolve();
  Promise.race([fontsIn, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))])
    .catch(() => {})
    .then(() => {
      if (!done) timer = setTimeout(next, TYPE_START_MS);
    });
  return finish;
}
