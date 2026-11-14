// icons.js
// The button icons the page shares, as SVG markup strings, and iconNode(),
// which turns markup from here or from markers.js into an element. The
// map's and the 3D view's markers (the board, the start point and the
// ground station's dish) are in markers.js.
// Used by: map-view.js. (The HUD, the timeline and panel 2 use bracket
// buttons with words instead of icons.)

// ------------------------------------------------------------------
// Button icons, 24 by 24, drawn in the text color (currentColor).
// ------------------------------------------------------------------
const UI = {
  play: '<path d="M8 5.5V18.5L18.5 12Z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5.5" width="3.8" height="13" rx="0.8" fill="currentColor"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="0.8" fill="currentColor"/>',
  replay: '<path d="M5.5 12A6.5 6.5 0 1 0 8 6.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.6 3.2V7.4H4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowLeft: '<path d="M19 12H5.5M11 6L5 12L11 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  link: '<path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.1 1.1M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.1-1.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5L10 17.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="M9 6L15 12L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

// name is one of the keys above. size is in px.
export function uiIcon(name, size = 18) {
  return `<svg class="fc-ui-ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${UI[name] ?? ''}</svg>`;
}

// Turns markup from this file or markers.js into an element, for views
// that build pages with h(). The markup is fixed, never built from data.
export function iconNode(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}
