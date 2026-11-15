# Flight Console

The Flight Console is the part of my site for watching my rocket avionics. It has three pages. The hero at `/flight-console/` is the way in. Track a Rocket (`/flight-console/?track`) is the console itself. Plug a Dogtooth board into the computer over USB and it shows the board's position in 3D with a HUD over it, plus the board's readings and graphs. It also plays back saved flights from the telemetry my boards send. Later it will track live flights through my Manta ground station. How it works (`/projects/flight-console.html`) explains the whole system with a scroll tour.

The Bench Console used to be its own page. It is now part of Track a Rocket (see "The live console"), and its old address sends visitors here.

This guide explains every file, how the data moves through the page, how to add a flight, how to test, and what each setting means.

## Trying it on my computer

The page loads its data with `fetch`, which browsers block for files opened straight from disk. So it needs a small local web server:

1. Open a terminal in the website folder (the one with the site's `index.html`).
2. Run `python -m http.server 8000`.
3. Open http://localhost:8000/flight-console/ in a browser.

The satellite map works at exactly http://localhost:8000, because that address is on the Esri key's list. On 127.0.0.1 or any other port, Esri turns the key down and the map shows the dark map instead, with a note. The dark map needs my local CARTO key on this computer (see "Map keys" below). Without it, everything else works and the dark map draws on a plain background.

The 3D view works at http://localhost:8000 and at http://127.0.0.1:8000, the two local addresses on the Cesium ion token's list. On any other port, ion turns the token down and the 3D view shows a flat, plain ground with a note.

The live console needs the Web Serial API, so it only connects in Chrome and Edge on a desktop or laptop. Web Serial also only works on a secure page, and localhost counts as one.

On the live site the same page is at https://www.dogtoothsystems.com/flight-console/.

## The three screens

`js/main.js` reads the address bar and shows one of three screens.

- `/flight-console/` with nothing after it is the landing: one full-screen hero, nothing else. It downloads no flight data and never loads CesiumJS.
- `/flight-console/?track` is Track a Rocket, live. The CONNECT button opens the board's serial port, and the SAVED FLIGHTS dropdown in the same bar lists the saved flights. `?track#fc-saved` opens the console with that dropdown open and keyboard focus on its button. Nothing on the site links there now, but the address still works.
- `/flight-console/?flight=gps-board-sim-01` is Track a Rocket, playing that saved flight. While it loads, the console stays up, the globe stays on screen and the bar says LOADING (see "The stage and the store switch").
- If the flight id isn't in the library, or the library or the flight's data didn't load, it shows a short message with a BACK TO THE CONSOLE button (and TRY AGAIN when it looks like a connection problem). The message says whether it looks like a connection problem or a missing or damaged file on the site.
- Until `main.js` starts, the page says "Loading the Flight Console...". If the page's own code fails to download, or is still missing after 15 s, a small script in `index.html` says so instead of leaving the page empty.

Links inside the page (TRACK A ROCKET on the landing, ← FLIGHT CONSOLE in the bar, the lines in SAVED FLIGHTS, CLOSE on a replay's name, BACK TO THE CONSOLE) change the address with `history.pushState`, so no page reload happens. A middle click or Ctrl+click still opens a new tab, since every link has a real address. When the browser's back or forward button changes the address, the browser fires a `popstate` event and `main.js` runs the same check again. After every switch inside the page, keyboard focus moves to the new screen's main heading.

Page titles: "Flight Console | Dogtooth Systems" on the landing, and "Track a Rocket | Dogtooth Systems" on the live console and on every replay.

## The look: colors and fonts

All three pages share one theme, `../css/flight-console-theme.css`. Each page gives its `<body>` the class `fc-theme`. The look is a thermal camera: a near-black background, white text and one amber accent for hover, active states and warnings. The site's own colors don't apply here.

The palette is four colors, as CSS variables:

- `--fc-black` (#07060D), the page background.
- `--fc-white` (#FFFFFF), the text.
- `--fc-offwhite` (#E8EDF2), quieter text and thin outlines on markers.
- `--fc-amber` (#F9A23A), hover, active states and warnings.

The theme also mixes a few shades from them (`--fc-text-dim`, `--fc-line`, `--fc-line-strong` and others) and holds the thermal "ironbow" ramp, `--fc-ramp-0` to `--fc-ramp-6`, from near-black through purple and red to pale yellow. The hero's currents use the ramp, and the map's speed colors use a lifted version of it (see "The breadcrumb trail"). Scripts that draw on a canvas or in Cesium can't read CSS variables, so they keep their own copies of the few colors they draw with: `COLOR_WHITE`, `HALO_COLOR` (the near-black), `PAD_COLOR` (the off-white) and `THERMAL_RAMP` in `js/config.js`, `SPEED_RAMP` in `js/hero-currents.js` and `TRACK_RAMP` in `js/track.js`. The one color outside the palette is the Dogtooth board marker's blue, #184590 (`BOARD_BLUE` in `js/views/markers.js`).

Two fonts, from Google Fonts, loaded without holding up the page:

- Share Tech Mono (`--fc-font-mono`) for titles, labels, buttons and readouts, mostly in capitals.
- Barlow Condensed (`--fc-font-sentence`) for longer sentences.

On Track a Rocket, Barlow Condensed only reaches real sentences, and each one is picked by its class: the message screen, the status lines under the bar, the notes in SAVED FLIGHTS, the MORE column's notes, the map's notes, and panel 2's notes written as full sentences (like the parser's notes and the "no events yet" line). Everything else is Share Tech Mono, including the HUD's clock, the timeline's tooltip, the mission timeline's events and the board's errors.

Funnel Sans and Space Grotesk are only for the site's own nav and footer. Space Mono is not loaded on these pages.

The theme also has the small shared pieces every page can use:

- `.fc-bkt`, a bracket button like `[ TRACK A ROCKET ]`. No box. White, and amber on hover, keyboard focus or when it is the one that is on. `.fc-bkt--sm` is the smaller one for rows of controls. The brackets are drawn by CSS, so the HTML holds just the words.
- `.fc-bkt-check`, a real checkbox drawn as brackets, like `[x] FOLLOW BOARD`.
- `.fc-back`, the "← FLIGHT CONSOLE" link back to the hero.
- `.fc-cursor`, the blinking `_` after typed text. It only blinks when the viewer hasn't asked for less motion.

It also styles the site nav (see-through, with a soft fade once the page scrolls) and the footer for these pages.

### The stylesheets and who owns what

Track a Rocket and the hero are one page, `index.html`, with four stylesheets of its own, loaded in this order after the theme:

- `flight-console.css`: the tokens that give the theme's colors jobs (`--fc-bg`, `--fc-text`, `--fc-warn`, `--fc-text-outline` and the rest, plus the `--bc-*` names the live panel and the graphs read), then Track a Rocket's frame (the bar, the status lines, the two panels and the switches between them) and everything over the map in panel 1: the overlay grid, the HUD, the phase bar, the rocket chips and the altitude timeline. It also has the layouts for narrow, short and phone-sized windows.
- `flight-console-hero.css`: the landing's hero.
- `flight-console-map.css`: the map and 3D view, the controls row inside `#fc-map-controls`, the KEY, the labels, the markers, the scale bar, the credits and the map's notes. Where the controls row sits is up to `flight-console.css`.
- `flight-console-data.css`: panel 2, the graphs and readings, live and in a replay.

Everything in them is scoped under `.fc-page` (the page's `<body>` class), so none of it can leak into the rest of the site. The How it works page has its own file, `../css/flight-console-overview.css`, scoped under `body.fco`.

Every animation in these files runs only inside `@media (prefers-reduced-motion: no-preference)`, or after a script checks that setting. The still version is the default.

## The landing

The landing is one full-screen hero, and its text is all in `index.html`. Made-up ocean currents move behind it in the style of earth.nullschool.net, colored like a thermal camera. In the middle sit the title and two bracket buttons.

**The title.** `js/views/launcher.js` types FLIGHT CONSOLE out letter by letter, then the blinking `_` cursor stays after it. It waits for the fonts (800 ms at most) and then 300 ms before the first letter, with 85 ms between letters (`TYPE_START_MS`, `TYPE_LETTER_MS` and `FONT_WAIT_MS` at the top of the file). The `<h1>` has `aria-label="FLIGHT CONSOLE"`, and the letters and cursor are hidden from screen readers. An invisible "rest" span holds the letters still to come, so the title keeps its full width while it types. It types once per page load, since `main.js` only calls `createLanding()` the first time the landing shows. With reduced motion the whole title shows at once and the cursor doesn't blink.

**The buttons.** `[ TRACK A ROCKET ]` goes to `./?track`, and `main.js` opens the console in place for it (`data-fc-nav="track"`). `[ HOW IT WORKS ]` goes to `../projects/flight-console.html`. They are the theme's `.fc-bkt` buttons, side by side, and stacked under 360 px wide.

**The currents.** `js/hero-currents.js` draws them on Canvas 2D. The page only calls `startCurrents(canvas, { textBox })`, which returns `stop()`.

- The flow comes from a stream function on a grid: three layers of smooth noise at different sizes, turned down in calm patches, plus two meandering jets and a few drifting eddies. The water moves along its lines, so it never piles up anywhere. A new grid is built every 0.3 s of motion, a few rows per frame, and the streaks read a blend of two.
- Thousands of warm white streaks ride it over a soft speed color on the seven-stop ironbow ramp.
- A soft dark patch behind the title and buttons keeps them readable.
- The nav is see-through and sits over the top of the water, so the water right behind it is drawn dimmer, easing back to full strength a little below the nav. The bottom edge of the hero fades the same way. The settings are `NAV_FADE_START` and the lines under it.
- The settings worth changing are in the CONFIG block at the top of the file: `SPEED`, `PARTICLE_COUNT`, `TRAIL_FADE`, `SPEED_RAMP`, `CENTER_DIM`, `FISH_VISIBILITY` and `DRIFT_SPEED`, each with a plain comment.

**The two tuna.** Two tuna from the Dogtooth logo swim in the water, both facing right. The big one starts top right and swims in the space between the nav and the title. The small one starts bottom left and swims below the buttons, a little slower. The big one takes 48 seconds to cross the window (`DRIFT_SPEED`), and the small one swims at 0.85 of that speed (`SMALL_FISH_DRIFT`). They bob slightly and wrap from the right edge to the left. They are camouflaged, with no fill and no outline, and the speed colors under a fish are the ocean's:

- The script builds an "anatomy field" once from the logo's path in `01_primary_full_logo_kicad_white_tuna.svg`, mirrored so the fish faces right. Every line in the logo (the outline, the gill arc, the mouth, the stripe and the fins) gives its direction, and those directions are spread over the whole body.
- For each fish size it traces flow lines through that field, about one streak gap apart (`traceFishLines()`). They all run nose to tail, or downward where they cross the fish, as on the gill arc. A few arms wind in to the eye like water going down a drain.
- The ocean's water is never changed. Each fish has its own streaks, which run along its lines and never leave it. Where a fish is, the ocean's streaks are drawn fainter and the fish's brighter by the same amount, so the light stays the same and the edge fades softly. The fish's streaks take their speed and opacity from the ocean right where they are.
- Since the fish's streaks never meet the ocean's water, nothing piles up into bright seams, and every streak inside a fish runs the same way. So a fish only shows as a change in which way the streaks run.

`FISH_VISIBILITY` goes from 0 to 1, and the default is 0.6:

- At 0 there are no fish at all. The tuna's outline isn't even downloaded.
- Up to 0.4 the fish's streaks take over from the ocean's inside the fish (`FISH_SWAP_GAIN`).
- From 0.3 up (`FISH_BOOST_FROM`), the streaks gather onto the flow lines and keep a little speed in calm water. Near 1 the edge gets sharper and there are more of them.
- At 1 the two tuna are plain to see, drawn like the logo's own linework.
- At 0.6, someone who knows to look finds both after a few seconds, and a glance doesn't.
- Phones add `PHONE_FISH_VISIBILITY` (0.1) on top, never going past 1, since their fish are smaller and have fewer streaks.

**Keeping it light.** It runs at most about 60 frames a second on a computer. Phones (a touch-only pointer or a window under 640 px wide) get fewer streaks, at most 30 frames a second and a coarser fish grid. If the first second runs slow, the streak count is cut to fit, and it checks once more a second later. It pauses while the tab is hidden, the landing isn't showing or the hero is scrolled away. With reduced motion it draws one still frame with the fish at their starting places. The fish field takes the most work, so it is built once, in short slices spread over several tasks, and the page keeps answering clicks and keys meanwhile. The fish's flow lines are traced again when the window changes size (10 to 15 ms a fish), and moving the fish's streaks costs about as much as a few hundred more ocean streaks. Until the field is ready, or 1.5 s pass (`FISH_WAIT_MS`), the hero is plain near-black, so the first frame already has the fish in it. If the tuna's outline never loads, the water runs without the fish.

**For tests.** `startCurrents` also takes `fishVisibility` (in place of `FISH_VISIBILITY`), `seed`, `time` (seconds of motion to start from), `still` (draw one still frame at that time and stop) and `onFrame` (called after every frame with `{ frame, ms, particles, width, height, dpr, still, cut, fish }`). With `time` and `still`, a test can compare two visibilities at the same moment of the swim. `buildFishField(d)` and `traceFishLines(field, w, margin, gap)` are exported, so the anatomy field and the flow lines can be checked in Node.

Without JavaScript, the hero is the title and the buttons on the plain near-black page.

`js/views/launcher.js` is the only thing that uses `hero-currents.js`. `createLanding(root)` returns `{ destroy() }`, which stops the typing and the currents. A real-data currents animation could replace the made-up one later, as long as it exports the same shape: a start function that takes the canvas and an options object and returns a stop function.

## Track a Rocket: the bar, the panels and the states

The console (`<section id="fc-console">` in `index.html`) fills the window under the site's nav, and the page never scrolls. The site footer hides while it is up (`main.js` sets `data-fc-screen` on the `<body>`, and the CSS reads it). Top to bottom:

- **The bar.** `← FLIGHT CONSOLE`, `[ CONNECT ]`, the replay's name while one is open, and `[ SAVED FLIGHTS ]` on the right. All are bracket buttons in Share Tech Mono, white and turning amber on hover.
  - CONNECT shows the link on itself. It says CONNECTING while the port picker is open and the port opens, DISCONNECT while connected, and DISCONNECTING. While the link is open, a small square inside the brackets is filled amber while the board's status blocks arrive on time, and is an empty amber outline when one is 3 s late. It blinks while the link is busy. A line only screen readers hear says the same in words ("Connected at 115,200 baud"). Pressed during a replay, CONNECT goes back to live first and opens the port picker right away.
  - While a replay is open the bar shows the flight's name, a blinking LOADING while its data downloads, and `[ CLOSE ]` to go back to live. The word "Replay" before the name is only for screen readers.
  - SAVED FLIGHTS opens its list under the button (see "Saved flights and replays").
- **Status lines**, under the bar, only while one has something to say. They are plain text, each with a `[ HIDE ]` button: a note about the link ("No port was picked, so nothing changed.", "The board was unplugged..."), NO SERIAL PORTS (only after CONNECT is pressed in a browser without Web Serial), and NOT RECOGNIZED for data the console doesn't know, with `[ RAW OUTPUT ]`, which opens the raw output in panel 2. On a phone the raw output sits below the graphs, so `revealInPanel()` in `main.js` scrolls panel 2 up or down to show it. It never scrolls sideways, which used to leave a blank screen while panel 2 was still sliding in.
- **Two panels**, side by side in one sliding track, like the pages of a monitor (`js/views/panels.js`). One is on screen at a time:
  - **Panel 1, the 3D view**, in every mode, with the HUD, the phase bar, the map's controls and (in a replay) the altitude timeline over it.
  - **Panel 2, graphs and readings** (see "Panel 2: graphs and readings").

  `[ GRAPHS ]` at the right edge of the 3D view and `[ MAP ]` at the left edge of panel 2 switch the panels. They are the theme's bracket buttons with the HUD's outline, written along the edge like the tabs of a monitor (GRAPHS reads top to bottom, MAP bottom to top), so they fit in the strip each panel keeps free for them (`--fc-tab-w`). Only the one toward the other panel shows. The left and right arrow keys switch them too, except while keyboard focus is in something that uses those keys itself: the 3D view (its camera), a graph (it picks a time), the altitude timeline, the SAVED FLIGHTS dropdown, a form field, or anything that scrolls sideways. The panel off screen is inert, so the keyboard and screen readers skip it. The panels slide, except for viewers who ask for less motion. Only that slide moves the panel track. A script or the browser (scrolling something into view, or find in page) could also scroll it sideways and leave the panels out of line with the window, so `panels.js` puts any sideways scroll straight back. `data-panel` on the console (`globe` or `data`) says which panel is on screen.

### data-mode and data-state

Two attributes on `#fc-console` tell the CSS what to show.

`data-mode` is which source is on screen:

- `idle`: nothing found on the serial link yet.
- `bench`: a Dogtooth board's status block came in over USB.
- `flight`: a flight source, like the Manta ground station. Nothing makes this mode yet. It goes by the source's `mode` in `main.js`, so a future source with `mode: 'flight'` just works.
- `replay`: a saved flight.

Panel 2 uses it to pick the live parts or the replay's parts.

`data-state` is where the flight is: `idle`, `pad`, `flight` or `recovery`. There are no buttons for it. It is worked out from the data alone by `flightState()` in `js/flight-state.js`. The HUD works it out on every draw and hands it to `main.js` (`ctx.onState`), which sets the attribute, so the page and the HUD always agree.

- `idle`: nothing connected or loaded. Only the globe and the map's controls show.
- `pad`: a board is connected, or data is coming in, and there is no liftoff yet. Only the top left of the HUD (PAD, the labels and the pad checklist) and the phase bar show.
- `flight`: liftoff was detected. The full HUD shows.
- `recovery`: the landing was detected. The full HUD shows, plus the recovery block. On phones ALT, VS and GS step aside for the recovery block, and `[ MORE ]` moves down next to GPS, HDOP and PKT, so MORE still works after the landing.

The states follow the detector (see "Detection"), so a board on a desk that wanders tens of meters never leaves `pad`. Going quiet never changes the state. A board that stops sending in flight stays in `flight` (the HUD marks the packets as old), and one that landed stays in `recovery`, so the recovery position is still there after the link is unplugged. A replay goes through pad, flight and recovery as it plays, and back again when the viewer seeks, because a seek feeds the store again from the start. A board restart starts over on the pad. Liftoff and the landing are read out to screen readers, unless they came from a seek.

### The pad checklist

In `pad`, the top left of the HUD shows four lines with dot leaders, from `padChecklist()` in `js/flight-state.js`. Each line is white when it is good and amber when it isn't:

- GPS LOCK: good with a GPS fix and at least `PAD_READY_MIN_SATS` (6) satellites. It reads like `12 SAT`, `NO FIX` or `NO FIX, 4 SAT`.
- HDOP: good at or under `PAD_READY_MAX_HDOP` (3).
- LINK: good while packets arrive at `PAD_READY_MIN_PKT_PER_S` (0.5 a second) or better, averaged over `PAD_LINK_WINDOW_S` (10 s). It reads like `1 PKT/S`, or `NO PACKETS, 12 S` once they stop.
- STATUS: READY when the three above are good, HOLD otherwise.

### The recovery block

In `recovery`, the top left shows LAST FIX (how old the newest good fix is, amber once it is older than `LINK_STALE_S`), DISTANCE and BEARING to the recovery position, and two buttons. `[ COPY COORDINATES ]` copies the position and shows COPIED, or shows the coordinates selected in a field to copy by hand when the browser blocks copying. `[ OPEN IN MAPS ]` opens Google Maps at the position. Distance and bearing are measured from Manta when the store has a ground station, and from the launch point when it doesn't. The words come ready from `recoveryInfo()` in `js/flight-state.js`. On phones this block takes the whole width.

### The HUD

`js/views/hud.js` draws the HUD over the 3D view, drone-camera style: Share Tech Mono straight on the picture, with no boxes. It fills four blocks, each a child of the overlay grid.

How it stays readable over bright ground:

- The values are white. Labels, units, the small lines under the clock, the line under ALT, the checklist's dot leaders and the timeline's labels are off-white (`--fc-hud-2` in `flight-console.css`). Only a phase that hasn't come yet is a little quieter (`--fc-hud-later`). The HUD shows what matters most with size, never with grey.
- Every letter has a thin black outline (`--fc-text-outline`): 1 px on all eight sides, plus a soft dark glow, so thin letters don't break up.
- Soft dark fades sit behind the two top corners and along the bottom, a little darker in the bottom left corner behind GPS, HDOP and PKT. They show once there is something to read (not in `idle`).
- The top left block and the open MORE column each have their own soft fade, a blurred dark patch a little bigger than the block, so it has no edge.

The four blocks:

- **Top left**: the flight time and the phase on one line (`T+0:56  DROGUE`), then small honest labels: SIMULATED FLIGHT or REAL FLIGHT in a replay, LIVE DATA live, plus LIFTOFF TIME ESTIMATED, DATA STARTS IN FLIGHT and GROUND LEVEL ESTIMATED when they apply. Under them goes the pad checklist or the recovery block. In `pad` there is no clock, only PAD.
- **Top right**: ALT in meters AGL (the largest number on the screen, with `M AGL` and the feet or the age of an old reading under it), VS with ▲ or ▼, GS, and `[ MORE ]`.
- **MORE**: every reading, as a column under the top right block that scrolls inside itself. It has the position (latitude, longitude, ALT MSL, LAST FIX and the distance and bearing from Manta, marked as the demo spot when it is the demo position), an altitude section (the highest so far, where the altitude comes from, the last reading and the ground level), one section per sensor group the board really sent (built from `js/schema.js`), and any fields the console has no place for yet. It is plain HUD text with no box or border. Where the list is scrolled out of sight at the top or bottom, the lines at that edge fade out (hud.js adds `is-cut-top` and `is-cut-bottom`), so a cut never shows half a line. Opening it moves keyboard focus into the list, where the arrow keys scroll it, and the cue for that focus is the first heading turning amber, not a box. Escape closes it and puts focus back on `[ MORE ]`.
- **Bottom left**: GPS (satellites and fix), HDOP and PKT (the last packet's age).

GS is the receiver's own ground speed when the data has one (a radio packet does). The USB status block doesn't, so then it is worked out from the last few good fixes (`groundSpeed()` in `js/flight-state.js`).

The rules it keeps:

- A missing value shows `--`, never 0, and gets no unit.
- A warning (no fix, packets gone stale, an old altitude, HDOP over `MAX_HDOP`) turns its line amber and blinks it once, but only when it starts during play, never after a seek or a source change.
- VS shows `--` while the altitude is old. It shows ▲ or ▼ only when the speed on screen, rounded to 0.1 m/s, is more than `LEVEL_VSPEED_MPS` (0.5 m/s), so a board lying still never flips between "▼ 0.5" and "0.5". Panel 2's readings use the same rule.
- Every value sits in a field with a fixed width in characters, set by `FIELD_CH` at the top of `hud.js`: the clock 7, ALT 6, VS and GS 7, GPS, HDOP and PKT 13, and the checklist and recovery values at least 16. The units have fixed fields too (`UNIT_CH`), and an empty unit or arrow keeps its room. So no label and no value column moves when a value changes, goes missing or turns amber.
- The line under ALT never widens its block. It ends in an ellipsis when it is too long.
- The HUD's blocks don't take clicks (only their buttons and the open MORE column, which scrolls, do), so a drag over the HUD text still reaches the map.

### The phase bar and the rocket chips

`js/views/phase-strip.js` draws six names over a thin line across the top middle: PAD, ASCENT, APOGEE, DROGUE, MAIN and LANDED. They follow only the detector's current phase for the focused rocket, never the simulator's truth. The current phase is amber, passed ones white and later ones dim. Drogue and main are inferred from the descent rate, so their lines are always dashed. A phase before the current one that was never found (drogue and main when a rocket lands without them, or the pad when the data starts in flight) is dotted, so it never looks passed. When each phase began is read out to screen readers but not shown.

`js/views/rocket-bar.js` adds one chip per rocket under it, only for flights with two or more rockets. Click one to focus it.

### The altitude timeline

`js/views/timeline.js` runs along the bottom of panel 1 in a replay, with no box. It is the console's one altitude curve. It shows the focused rocket's height above ground over the whole recording, white up to the playhead (an amber line) and dim after it, with other rockets as thin grey lines. A GPS fix gap, or a stretch with no readings for longer than `LINK_STALE_S`, leaves a break in the curve. Event markers sit on the curve, shaped by how each event was found (a filled dot for reported, a ring for detected, a dashed ring for inferred or estimated). They are dim until the playhead reaches them, white after, and amber on hover. A click on one jumps to it. A small key for the shapes sits in the strip's top right corner, hidden on phones and short windows. What screen readers hear (the markers, the strip's summary and the slider's value) gives heights in m AGL, like "about 3,010 m AGL".

A dashed line marks the focused rocket's highest point, with its height as a label on it (`3,012 M`). The label has the same color and outline as the time labels, and it sits over the playhead, so it stays readable while the playhead passes. The label sits at the left end of the line when nothing is in the way. If a marker, a marker's label or the shapes key is there, it tries the right end, then every spot in between (`placePeakLabel()`), and it hides when the whole line is taken. The dashed line stops 4 px either side of the label, so the dashes never run through the text. In a short strip the curve keeps at least 14 px of height (`MIN_PLOT_PX`).

`[ PLAY ]` or `[ PAUSE ]` (or `[ REPLAY ]` at the end) and `[ 1X ] [ 5X ] [ 20X ]` sit beside it, with the speed in use in amber. A flight starts playing at `DEFAULT_SPEED` (5x). Click or drag anywhere on the strip to seek. With keyboard focus the strip is a slider: the arrow keys move the playhead by `TIMELINE_KEY_STEP_S`, Shift with an arrow or Page Up and Page Down move it by `TIMELINE_KEY_BIG_STEP_S`, and Home and End go to the start and end.

### The layout of panel 1

Panel 1 is one overlay grid over the map (`.fc-overlay` in `flight-console.css`), so nothing in it overlaps:

- The HUD's four blocks.
- The phase bar and rocket chips in the top middle (`.fc-ov-top`).
- `#fc-map-controls`, bottom left, directly above the timeline. `map-view.js` fills it.
- `#fc-timeline`, along the bottom.

The bottom right corner above the timeline is left free for the map's notes, scale bar and credits. Every block is marked `data-fc-cover`, so WHOLE FLIGHT frames the flight in the part of the view they leave free, and FOLLOW BOARD keeps the board clear of them. The panel switch at the edge (`[ GRAPHS ]`) counts as a cover too. Hidden blocks have no size, so they don't count.

`map-view.js` watches these blocks for size changes, and picks up the HUD's own blocks as the HUD makes them (`watchCovers()`). It also checks them again right after the console's state or mode changes and right after anything in the overlay is shown or hidden, before the next frame is painted. On every draw it compares each block's place and size too (`checkCovers()`), so a block that moves without changing size (GPS, HDOP and PKT at the landing in a short window) never covers the board.

`main.js` keeps three numbers on `#fc-panel-globe` for the CSS, in px:

- `--fc-tl-space`: from the panel's bottom edge up to the top of the timeline, plus 8 (0 with no timeline).
- `--fc-ctl-space`: the same up to the top of the map's controls (the same as `--fc-tl-space` when the controls are empty).
- `--fc-corner-h`: the height of the map's bottom right corner plus 8 (0 before the map view makes it). `main.js` finds the corner again after each new stage.

The layouts:

- From 641 to 960 px wide, the phase bar takes its own row at the top.
- Shorter windows (820 px tall or less, and again at 640 px) make everything a little tighter.
- On phones the HUD gets compact: the flight time and phase with GPS, HDOP and PKT under them on the left, ALT, VS and GS on the right, then the phase bar, the MORE column across the middle, the controls and the timeline. While MORE is open, an empty band above the controls (`--fc-corner-h` tall) keeps the scale bar and credits clear. On the smallest phones that band gives way before anything is pushed off the bottom. The timeline strip is 56 px tall.
- Any window 520 px tall or less gets the smallest HUD, with no feet line under ALT.
- Short, wide windows (at least 641 px wide and at most 520 px tall, like a phone turned sideways) have their own layout. The phase bar runs across the top. ALT, VS and GS sit top right, and MORE opens to their left, since there is no room under them. GPS, HDOP and PKT sit in a third row that is at least as tall as the map's bottom right corner (`--fc-corner-h`). The controls take one row, and the timeline has PLAY, the speeds and the time in one row left of a 46 px strip. In `pad` and `recovery` the top left block runs down into the third row. In `recovery`, GPS, HDOP and PKT move to where MORE opens, and an open MORE column takes their place.

The page never scrolls, and never scrolls sideways.

### The stage and the store switch

The 3D view (with the 2D map behind it), the HUD, the phase bar and the rocket chips are "the stage". They are made once, the first time the console opens, and kept until the visitor goes back to the landing. So the globe never goes blank, even while a saved flight downloads.

Their store is a store switch (`js/store-switch.js`). It stands in front of whichever real store is on screen, the live one or a replay's, and has every method a store has. `main.js` points it at another store with `use(store)`. Subscribers then get one change, `{ type: 'source' }`, which means "drop everything you drew or cached and draw the new store from scratch". Changes from a store that is no longer behind the switch never reach them.

`ctx.session` says what is on screen: `{ kind: 'live' | 'replay', prescan, player, entry, loading }`. `main.js` changes its fields first, then calls `use()`, and the views read it fresh on every draw. For views written before the session existed, `ctx` also has getters for `prescan`, `player`, `flight` and `link`.

Opening a saved flight:

1. As soon as its library entry is known, the flight's store is made, with `entry.groundStation` (Manta's position for that flight) when the entry has one, and the demo position from `config.js` when it doesn't.
2. The session says `{ kind: 'replay', loading: true, entry }` and the stage switches to the new store. The bar says LOADING. The camera flies toward the flight's launch point (from `summary.padPoint` in the library) while the data downloads.
3. When the data is in, the session gets the pre-scan and the player, and `loading` turns false.
4. The altitude timeline and panel 2 are made for that flight alone, and playback starts.

Closing a replay destroys its player, timeline and panel 2. Its store stays on the stage until the stage shows something else, and is cleared then, so nothing from one flight can linger in the next. The live session (the link, the bench panel and the live stores) survives every trip to a replay and back.

## The map and 3D view

Panel 1 is one frame with two views: the 3D view (CesiumJS on Cesium World Terrain, the default) and the 2D map (Leaflet, the fallback). `js/views/map-view.js` owns the frame. It starts the 3D view (`js/views/globe-view.js`), builds the controls, shows the loading and failure messages, and is also the 2D map. Both views draw the same things. The look of every marker and line is in `js/views/markers.js`, so the two views and the KEY always match. Switching between them keeps the playback time, play or pause, the focused rocket and following. The HUD, the phase bar and the timeline don't change, because they only read the store.

### What is on the map

- **Breadcrumbs**, from `rocket.crumbs` (see "The breadcrumb trail"): one small dot per received fix and a thin line through the good fixes.
  - A good fix is a solid dot in its speed color, from slow purple to fast pale yellow (`speedColor()` in `js/track.js`), with a thin dark outline.
  - A weak fix is a hollow grey ring and is left off the line. Outliers are not drawn.
  - The line goes through the smoothed positions (`crumb.line`). The dots are the raw fixes.
  - The line breaks wherever packets were missed. If the fix right after a gap is weak, the break carries on to the next good fix.
  - The dots are drawn in two passes in both views: every dark edge first, then every fill. So a slow run of fixes that overlap reads as its speed color with one thin dark edge around it, and dots far apart keep their own ring. In 3D the edges are an opaque billboard collection with hard-edged images, and the fills are a see-through one that Cesium draws after it. On the 2D canvas the edges are simply painted first.
- **A ground shadow** in 3D only: the same line laid faintly on the terrain, a dark 3 px line at 50 percent with a faint off-white 6 px band under it (`SHADOW_*` and `SHADOW_EDGE_*` in `markers.js`), so it can still be found over dark ground. The 2D map has no shadow, since its path is already flat.
- **The Dogtooth board**: a rounded rectangle in the board's blue (#184590) with a thin off-white outline. It always stands upright and keeps one size on screen, since no board sends orientation. It sits on the newest good fix. It turns hollow when there is no fix right now, or a newer fix failed the quality gate. A board that has only sent weak fixes so far shows hollow on its newest weak fix, with its DOGTOOTH label and the radio link, in both views. The first good fix brings back the normal rule. Each packet grows one thin white ring out of it (a new one only starts once the last has finished).
- **Manta** (the ground station): a small off-white dish. A faint dashed line, the radio link, runs from the board to Manta, and a small white dot travels along it for each packet. In 3D the line is a solid light grey (`LINK_SOLID`), so the markers stay on top of it. With no ground station there is no dish and no line.
- **The launch point**: a small off-white dot.
- **Event markers** for the focused rocket: a small white diamond at apogee, drogue, main and landed, on the fix where each happened (`eventCrumb()` in `js/flight-state.js`). A marker only appears once playback reaches its event, and an event that fell in a GPS gap gets none.
- **The recovery crosshair**: after landing, a ring around the recovery position (the averaged fixes that OPEN IN MAPS uses).
- **Labels** in small Share Tech Mono with a leader line (`js/views/map-labels.js`): DOGTOOTH (moves with the board), MANTA, LAUNCH POINT and APOGEE with the real height. Things closer than 22 px on screen share one label. A label tries four spots around its point and fades out if none is free of other labels, the HUD and the view's edge. All labels fade out when the view is zoomed far out. Labels never take clicks, and screen readers skip them, since the HUD says the same things.

With less motion asked for, the ring and the traveling dot don't run, and the camera jumps instead of gliding.

### Controls

One row, the same in every view: `[ SATELLITE ] [ DARK MAP ] [ 3D ]`, `[x] FOLLOW BOARD` and `[ KEY ]`, plus `[ WHOLE FLIGHT ]` and `[ RESET VIEW ]` while a saved flight is on screen. `map-view.js` builds the row and puts it in `#fc-map-controls`, and the HUD's CSS decides where that sits. The active view is amber.

- FOLLOW BOARD is one setting for both views. With it on, the camera keeps the focused board in view (see "FOLLOW BOARD" below). It switches on by itself when the state turns to `flight`, and sliding the view switches it off.
- WHOLE FLIGHT frames every point drawn so far, the launch point, the events and Manta inside the part of the view the HUD leaves free (every element marked `data-fc-cover`), with 28 px to spare (`WHOLE_ROOM_PX` in `map-view.js`). In 3D it keeps framing them as the path grows, and frames again if the board leaves the free part, until the viewer zooms or slides the view.
- RESET VIEW goes back to the starting angle and distance. While following, the follow camera eases back to the starting angle at its own distance. Otherwise it aims above the launch pad, so the pad and the highest point both fit.
- KEY opens a legend for every marker and line (see "The KEY" below).

The 2D map has no zoom buttons and no labels checkbox. The wheel, a pinch, a double click and the keyboard still zoom it. Over SATELLITE, Esri's place and road names are always on.

The bottom right corner holds the map's notes (amber), a scale bar in both views, and the required map credits (Cesium's or Leaflet's). It sits as low as it can, above the timeline. It only moves up when something is really in its spot, and then into the lowest free gap tall enough for it, so it never lands on a HUD block, the phase bar or the MORE column (`placeCorner()` in `map-view.js`). If no gap is tall enough (the smallest phones), it takes the tallest one. The scale bar is white Share Tech Mono with the HUD's dark outline, and the credits are off-white with the same outline.

### FOLLOW BOARD

In 3D, FOLLOW BOARD works like a camera operator on the ground (the "Follow camera" section of `globe-view.js`, with its settings, `FOLLOW_*` and `RECOVERY_*`, near the top of the file):

- It frames the board, the launch point, Manta (when it is within 3 km of the launch point), the event diamonds and the path so far inside the free part of the view. That is the part the HUD's `data-fc-cover` blocks leave free, the same area WHOLE FLIGHT uses. It keeps the visitor's heading and tilt.
- It leads the board by one fix (where the board will be at the next fix if it keeps going) and pulls back as the board climbs.
- It comes no closer than 1.5 km on its own and goes no farther than 15 km. Past 15 km it keeps only the board and its newest 20 path points.
- It eases toward each new framing, closing most of the gap in about 0.7 of the time between fixes (never faster than 0.12 s or slower than 0.8 s). It ignores changes under 18 px, so a board wandering on the pad doesn't make it creep.
- The board itself is never left under the HUD, the phase bar, the controls or the timeline. On every frame the real camera checks this and nudges the view at once if needed. When a HUD block changes size, both views move the board clear before the frame is painted.
- After a seek, or any jump of the board too big for one fix, it jumps straight to the new framing instead of easing there.
- After landing it glides in to 1.5 km and tilts to at least 35 degrees down, so the recovery crosshair and the DOGTOOTH label stand out.
- Turning, tilting and zooming by hand keep following from the new angle, and the zoom becomes a factor on the camera's own distance. Sliding the view with the mouse (right drag, or Shift and drag) switches FOLLOW BOARD off, as dragging the 2D map does. Two fingers only slide the view once FOLLOW BOARD is off, so a pinch can't switch it off by accident.
- Ticking FOLLOW BOARD again, by hand or at liftoff, glides back to the board in 0.9 s (`FOLLOW_GLIDE_MS`).
- With less motion asked for, the camera jumps instead of easing.

On the 2D map, FOLLOW BOARD keeps the visitor's zoom. It pans when the board gets within `FOLLOW_EDGE_PX` of the free part's edge, and never leaves the board right on an edge. When the board is near an edge the other way too, that direction is centered again in the same pan. If a HUD block grows over the board, the map moves at once.

### The KEY

The KEY's rows are:

- the board, and the packet ring (only for viewers who haven't asked for less motion, since no ring is drawn for the others)
- the board with no good fix right now
- a good fix and the path (slow to fast), and a gap where packets were missed or the fix was lost
- a weak fix
- the ground shadow (3D only)
- the launch point, Manta and the radio link
- the event diamond
- the recovery position

With no ground station the Manta rows drop out, and with the demo position Manta's row says so.

The legend opens in a part of the view the HUD leaves free. `placeLegend()` in `map-view.js` measures the HUD's `data-fc-cover` blocks, the panel switch and the map's corner, and looks for the lowest free gap next to the controls.

- It tries the column lined up with the controls row first. On a desktop that puts it just above GPS, HDOP and PKT. If that column has no room, it tries the column lined up with the KEY button, and only then the rest of the view.
- When no free gap holds the whole legend, it takes one at least 140 px tall (`LEGEND_MIN_PX`) and scrolls inside itself. Its last line fades until it is scrolled to the end.
- Only on the smallest screens, where no gap is at least 44 px tall (`LEGEND_FLOOR_PX`, like a 320 by 568 phone, or a 740 by 360 window after landing), does it open as a dark sheet over the HUD. Even then it stays clear of the scale bar and credits.
- When an open MORE column leaves the KEY no room (on a phone, say), the one opened last closes the other.

It has no box. It is mono text with the HUD's outline over a soft dark fade.

### Loading and failures

- A flight opens on the 3D view. That is `DEFAULT_VIEW` in `js/config.js`. Set it to `'map'` and a flight opens on the map instead.
- CesiumJS is a big download (about 1.8 MB), so the landing never loads it. `js/views/cesium-loader.js` adds Cesium's script and stylesheet when the 3D view opens. It comes from Cesium's own release CDN, pinned to version 1.146 (`CESIUM_VERSION`).
- While it loads, the frame says "3D VIEWER LOADING..." with the blinking cursor. After 10 s (`THREE_SLOW_MS` in `map-view.js`), or as soon as loading fails, it adds "CHECK YOUR INTERNET CONNECTION" and `[ BACK TO THE MAP ]`. A failed download is tried again every 15 s while the viewer stays on 3D, so the 3D view takes over once the internet is back. A slow download isn't thrown away when the wait runs out. If the viewer came from the map, the map stays visible under the message.
- With no WebGL it says "3D VIEWER CAN'T RUN IN THIS BROWSER". If the browser takes the 3D view's graphics away while it runs (a phone left in the background can do this), it says "3D VIEWER STOPPED. PRESS 3D TO START IT AGAIN". Both have `[ BACK TO THE MAP ]`.
- Once a viewer goes to the map, later screens in the same visit open on it. The choice isn't kept between visits.
- If Leaflet or the map tiles fail, a NO MAP panel lists each board's position, distance and bearing from Manta. Tracking keeps working either way.

### Idle and switching stores

- With nothing connected, the camera looks straight down at the whole Earth, sized to fit the part of the stage above the controls and credits at any window size, and fitted again on resize. `aimIdle()` sets the camera's position, direction and up by hand. Cesium's `setView` turns a view this close to straight down into a heading taken from "up", which used to tilt the camera the wrong way and push the Earth down into the controls.
- A `'source'` change from the store switch drops everything drawn, every ground height and the camera mode, then flies to the new site. While a saved flight is still downloading, the camera heads for its launch point from the library entry. Going back to live with nothing connected flies out to the whole Earth.
- Leaving for the landing destroys the Cesium viewer and lets go of its WebGL context, so opening many flights doesn't use more and more memory.

### Look

The 3D view sits on the page with no frame. The space around the Earth is the page's near-black, and there are no stars, skybox, sun or moon. The glow of the atmosphere is darkened and pulled toward grey (`SKY_*` at the top of `globe-view.js`). Below `SKY_GLOW_MIN_M` (100 km) above the ground the glow is off, so the sky over the ground is the page's own near-black, and the haze over distant ground is darker and greyer (`GROUND_HAZE_*`). Close to the ground, the ground fades into the page toward the horizon (`HORIZON_FADE_*`), so it never ends in a hard line against the sky. The path, the markers and the labels are drawn without the depth test, so terrain never cuts them.

### Heights

Cesium places things by height above the ellipsoid, a smooth model of the Earth's shape. GPS reports height above mean sea level. The two differ by tens of meters, and the page never converts between them. Instead:

1. Once a rocket's launch pad is known, the page asks Cesium World Terrain for the ground height at that spot (`sampleTerrainMostDetailed`).
2. Every point of that rocket is drawn at that ground height plus the detector's height above ground for the point.

So the launch point sits on the terrain, the path starts on the ground, and a point drawn 1,000 m up is the same 1,000 m the HUD shows. Each rocket uses its own pad. A pad that moves less than `PAD_RESAMPLE_M` keeps the ground height it already has.

A rocket isn't drawn in 3D until its launch pad and the ground height there are known, or liftoff has come with no pad. If the ground height can't be looked up, a note says "3D ground height is approximate.":

- If the lookup for a pad fails, or takes longer than `TERRAIN_SAMPLE_TIMEOUT_MS`, or the rocket has no pad (the data starts in flight), each point goes at its GPS altitude, used as it is.
- If Cesium World Terrain doesn't load in time, the ground is drawn flat and heights above ground are measured from it.

If ion's imagery doesn't load, a note says "The 3D imagery didn't load, so the ground is plain."

For the first simulated flight (`gps-board-sim-01`), the pad's ground height came out to about 814 m above the ellipsoid. That simulator's "700 m above sea level" is a placeholder and isn't the real ground there. Heights above ground are measured from the pad, so if the rocket lands on higher or lower ground, the end of the path can sit a little under or over the terrain there.

The Komodo flight (`komodo-sim-01`) uses the real ground height. Its pad is 105.7 m above sea level, which is 145.76 m above the ellipsoid there, and it lands in the sea, 105 m below the pad. So its path starts on the ground and ends on the water, give or take the GPS's own altitude error (the board's altitude wanders by about 10 m while it lies there).

### Moving the 3D camera

The camera always looks at one point and circles around it. Cesium's own mouse and touch controls are made for spinning a whole globe, and this close to the ground they turn far too fast. So they are switched off, and `globe-view.js` has its own.

- Drag with one finger or the left mouse button to circle around the point the camera looks at. A drag across 720 px goes half way round (`GLOBE_ORBIT_DEG_PER_PX`).
- Use the mouse wheel or a pinch to zoom. One wheel notch is 20 percent (`GLOBE_ZOOM_PER_NOTCH`).
- Twist two fingers to turn the view.
- Drag with the right mouse button, or hold Shift and drag, to slide the view over the ground. That stops following the board. Two fingers dragging also slide the view, but only once FOLLOW BOARD is off, so a pinch can't switch it off by accident.
- With keyboard focus on the 3D view, the arrow keys move the camera around the point (`GLOBE_KEY_TURN_DEG`), and + and - zoom (`GLOBE_KEY_ZOOM`).
- In the idle view (the whole Earth, nothing to look at) the camera stays put.

Nothing keeps moving after you let go. The camera can't go under the ground or flip over the top. The starting view looks north from the side, tilted 12 degrees down, from three times the flight's highest point away (from the pre-scan). Live data has no pre-scan, so it starts at `GLOBE_START_RANGE_MIN_M`. A new site far away is reached with a flight (see "Flights to a far site" below), and a near one with a short glide (`GLOBE_MOVE_MS`). Anything the viewer does with the camera on the way ends the flight at its goal. With less motion asked for, the camera jumps.

#### Flights to a far site

`globe-view.js` flies the camera itself instead of using Cesium's `camera.flyTo`. Cesium's flight turned the camera on its own schedule, and on a long flight (the idle globe to Komodo, on the far side of the Earth) it looked out into space and the view went black for over a second. Now the camera always looks at a point on the Earth, so the Earth is in the middle of the view on every frame. That point slides along the great circle to the new site, so the globe turns under the camera. The camera's distance follows van Wijk and Nuij's "smooth and efficient zooming and panning" path: it rises just enough that the ground slides by at an even pace, never past the whole-Earth view, and comes down onto the site. High above both ends it looks straight down with north up, and it tilts to the site's view as it comes down.

- A usual flight takes `FLY_IN_S` (2.6 s). One with more to cover takes a little longer, up to `FLY_IN_MAX_S` (3.6 s): about 3 s from the idle globe to Komodo or from one saved flight to the other.
- A new goal on the way (a saved flight's data arriving while the camera still flies to its launch point) bends the flight onto it over `FLY_RETARGET_MS`, so nothing jumps. Flying out to the whole Earth, it also follows the HUD as it changes from a replay's to live's.
- If the page is busy for a moment, the flight's clock moves on at most `FLY_MAX_STEP_MS` per frame, so the camera carries on instead of jumping ahead.
- While a saved flight downloads, the camera heads for its launch point at a rough ground height. Seen from far away, Cesium can report a spot on the far side of the Earth as about 50 km under the sea, which put the camera inside the Earth, so a rough height outside `GROUND_GUESS_M` counts as sea level.
- On a slow connection the camera still comes down on time. The globe is there the whole way, but at the site the ground can show as a plain blue-green blur for a few seconds until its photos arrive.

### Drawing only when needed

The 3D scene only redraws when something changes: new data, a camera move, or new terrain or imagery arriving (Cesium's `requestRenderMode`). The packet ring and the traveling dot ask for frames only while they move, under a second after each packet. The 3D line is built in chunks of 100 points, and only the newest chunk is rebuilt when a fix comes in. The dots are batched in two billboard collections per board, one for the dark edges and one for the fills. The newest piece of the ground shadow is laid again at most once a second. The 2D breadcrumbs are painted on one canvas.

### For tests

`#fc-map` has a small hook for tests. `fcMapTest.fit()` reports where the framed points are on screen, `fcMapTest.counts()` how much is drawn, and `fcMapTest.camera()` where the focused board is on screen and the free part of the view FOLLOW BOARD keeps it in, with the camera or map position. In 3D the last one comes from `debugCamera()` in `globe-view.js`.

## Detection

`js/detector.js` works out ground level, altitude above ground, vertical speed and the flight events for one rocket, one sample at a time. It never sees the simulator's truth. Every time setting is in seconds, never in readings, so boards at 1 or 20 readings a second behave the same. Every number below is in `js/config.js`, with a comment.

**The pad.** Before liftoff the detector waits to see the rocket sit still (vertical speed under `PAD_STILL_MAX_MPS`) for `PAD_CONFIRM_S` before it trusts the readings as a pad. Ground level is the average of the last `PAD_AVG_S` of pad readings, frozen at liftoff. The launch point (`rocket.padPosition` in `js/store.js`) is the average of the good fixes from the last `PAD_AVG_S` on the pad, so a board whose GPS wanders gets one steady launch point. Vertical speed is the change over `VSPEED_AVG_S`.

**Liftoff** has to be something a board sitting on a desk can't fake. On my bench a still board wandered 15 m by 30 m sideways, and GPS altitude wanders a few times more than that, with single jumps of 30 m or more. A real rocket climbs at 100 m/s or more. So liftoff takes one of two things:

- A climb. `LIFTOFF_CONFIRM_READINGS` (3) altitude readings in a row, at least `LIFTOFF_CONFIRM_S` (1 s) from first to last, each at least `LIFTOFF_MIN_STEP_MPS` (5 m/s) higher than the one before, each more than `LIFTOFF_AGL_M` (30 m) above the pad. The average climb rate over the run, from the last reading before it, must be faster than `LIFTOFF_VSPEED_MPS` (30 m/s).
- A comeback. The first altitude reading after a break (the GPS fix dropped, or nothing came for `LIFTOFF_BREAK_S`, 2.5 s) is more than `LIFTOFF_FIX_BACK_AGL_M` (150 m) above the pad. It must mean climbing faster than `LIFTOFF_VSPEED_MPS` since the last pad reading, and the next reading must be up there too. My GPS often loses its fix in boost and gets it back high above the pad.

T+0 is the first reading of the climb. If the GPS fix dropped on the pad first, T+0 is the drop, and after a plain break in the data it is the last pad reading. Both are marked as estimated (LIFTOFF TIME ESTIMATED on the HUD). A jump, a step that stays, carrying the board upstairs, or a GPS settling after power-up can't do either. So the live bench store uses the normal detector, liftoff included, and the four states follow the data live too.

**Data that starts in flight.** Climbing counts when the liftoff climb is seen with no pad under it and it rises more than `LIFTOFF_FIX_BACK_AGL_M`. Falling counts once the vertical speed stays under -`START_FALL_MIN_MPS` for `START_FALL_CONFIRM_S` (10 s) and the altitude drops more than `LIFTOFF_AGL_M` in that time. That also covers a confirmed "pad" that keeps sinking. The console then says DATA STARTS IN FLIGHT, uses `GROUND_ELEV_FALLBACK_M` for ground level, and marks it as estimated.

**Apogee, drogue and main.** Apogee needs a climb past `APOGEE_ARM_AGL_M`, then falling for `APOGEE_CONFIRM_S`. Drogue is inferred from falling faster than `DROGUE_MIN_DESCENT_MPS` after apogee. Main is inferred from a slower descent (under `MAIN_MAX_DESCENT_MPS` but faster than `MAIN_MIN_DESCENT_MPS`) that starts higher than `MAIN_MIN_AGL_M`. Each descent rate must hold for `DESCENT_CONFIRM_S`.

**Landing** is only possible after apogee, or once the altitude is `LANDED_ARM_DROP_M` (50 m) below its highest point, so a board on a desk never gets there. Then, over a sliding `LANDED_WINDOW_S` (20 s) window:

- the altitude stays within `LANDED_ALT_RANGE_M` (15 m)
- it sinks no faster than `LANDED_MAX_SINK_MPS` (0.5 m/s), from the best straight line through the window
- every GPS fix is within `LANDED_RADIUS_M` (50 m) of the window's average position
- if the receiver sent its own ground speed, every one is under `LANDED_MAX_SPEED_MPS` (2 m/s). A still board reports almost 0 however much its position wanders.
- there are at least `LANDED_MIN_READINGS` (5) altitude readings

With 10 or more readings, the single highest and lowest altitudes and the single farthest fix are set aside first, so one wild fix can't hold the landing off. The landing time is the touchdown: the first reading in the window within `LANDED_TOUCHDOWN_M` (5 m) of the window's middle (median) altitude.

**The recovery position** (`rocket.derived.landing`) is the average of the fixes from touchdown until the landing was confirmed, never the last fix on its own. `recoveryInfo()` in `js/flight-state.js` turns it into the HUD's recovery block, measured from Manta when the store has a ground station and from the launch point when it doesn't.

**Ground speed.** The radio packet carries the receiver's own speed over ground, from its RMC sentence. It is horizontal only, so it can't tell a rocket going straight up from a board on a desk, and the detector only uses it for the landing. The USB status block doesn't print it, so a board on USB is judged on the rest of the landing rules, and the HUD works its GS out from the fixes instead. Adding a ground speed line to the status block would need the firmware to print it, a new entry in `FIELDS` in `js/bench/parse.js`, and `bench-feed.js` to pass it on as `gps.speed`.

## The breadcrumb trail

`js/track.js` gives one "crumb" for every position fix a board sent, with what the map needs to draw it honestly. The store keeps one trail per rocket (`rocket.crumbs`) and feeds it every sample. The file's header lists every field of a crumb and says what counts as a 3D fix for each source.

- **Quality gate.** A crumb is `'good'` when it is a 3D fix with at least `MIN_SATS` (6) satellites and an HDOP of at most `MAX_HDOP` (3). It gets a solid dot and joins the line. Otherwise it is `'weak'`: a hollow grey ring, never on the line. A source that sends neither a satellite count nor an HDOP (a plain CSV) is judged on the 3D fix alone. The firmware doesn't send the receiver's fix type, so a 3D fix means a fresh position with a fresh (or at least not old) altitude (`hasGoodPosition()` in `js/schema.js`).
- **Outliers.** A fix more than `OUTLIER_MIN_JUMP_M` (150 m) and faster than `OUTLIER_MAX_SPEED_MPS` (600 m/s) from the last good fix is an `'outlier'` and isn't drawn. If `OUTLIER_RESET_FIXES` (3) outliers in a row agree with each other, the last good fix was the wrong one, and the trail starts over from them, after a gap.
- **Gaps.** The line breaks wherever a packet sequence number was skipped (65535 is followed by 0), the GPS lost its fix, or, for data without sequence numbers, nothing came for `TRACK_GAP_S` (2.5 s). It never bridges more than `TRACK_GAP_S` between two good fixes.
- **Smoothing.** The line goes through a moving average of the last `LINE_SMOOTH_FIXES` (3) good fixes, never across a gap, and never more than `LINE_SMOOTH_MAX_M` (10 m) from its own fix, so it keeps up with a fast rocket. The dots stay raw, and so does the CSV, which never comes through here.
- **Speed colors.** `speedMps` is the straight-line speed through the air, height included, from the previous good fix. Right after a gap of up to `TRACK_SPEED_GAP_MAX_S` (10 s) it is the average speed across the gap. The first fix and fixes after longer gaps have no speed and get the slow end of the colors. `speedColor()` maps 0 to `TRACK_SPEED_MAX_MPS` (300 m/s) along `TRACK_RAMP`, with a square root so the slow speeds of a descent under parachute spread out. `TRACK_RAMP` starts with a lifted purple (#8B3DD1) and magenta (#CC3D8A), so slow fixes stay visible over dark ground, water and the dark map, then runs through the ironbow ramp's three fast stops to pale yellow.

## Panel 2: graphs and readings

Panel 2 has one layout, live and in a replay. Across the top are one-line strips that open when pressed. Under them are the graphs, and on a wide screen the readings sit in a column on their left. On a wide screen panel 2 fits the window and long lists (the readings, an open strip, the raw output) scroll inside their own box. On a phone it is one column that scrolls inside itself: strips, then graphs, then readings. The look follows the theme: near-black, thin lines only, Share Tech Mono for everything read at a glance (titles, labels and numbers in capitals, and the mission timeline's events and the board's errors as they are written), Barlow Condensed only for notes written as full sentences, white graph lines, and amber only for warnings and errors.

**Live** (a Dogtooth board on USB): `js/live/bench-panel.js` fills the parts written in `index.html`, found by their `bc-*` ids.

- The mission timeline is the first strip, the same strip a replay has (`js/views/event-log.js`), in the `#bc-log` spot. It reads the live store. `main.js` hands the store over through `panel.showEvents(store)` from `showLive()`, every time it puts a live store on the stage. The strip is made the first time and then switches stores through a store switch of its own, so a reconnect, a new source or a trip to a replay and back never adds a second one. It follows the live store, so a board restart clears it. Before the first event the closed line says "No events yet", and the open list says "No events yet. They show up here as they happen." Liftoff, apogee, drogue, main and the landing appear as they happen, with T+ times, marks, the count and NOW.
- Errors from the board are a strip with an amber edge under it, with `[ CLEAR ]`.
- The graphs cover the last 10 minutes: ALT MSL, GPS SATS, Lock quality, GPS data rate and Radio PKT (sent, and errors in amber). `[ SAVE AS CSV ]` sits next to the Graphs heading.
- The readings show the board's own labels, grouped by section (GPS, GPS motion model and Radio).
- The raw serial output is closed at first, at the bottom of the readings column.

**A saved flight**: `js/views/data-panel.js` builds the same layout in `#fc-data-replay`.

- The strips are the mission timeline (`js/views/event-log.js`) and About this flight (`js/views/flight-info.js`).
- The mission timeline's closed line shows the newest event with its flight time, its mark and the event count. Open, it lists every rocket's events in time order with a filled dot (reported by the board), a ring (detected from altitude) or a dashed ring (inferred, or a time that was estimated). The message says the same in words. A lost GPS fix is a warning, so its mark is amber. The newest entry is lit, with a NOW tag for `EVENT_NOW_S` after it. Screen readers hear new events from a hidden log during normal playback only. A seek rebuilds the list quietly.
- About this flight's closed line still says simulated or real and names the data file, with `[ COPY LINK ]`. Open, it shows the title, description, date, launch site, each rocket's board, each data file with its reading and bad line counts, and the parser's notes. If the browser blocks copying, the link shows selected in a field.
- Six graphs: ALT AGL, VS, GS, GPS SATS, HDOP and PKT (received, and missed from jumps in the packets' sequence numbers, in amber). They are on flight time, with zero at liftoff from the pre-scan. The time axis spans the whole flight, and the lines fill in up to the playhead.
- `js/views/data-series.js` (no DOM) works out the points from the store. VS is worked out the way the detector does it, the change over `VSPEED_AVG_S`. GS is the board's own GPS speed, or else the distance between two good fixes in a row. HDOP breaks where the receiver reports its 99.99 "no HDOP" value. Nothing goes through the map's quality gate, outlier filter or smoothing, so the graphs show what the board sent.
- `js/views/data-readings.js` builds the full readings list at the playhead. It starts with the flight (phase, flight time, ALT AGL, the highest so far, VS with an up or down arrow, GS, ground level and the last PKT). Then comes one group per sensor group the board sent, built from `js/schema.js`, and last any values the console has no place for yet. Missing values show `--`. Old values are dimmed with their age, and position rows come from the last good fix while there is no fix.
- `data-panel.js` follows the store's changes (`'samples'`, `'reset'`, `'time'`, `'focus'`, `'clear'` and `'source'`) and redraws at most 6 times a second (`DRAW_MAX_FPS`). While panel 1 is on screen it only notes that something changed, and draws once panel 2 comes back. It also works with no player, for a live flight source later.

Pointing at any graph (or tabbing to one and using the left and right arrows, Home, End or Escape) picks a moment, and every graph shows it. A graph with nothing to draw says NO DATA. `TimeChart` in `js/bench/charts.js` takes a `formatTime` option for its time labels, so a replay can label them in flight time. Both panels read their colors from the `--bc-*` variables on panel 2, where `--bc-panel` is the page background, so the graphs have no box behind them.

A short graph (with strips open on a small window, say) takes bigger value steps up its side, so its value labels stay at least `MIN_TICK_GAP_PX` (18 px) apart. A graph too short even for that labels only its bottom and top lines. When both replay strips are open on a desktop window (wider than 820 px and taller than 520 px), each open list stays within `min(10rem, 18vh)`, so the graphs keep some room.

## The live console

### How a line travels

1. `js/live/serial-link.js` opens the port with the Web Serial API at 115,200 baud, reads it, and hands every finished line to `main.js`. It knows nothing about what the lines say.
2. `js/live/sources.js` works out what is talking from the lines that arrive. The first line that matches a source decides it for the rest of that connection. A new connection starts over, since a different board may be plugged in. After 60 lines with text in them and no match, it calls the data unknown, and the console says NOT RECOGNIZED.
3. Every line also goes to `js/live/bench-panel.js`, panel 2 for a board on USB. It finds the status blocks in the lines (`BlockParser` in `js/bench/parse.js`), keeps every block for the CSV, counts heartbeats and lost blocks, collects errors, and draws the readings, the graphs and the raw output.
4. Each finished block goes to `js/live/bench-feed.js`, which turns it into one normalized sample (`{ rocketId, t, type, gps, ... }`, see `js/schema.js`) for the live store. Its clock is the board's own TIME RUNNING, and it keeps moving between blocks, so the views can tell when the data gets old. A board restart (TIME RUNNING or the heartbeat number going back) clears the store and starts over.
5. The live store (`js/store.js`) is the same kind of store the replays use. The stage reads it through the store switch.

The live session (the link, the panel, the source detector and the live stores) is made the first time the console opens and is kept for the whole visit. So a trip to a replay and back keeps the connection open and keeps every block for the CSV.

Leaving the page for real (a link in the nav, or closing the tab) closes the port and drops every block. So while there are blocks that weren't saved as a CSV file, the browser asks before it leaves. After SAVE AS CSV it only asks again once new blocks come in.

If a line makes the code that reads it throw, `serial-link.js` logs the error and goes on with the next line, so one bad line can't stop the reading.

### The live stores

The live stores are made with the options in `LIVE_STORE_OPTIONS` in `js/live/bench-feed.js`, so the page and the tests make them the same way.

- They use the normal detector, liftoff and landing included. `BENCH_DETECTOR` there is just `DETECTOR_DEFAULTS` now, kept as its own name so code that imports it keeps working. A board on a desk stays on its pad however much its GPS wanders (`test/bench-wander.test.mjs` checks it). The pad is still found, and the 3D view needs it to place the board.
- They have no ground station (`groundStation: null`). A replay's store starts with the demo ground station in `config.js`, at the simulator's placeholder pad in California, which would be thousands of kilometers from a board on my desk. So `getGroundStation()` returns null, and the map, the 3D view and the HUD leave out the dish, the radio link and every distance to Manta. The KEY drops those rows, and the recovery block measures from the launch point. The console never makes a ground station out of the board's own position. A real ground station's own "gs" packets would still set one.

### The Manta hook

The ground station isn't built yet, so nothing on the page reads it. There are two marked spots for it:

- `js/live/sources.js` has a commented-out entry for "Manta ground station" with what to fill in: a `test(line)` that is true only for the ground station's own lines, a `parse(line)` that gives back `{ kind: 'sample', sample }` (`parseSerialLine()` in `js/parser.js` is a good start), and `mode: 'flight'`.
- `main.js` has a "MANTA HOOK" comment over `feedFlightLine()`. It already passes each line of a flight source to its `parse()` (a line that makes it throw is skipped) and puts the samples in a flight store with the normal detector and no demo ground station. Before it is used, that store's clock also has to keep moving between packets (`store.setTime`), the way `bench-feed.js` does it for the board. The square on the CONNECT button also only follows the Dogtooth status blocks (`data-beat` in `bench-panel.js`), so Manta needs its own on-time check there.

When a source with `mode: 'flight'` is found, the console switches to flight mode and the stage shows the flight store. Panel 2's `data-panel.js` already works with no player, but today its mount, `#fc-data-replay`, only shows in a replay, so a live flight source needs its own spot for it.

### The Dogtooth status block

The board prints one block like this every second:

```
==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================

GPS
  TARGET LOCK [GPS]: ------------------ LOCKED
  CONNECTED SATELLITES: --------------- 11
  LOCK QUALITY: ----------------------- 100 % (HDOP 0.99)
  LATITUDE: --------------------------- 42.3386255
  LONGITUDE: -------------------------- -71.0896268
  ALTITUDE: --------------------------- 17.3 m
  GPS DATA RATE: ---------------------- GOOD 723 char/s
  CORRUPTED DATA OCCURRENCES (GPS): --- 1

GPS MOTION MODEL
  PORTABLE: --------------------------- OFF
  AUTOMOTIVE: ------------------------- OFF
  AIRBORNE 4G: ------------------------ ON
  OTHER: ------------------------------ OFF

RADIO
  RADIO PACKETS SENT: ----------------- 65
  RADIO PACKETS SKIPPED: -------------- 0
  RADIO PACKET ERROR OCCURRENCES: ----- 0
```

The banner line is also how `sources.js` recognizes a Dogtooth board. The block has no ground speed and no course (the radio packet carries both).

How the console reads it:

- **Banner.** A line starting with `====` begins a new block. The console reads `HEARTBEAT #` and `TIME RUNNING` from it. The time can be `5.3 s`, `1 min 5.3 s` or `1 h 2 min 5 s`, and the console turns it into seconds.
- **Sections.** A line with no colon is a section name. The readings in panel 2 group by section, with the headings GPS, GPS motion model and Radio.
- **Fields.** Every other line is a label, a row of dashes and a value. The label is everything before the first colon. The console strips the dashes and spaces to get the value, but keeps a minus sign, so `---- -71.0896268` reads as -71.0896268. Fields are found by their label, never their position, so the board can reorder them or leave some out. Labels the console doesn't know are skipped, and they still show in the raw output.
- **Values.** `LOCKED` or `SEARCHING`. `100 % (HDOP 0.99)` gives the lock quality percent and the HDOP. `GOOD 723 char/s` gives a status word (`GOOD`, `LOW` or `SILENT`) and a rate. `ON` or `OFF` for each motion model. Everything else is a number with an optional unit. A value that isn't a number where one is expected (like `--`) shows as text and stays off the graphs.
- **End of a block.** A block is finished at the next banner, or at the blank line after the RADIO section. If the port closes partway through a block, the console keeps what it got.
- **Lost blocks.** If the heartbeat number skips ahead (64, then 66), the missing numbers count as lost blocks. The jump across a disconnect doesn't count, because nobody was listening. Neither does a board restart. The panel keeps the count, but the console doesn't show it.
- **Heartbeat.** Each banner is a heartbeat. While connected, the square on DISCONNECT is filled amber, and it empties once 3 s pass with no new block. When the port closes (DISCONNECT, or the board is unplugged), the NOT RECOGNIZED line goes away, since nothing is coming in any more.
- **Restarts.** If `TIME RUNNING` or the heartbeat number goes back, the board restarted. The graphs start over, since their times would overlap, and so does the live store (the 3D path and the state). The CSV keeps every block.
- **Errors.** A line starting with `Error:` can come at any time, even inside a block. It goes in the errors strip near the top of panel 2. The same error again, with no other error in between, adds to its count instead of making a new row. It's also kept with the newest block for the CSV's `ERRORS` column.
- **Position.** A position only counts if latitude and longitude are both numbers on the globe, they aren't both 0, and the same block doesn't say SEARCHING. The board prints 0.0000000 while it searches, so no made-up position is ever drawn. LOCKED with a readable altitude counts as a 3D fix for the trail, since the block doesn't say whether the altitude is fresh.

Lines outside a block, like the startup banner, go in the raw output only.

What the graphs show: NO DATA until the first block, then the last 10 minutes (or since the board started, if that's shorter). The time along the bottom is the board's `TIME RUNNING`, so data that arrives in a burst still lands at the right time. Lines break at each connect and disconnect and across gaps over 6 s. Altitude is left off while the block says SEARCHING. After a disconnect, the graphs stop moving so the data stays in view. Pointing at any graph (or tabbing to one and using the arrow keys) picks a time, and every graph shows that moment.

### Names the console knows

Every name the console matches is in one place at the top of `js/bench/parse.js`: `BANNER` for the banner, `ERROR_LABEL`, and `FIELDS` for the sections and labels. They're copied exactly from the board's output, capitals and brackets included, and a label must match exactly to count. If the firmware renames something, change it there. A new entry in `FIELDS` gets a row in the readings and a column in the CSV.

| Section | Label | Read as |
|---|---|---|
| GPS | TARGET LOCK [GPS] | LOCKED (plain) or SEARCHING (dark text on amber) |
| GPS | CONNECTED SATELLITES | number |
| GPS | LOCK QUALITY | percent and HDOP |
| GPS | LATITUDE | number |
| GPS | LONGITUDE | number |
| GPS | ALTITUDE | number and unit |
| GPS | GPS DATA RATE | GOOD (plain), LOW (amber text) or SILENT (dark text on amber), then a rate |
| GPS | CORRUPTED DATA OCCURRENCES (GPS) | number |
| GPS MOTION MODEL | PORTABLE, AUTOMOTIVE, AIRBORNE 4G, OTHER | ON or OFF |
| RADIO | RADIO PACKETS SENT | number |
| RADIO | RADIO PACKETS SKIPPED | number |
| RADIO | RADIO PACKET ERROR OCCURRENCES | number |

GPS MOTION MODEL shows only the model that's ON, or all four if none is.

This block format dates from 2026-11-13. Before that, the flight firmware in `DOGTOOTH_V1_FIRMWARE` printed a one-line `Label: value | ...` status line, which the console no longer reads.

### The CSV file

`[ SAVE AS CSV ]`, next to the graphs' heading in panel 2, downloads every block received since the page loaded, across every connect and disconnect, and across trips to a replay and back. One row per block, in the order they arrived:

- `PC time (UTC)`: when the computer got the block's banner, as ISO 8601.
- `HEARTBEAT #` and `TIME RUNNING (s)`, from the banner.
- One column per field, in the order of `FIELDS`, holding the value as the board printed it. `LOCK QUALITY` splits into `LOCK QUALITY (%)` and `HDOP`. `GPS DATA RATE` splits into `GPS DATA RATE STATUS` and `GPS DATA RATE (char/s)`. The motion model columns start with `GPS MOTION MODEL`, so `AIRBORNE 4G` makes sense on its own. A header's unit is the first unit the board sent for it.
- `ERRORS`: every `Error:` message from the block's banner until the next banner, split by ` | ` when there's more than one. An error before the first banner of a connection belongs to no block, so it's only in the errors strip.

The CSV is completely raw. `js/bench/csv.js` only reads the board's blocks from `js/bench/parse.js`, never the map's trail, so a wild position jump or a SEARCHING block comes out exactly as printed. Lines outside a block, like the startup banner, aren't in the CSV. Nothing is uploaded. Everything stays in the tab until it's closed or reloaded.

### The old Bench Console address

`/bench-console/` is now a tiny page that sends visitors to `/flight-console/?track`: a meta refresh, a `location.replace` script (so Back skips it), a canonical link, and a visible link for anyone with both turned off.

## Saved flights and replays

SAVED FLIGHTS, the dropdown on the right of the console's bar (`js/views/saved-menu.js`), is a log with one line per flight in the library (`data/flights/index.json`): its name, its date and its flight time (`summary.flightDurationS`). A LIVE line at the top goes back to the live console, and the line for what is on screen now is amber. A plain click on a line opens it in place. A middle click or Ctrl+click opens a new tab, since every line is a real link. It works from the keyboard: Enter, Space or the down arrow opens it, the up and down arrows move between lines, Home and End go to the ends, and Escape closes it and puts focus back on its button. Tabbing out of it or clicking anywhere else closes it too. It only reads the manifest, never a flight's data files.

While a replay is open, its name shows in the bar with `[ CLOSE ]`, the slim way back to live. Either way, back at `?track` a connected board is still connected and its data is still there.

### The saved flights

There are two. SAVED FLIGHTS lists them newest first, so the Komodo flight is on top.

- **Simulated flight, Komodo, Indonesia** (`komodo-sim-01`, 2026-11-14). A realistic flight from a real place. The pad is on open grass on top of a small island off the east coast of Komodo, at -8.5366, 119.5742, 105.7 m above sea level. Manta stands on a small beach about 360 m south of the pad. A northwest wind carries the rocket back over the island and out over the reef flat, and it comes down in shallow water about 150 m off the island's southeast shore, 650 m from the pad and 400 m from Manta. Apogee is about 3,018 m above the pad.
- **GPS and radio board simulated flight** (`gps-board-sim-01`, 2026-09-30). My first simulated flight, from a made-up site in California with a perfect GPS. It always has 10 satellites and HDOP 0.90, and every fix sits exactly where the rocket is. Its 700 m ground height is a placeholder, not the real ground there.

Both logs came out of my firmware's PC sim dump (`pio run -e pc_sim -t exec`). It runs my firmware's real GPS parser (`GpsParser`, built on TinyGPSPlus) and packet code (`Telemetry`) on a PC, fed by a simulated GPS that writes the same NMEA sentences a receiver sends. Each log here is a byte-for-byte copy of what that program wrote, so every packet in it was made by the same code the board runs. The page only reads the `SIM PKT` lines and the `SIM launch site:` line, and skips the rest.

### How the Komodo flight was made

I wanted a flight that looks like real GPS data. So I gave my firmware's simulated GPS a second flight, switched on with a build flag (`DOGTOOTH_SIM_KOMODO=1`), and a PC sim dump for it (`pio run -e pc_sim_komodo -t exec`). The flag only changes what the simulated GPS says. The parser, the packet and every line the program prints stay the same. I built it from firmware commit ee4b607 on the `pc-sim-dump` branch. The firmware change isn't in my firmware project yet. It is kept as a patch (`komodo-flight.patch`) until I add it.

I picked the places on the 3D view's satellite imagery and took the heights from Cesium World Terrain. The pad's ground is 145.76 m above the ellipsoid there, and the sea around the island is at 40.05 m, so the pad is 105.7 m above sea level.

The flight:

- 35 s on the pad, then liftoff, a 3 s burn, and a coast with air drag up to about 3,018 m above the pad.
- The rocket turns into the wind on the way up, so apogee is about 260 m west-northwest of the pad.
- The drogue opens 1 s after apogee and settles at about 26 m/s. The main opens 300 m above the pad and settles at about 5.5 m/s.
- The wind blows from the northwest, 6.8 m/s up high and 4.2 m/s near the ground. I picked northwest because the west monsoon starts there around November. The rocket lands at sea level, 105 m below the pad, and the log keeps going for 2 minutes while it lies in the water.

The simulated GPS does what a real receiver does:

- Every fix jumps a little, sized by that fix's HDOP. It is about 0.9 m on each axis at HDOP 1, and more when HDOP is worse.
- On top of that the position wanders slowly by a few meters, over tens of seconds to minutes.
- The fix drops for 4 s right at liftoff and comes back with only 5 satellites.
- The satellite count changes all through the flight. It is 9 to 12 on the pad, fewer after liftoff, dips under the drogue and again when the main opens, and is 8 to 10 with the board lying in the water. HDOP moves with it. Ten fixes fail the quality gate, so the map shows them as hollow grey dots.
- Altitude is about twice as noisy as position, as on a real receiver.
- Ground speed and course follow the real motion with a little noise, so the still board reports a small speed now and then (always under 0.5 m/s).
- After landing the fixes wander in a cloud about 11 m by 7 m, and the altitude drifts by about 10 m.

The noise comes from a seeded random number generator (seed 20261114), and each second's sentences depend only on that second. So making the flight again gives exactly the same packets. The log's first lines still say "placeholder values" next to the launch site, because the firmware prints that line the same way for every simulated flight.

To make it again:

1. Apply `komodo-flight.patch` to the firmware at commit ee4b607.
2. In the firmware folder, with CLion's MinGW at the front of the PATH, run `pio run -e pc_sim_komodo -t exec`. It writes `sim_output/komodo/pc_sim_flight.log`. Only the "Built" date line differs from the log here.
3. From the website folder, run `node flight-console/tools/add_flight.mjs --replace` with the same options as before (see "Adding a flight"), pointing `--file` at that log. The Komodo entry uses `--gs-lat -8.539775 --gs-lon 119.574933 --gs-alt 2` for Manta.
4. Run `node flight-console/tools/check_detection.mjs komodo-sim-01` and `node --test "flight-console/test/*.test.mjs"`.

### How one sample travels from the file to the screen

1. `library.js` downloads the flight's data file listed in `data/flights/index.json`.
2. `parser.js` turns each line into a normalized sample: `{ rocketId, t, type, gps, baro, imu, radio, power, status, extra }`. For my board's log it checks each packet's Fletcher checksum first and decodes the 34 bytes exactly like the firmware does. A simulator "phase" value goes into a separate truth list, never onto the sample.
3. `player.js` sorts every rocket's samples by time and feeds them to the store as its clock runs. At 5x speed it feeds five seconds of data per second of real time, and it never skips a sample.
4. `store.js` files the sample under its rocket, hands it to that rocket's own detector, and adds it to that rocket's breadcrumb trail (`track.js`).
5. `detector.js` updates ground level, altitude above ground and vertical speed, and returns any new events, like "Apogee detected".
6. The store tells every view something changed. Each view reads what it needs from the store and redraws: the map moves the board marker and adds a breadcrumb, the HUD and the phase bar move on, the timeline's playhead moves, and panel 2's mission timeline adds the event.

The views never talk to each other. They only read the store, which is why the live console can feed the same kind of store and every view follows the board. The one exception is the 3D view: `map-view.js` starts it and shares its controls, its notes, its label layer and the FOLLOW BOARD setting with it.

When a flight opens, `main.js` also runs the whole flight once through a second, hidden store (the "pre-scan", `prescanFlight()`). That gives the altitude timeline each rocket's whole altitude curve and the events to mark on it, gives panel 2's graphs their zero at liftoff, and gives the 3D view its starting distance, before playback gets there. Nothing from the pre-scan reaches the shown store, so the HUD, the map and the mission timeline only ever show what has happened up to the playhead. Live data has no pre-scan (an empty one is passed).

A seek resets the store and feeds it every sample again up to the new time, so the detectors and the views end up exactly where they would have been.

## Tests

From the website folder, with Node 22 or newer:

```
node --test "flight-console/test/*.test.mjs"
```

- `test/bench-parse.test.mjs` feeds the example block and a set of edge cases through the block parser and the CSV builder: a SEARCHING block, LOW and SILENT rates, `Error:` lines inside and between blocks, times past a minute and past an hour, skipped heartbeat numbers, a reconnect, a restart, unknown labels and lines before the first banner.
- `test/bench-terminal.test.mjs` checks the parser and the CSV against real serial output: two blocks in a row (heartbeats 3533 and 3534), copied character for character from my terminal during a bench test. The How it works page shows the same text, so the two must be changed together (see "The How it works page").
- `test/bench-feed.test.mjs` checks the bench feed: blocks become samples with a good fix only when they should, the store's clock keeps moving, a restart starts over, and a board on a desk shows a pad and fires no flight events. The desk runs use the page's own live store options (`LIVE_STORE_OPTIONS.bench`), including a 35 m GPS jump and a steady 40 m climb that must not read as liftoff. The same live store does see a real liftoff climb. A store with no ground station keeps none until a "gs" packet sets one. It also checks what the HUD would show for a board that goes quiet (no fix while the block says SEARCHING, the altitude old after 2 s, and silent with "10 S" after 10 s), through the store and `hudAge()` directly.
- `test/bench-wander.test.mjs` checks that a still board wandering for 30 minutes stays PAD, over many seeds, through both kinds of store and through the status block text. Jumps, steps, slow climbs and a settling GPS are never a liftoff, and a fix that comes back higher is only a liftoff when it is far higher, fast.
- `test/landing.test.mjs` runs 160 synthetic flights that land into the same bench wander: each must reach FLIGHT within 6 s of liftoff and RECOVERY within 30 s of touchdown, with the recovery position the average of the window's fixes. It also checks a low flight that never arms apogee, a board still moving along the ground (by the receiver's ground speed), and that the first saved simulated flight (`gps-board-sim-01`) still detects every event near the truth.
- `test/komodo-flight.test.mjs` loads the Komodo flight through the page's own library and store code. It checks that SAVED FLIGHTS lists it first with the old flight below it, that it parses with no bad rows and its satellite count and HDOP move, that every event fires once, in order, within 5 s of the simulator's truth, that the states go PAD, FLIGHT, RECOVERY, that the trail has a gap at the liftoff fix loss and a few weak fixes under the parachutes, and that the recovery position is within 15 m of the simulator's true landing point (it comes out about 5 m off).
- `test/flight-state.test.mjs` checks `js/flight-state.js`: the four states, the pad checklist and its thresholds (edges included), the recovery block from Manta or from the launch point, bearings and distances in capitals, ground speed, `eventCrumb()`, `packetRate()`, and the hard cases: a connected board that is silent, the fix lost on the pad, the link going quiet in flight, a replay seeking backward, a board restart, and data that starts in flight.
- `test/track.test.mjs` checks `js/track.js`: the quality gate, outlier rejection, the smoothed line (the dots stay raw), gaps, speeds and the speed colors, and that the store keeps the samples (and so the CSV) raw.
- `test/store-switch.test.mjs` checks `js/store-switch.js`: every store method answers from the store in use, `use()` sends one `'source'` change and the old store goes quiet, a listener that throws doesn't stop the others, and only stores go in.
- `test/library.test.mjs` checks the optional `groundStation` in `index.json`: `library.js` checks it and passes it through, a store made with it starts there, and `add_flight.mjs` takes `--gs-lat`, `--gs-lon` and `--gs-alt` (run on a copy of the library in the system's temp folder, so the real `index.json` is never touched).
- `test/serial-link.test.mjs` checks the serial link with a fake port: lines split across USB chunks come out whole, and a listener that throws on one line doesn't stop the reading or send the same lines again.
- `test/live-sources.test.mjs` checks the source detector: the banner means a Dogtooth board, other lines don't, a new connection starts over, unknown data is called unknown, and the Manta hook is there but switched off.

`test/synthetic.mjs` isn't a test itself. It makes seeded, repeatable GPS data for the tests: a still board's wander (what my bench board did, about 15 m by 30 m sideways with worse altitude, plus single wild fixes, steps, lost fixes and a cold start) and whole flights that land into it.

### Checking the parser

`js/bench/parse.js` and `js/bench/csv.js` have no DOM, so Node runs them directly, like the other files listed under "Code that works without a page". To check a change to the status block format, run `node --test flight-console/test/bench-parse.test.mjs flight-console/test/bench-terminal.test.mjs`. To check detection on a saved flight, see "Checking detection".

## Files

### Page

- `index.html`: the page itself. It holds the site's nav and footer (copied from the home page), the landing's text, the console (the bar, the status lines, the two panels and the `[ GRAPHS ]` and `[ MAP ]` switches, with panel 2's live parts (the live mission timeline's `#bc-log` spot among them) and the empty spots the views fill in), and the script tags for Leaflet and `js/main.js`. Its comments say what each part is. It has no tag for CesiumJS on purpose (see "Loading and failures").
- `flight-console.css`, `flight-console-hero.css`, `flight-console-map.css` and `flight-console-data.css`: this page's styles, one file per part (see "The stylesheets and who owns what").
- `../css/flight-console-theme.css`: the colors, fonts and shared pieces of all three Flight Console pages (see "The look: colors and fonts").
- `README.md`: this guide.
- `.gitignore`: keeps `js/config.local.js` out of Git.

### Data

- `data/flights/index.json`: the flight library list (the "manifest"). A static site can't list its own folders, so this file is the only way the page knows which flights exist.
- `data/flights/komodo-sim-01/pc_sim_flight.log`: the Komodo flight, a byte-for-byte copy of the log my firmware's PC sim dump wrote with the Komodo flight switched on. See "The saved flights".
- `data/flights/gps-board-sim-01/pc_sim_flight.log`: my first simulated flight. It is a byte-for-byte copy of the log my firmware's PC sim dump program wrote.
- `data/flights/gps-board-sim-01/cover-3d.webp`: that flight's cover picture. The home page's Flight Console slide shows it. See "A flight's cover picture".
- `data/flights/.gitattributes`: tells Git to leave the log files' line endings alone, so the copies stay exact.

### Code that works without a page (Node can run it too)

- `js/config.js`: every number and setting I might want to change: detection thresholds, the trail's quality gate, the pad checklist, the demo ground station position, playback speeds, redraw rates, the map tile addresses, keys and credits, the 3D camera, timeouts and the colors. Each one has a short comment.
- `js/config.local.js`: my local CARTO map key, only on my laptop. Git ignores it (see "Map keys").
- `js/schema.js`: the channel registry. It lists every value a board can send, which sensor group it belongs to, its label and unit, and the names different files use for it. It also has `hasGoodPosition()`, the test every rocket position goes through before the page trusts it. Ground station packets use a lighter check (a fix plus latitude and longitude) because they may not carry an altitude.
- `js/parser.js`: the only code that understands flight file formats. It reads CSV files, JSON lines (including ground station position packets), and my firmware's serial output: `SIM PKT` hex lines from the simulator and `PKT` key=value lines from the bench_rx receiver. A bench_rx line missing any of its fields counts as a bad line, since those text lines have no checksum and a cut-off number would otherwise look real. If a board restarts mid-log, its clock starts over, so the parser shifts the later times to follow on and adds a note that About this flight shows.
- `js/library.js`: loads and checks `index.json`, skipping broken entries without breaking the rest, and loads one flight's files. It also checks an entry's optional `groundStation`.
- `js/fleet.js`: who each rocket is: name, short name (`callsign`), color and board. A rocket ID nobody registered gets the next color and a plain name.
- `js/geo.js`: distance and bearing between two positions, compass names, and number, time and distance formatting.
- `js/detector.js`: ground level, altitude above ground, vertical speed, the flight events and the recovery position, one sample at a time (see "Detection").
- `js/track.js`: the breadcrumb trail, `TRACK_RAMP` and `speedColor()` (see "The breadcrumb trail").
- `js/flight-state.js`: what Track a Rocket shows right now, from the store: `flightState()`, `padChecklist()`, `recoveryInfo()`, `groundSpeed()`, `eventCrumb()`, `packetRate()` and two formatters for the HUD.
- `js/store.js`: holds everything the console knows right now: rockets, samples, events, detectors, trails, the ground station (or none, for live data), the focused rocket and the current time. Views subscribe to it. Its ground station has a `source`: `'config'` for the demo position (the views call it the demo position), `'flight library'` for a flight's own Manta position, or the real one from a "gs" packet.
- `js/store-switch.js`: the store switch the stage reads (see "The stage and the store switch").
- `js/player.js`: the playback clock for saved flights: play, pause, speed, seek and replay.
- `js/truth-check.js`: compares detected events with the simulator's true phases. Only the check tool and the tests use it. The page never loads it, and the detector never does.
- `js/bench/parse.js`: the Dogtooth status block format and every name the console matches (see "Names the console knows").
- `js/bench/csv.js`: builds the CSV file.
- `js/live/sources.js`: the source detector, and the Manta hook.
- `js/live/bench-feed.js`: turns the board's blocks into samples for the live store. It also holds the live stores' options (`BENCH_DETECTOR` and `LIVE_STORE_OPTIONS`).
- `js/views/data-series.js`: the points for panel 2's graphs in a replay (see "Panel 2: graphs and readings").

### Code for the page

- `js/main.js`: picks the screen from the address, runs the routing, makes the live session and the stage, sets `ctx.session` and the console's `data-mode` and `data-state`, loads saved flights, runs the pre-scan, and makes each replay's player, timeline and panel 2. It also keeps `--fc-tl-space`, `--fc-ctl-space` and `--fc-corner-h` up to date, hands the live store to the live mission timeline (`showEvents()`), and scrolls RAW OUTPUT into view inside panel 2 (`revealInPanel()`). The "MANTA HOOK" is here.
- `js/hero-currents.js`: the moving ocean currents and the two hidden tuna behind the landing's hero. It exports `startCurrents(canvas, options)`, which returns `stop()`, and `buildFishField(d)` and `traceFishLines()` for tests.
- `js/live/serial-link.js`: the serial port, opened with Web Serial at 115,200 baud and read line by line.
- `js/live/bench-panel.js`: the CONNECT button (its words and its square), the NO SERIAL PORTS warning, and panel 2 for a board on USB: the live mission timeline strip (`showEvents()`), the errors strip, readings, graphs, raw output and SAVE AS CSV. It finds its parts by the `bc-*` ids in `index.html`.
- `js/bench/charts.js`: draws the graphs on canvas (`TimeChart`), live and in a replay, in the colors from the `--bc-*` variables (the browser works each one out, `color-mix` included) and the readout font. Before any data a graph says NO DATA.

### Views (they draw parts of the page)

- `js/views/dom.js`: small helpers for building page elements (HTML and SVG), limiting how often a view redraws, checking for reduced motion, drawing an event's mark by how it was found, and copying text (`copyText()`).
- `js/views/icons.js`: the few button icons the map uses, and `iconNode()`, which turns markup from here or from `markers.js` into an element.
- `js/views/markers.js`: the look of everything the map and the 3D view draw: the breadcrumb dots and line, the board marker, the launch point, Manta's dish, the event diamond, the recovery crosshair, the packet ring, the radio link and its traveling dot, the ground shadow's sizes, and the small samples of each for the KEY (the gap and the packet ring included).
- `js/views/map-labels.js`: the label layer both views share (DOGTOOTH, MANTA, LAUNCH POINT, APOGEE).
- `js/views/launcher.js`: types the landing's title and starts its ocean currents (`js/hero-currents.js`).
- `js/views/saved-menu.js`: the SAVED FLIGHTS dropdown: one line per flight (name, date, flight time), a LIVE line, the keyboard, and notes when the library didn't load or an entry had to be skipped.
- `js/views/panels.js`: the two panels: the `[ GRAPHS ]` and `[ MAP ]` switches, the left and right arrow keys (and where they belong to something else), keeping the panel off screen inert, and putting back any sideways scroll of the panel track.
- `js/views/esri.js`: asks Esri once whether it accepts the satellite key, and makes the satellite tile layer, which checks how deep Esri's photos go at each place before asking for a tile. Every map in the visit shares both.
- `js/views/hud.js`: the HUD over the 3D view (see "The HUD").
- `js/views/hud-text.js`: only `hudAge()`, the HUD's short ages ("4 S", "2 MIN"). `hud.js` and `test/bench-feed.test.mjs` use it.
- `js/views/rocket-bar.js`: one chip per rocket, only for flights with two or more rockets. Click one to focus it.
- `js/views/phase-strip.js`: the phase bar (see "The phase bar and the rocket chips").
- `js/views/map-view.js`: the map's frame, the controls row, the KEY and where it opens, the loading and failure messages, the bottom right corner and where it sits, watching the HUD's covers, the 2D map with its FOLLOW BOARD, and the NO MAP panel (see "The map and 3D view").
- `js/views/globe-view.js`: the 3D view. It makes the Cesium viewer, draws the breadcrumbs, the ground shadow, the markers and the radio link, looks up ground heights and moves the camera, the follow camera included (see "FOLLOW BOARD").
- `js/views/cesium-loader.js`: downloads CesiumJS when the 3D view opens.
- `js/views/timeline.js`: the altitude timeline and the playback buttons (see "The altitude timeline").
- `js/views/data-panel.js`: panel 2 for a store, in a replay (see "Panel 2: graphs and readings").
- `js/views/data-readings.js`: panel 2's full readings list for a store.
- `js/views/event-log.js`: the mission timeline strip in panel 2, in a replay (through `data-panel.js`) and live (through `bench-panel.js`). `ctx.waitingText` sets what the open list says before the first event.
- `js/views/flight-info.js`: the About this flight strip in panel 2.

### Tests and tools (run with Node from the website folder)

- `test/*.test.mjs` and `test/synthetic.mjs`: see "Tests".
- `tools/add_flight.mjs`: adds a flight to the library.
- `tools/check_detection.mjs`: prints the detected events for a flight and compares them with the simulator's truth.

### Version numbers

GitHub Pages lets a browser keep a file for 10 minutes. So when a file changes, its `?v=` number goes up everywhere it's loaded, or returning visitors get the old copy, and a new `main.js` mixed with an old cached module might not even start.

- The stylesheets, the theme and `js/main.js` are loaded from `index.html` with a `?v=`.
- Modules work the same way: the file that imports a changed module bumps the `?v=` on that import. Every file that imports a module must use the same query, since two different addresses would load a module twice.
- A new file starts with no query, and gets one the first time it changes after that.
- `js/config.js` is imported with no query by most files, so an old cached copy can meet new code. New code is only safe with an unversioned `config.js` as long as it only uses settings an old copy also has. A new setting that other files need either goes in the file that uses it (the way the marker sizes live in `markers.js`), or `config.js` gets a query on every import at once.
- The How it works page versions its own `../css/flight-console-overview.css` and `../js/flight-console-overview.js` the same way.

## The library file, index.json

Each flight in the `flights` list has these fields:

- `id`: a short name made of letters, numbers, `-` and `_`. It is the folder name under `data/flights/` and the value after `?flight=`.
- `title`: shown in SAVED FLIGHTS and on the replay's name in the console's bar.
- `date`: the flight date as `YYYY-MM-DD`. SAVED FLIGHTS shows it, newest first.
- `kind`: `"simulated"` or `"real"`. The page always shows which one it is.
- `featured`: `true` for one flight. The page no longer shows it differently, but `add_flight.mjs` still keeps it on only one flight.
- `description`: one or two plain sentences.
- `site`: the launch site's name.
- `groundStation` (optional): `{ lat, lon, altMsl }`, where Manta stood for that flight. `altMsl` can be left out. `library.js` checks it, and a broken one skips the entry. `main.js` gives it to the replay's store, so the radio link, the HUD's distances and the recovery block measure from Manta instead of the demo position. Without it, the replay uses the demo position in `config.js`, and the HUD marks it as the demo spot.
- `cover` (optional): a picture of the flight. The Flight Console page doesn't show it. The home page's Flight Console slide shows the first simulated flight's. See "A flight's cover picture". It has:
  - `file`: the picture's name inside the flight's folder.
  - `alt`: what the picture shows, for screen readers.
  - `credit`: the credit line for the picture's imagery and terrain. It shows on the picture.
- `rockets`: one entry per rocket, each with:
  - `rocketId`: the rocket's ID. If only one rocket lists a file and the file holds one board ID, every sample in that file gets this ID. A file with several board IDs keeps them, so each rocket that lists it should use one of those IDs.
  - `name`: shown everywhere the rocket is named.
  - `board`: a short board description.
  - `file`: the data file's name inside the flight's folder. Several rockets can list the same file if it has a rocket ID column.
  - `timeOffsetS` (optional): seconds added to that file's times, to line up boards whose clocks started at different moments.
- `summary`: filled in by `add_flight.mjs` from the real data.
  - `rocketCount`: how many rockets.
  - `maxAglM`: the highest altitude above ground, in meters.
  - `flightDurationS`: seconds from liftoff to landing, or the whole data span if either wasn't detected. SAVED FLIGHTS shows it as the flight time.
  - `sensors`: the sensor groups found, like `["gps"]`.
  - `events`: the flight events detected.
  - `padPoint`: `[latitude, longitude]` of the launch pad (the last good position before liftoff), or `null`. While a replay downloads, the camera flies toward it.
  - The rest fed an old launcher card. The page doesn't show them, but `add_flight.mjs` still fills them in and they cost nothing to keep. They all describe one rocket, the one that flew highest:
    - `trackRocketId`: which rocket that is.
    - `track`: its path as `[latitude, longitude]` pairs, simplified to at most 60 points. Only good GPS positions are in it.
    - `trackGaps`: the places in `track` where the GPS had no fix, or nothing came in for longer than `LINK_STALE_S` (a radio silence). Each number is the index of the first point after a gap. If the GPS drops out so often that every gap won't fit in 60 points, the shortest stretches between gaps join the gap around them, so missing data is never drawn as a solid line.
    - `landingPoint`: `[latitude, longitude]` of the landing point (the first good position once the landing was detected), or `null` with no detected landing.
    - `altProfile`: its altitude as `[seconds from liftoff, meters above ground]` pairs, simplified to at most 60 points, from 10 s before liftoff to 10 s after landing. A pair with `null` meters marks a gap with no altitude reading (no fix, or a radio silence longer than `LINK_STALE_S`).
    - `driftM`: meters from the pad to the landing point.
    - `maxGsDistanceM`: the farthest the rocket got from the ground station, in meters.
    - `gsDemo`: `true` when those ground station distances use the demo ground station position from `config.js`, because the entry had no `groundStation` and the data had no ground station GPS packets.
  - Any summary value can be `null`. SAVED FLIGHTS leaves a missing flight time blank.

## Adding a flight

1. Put the log file somewhere on my computer. It stays where it is. The tool only reads it.
2. From the website folder, run (all on one line):

   `node flight-console/tools/add_flight.mjs --id my-flight-01 --title "My first real flight" --kind real --date 2026-10-18 --file "C:\path\to\flight.log" --rocket-name "GPS and radio board" --board "SAMD21, SAM-M8Q GPS and E22 LoRa radio" --site "Launch site name" --description "One or two plain sentences."`

   Add `--gs-lat` and `--gs-lon` (both or neither), and optionally `--gs-alt` in meters above sea level, to say where Manta stood for that flight. They go in the entry as `groundStation`, and the summary's ground station distances are measured from there (`gsDemo` false). Add `--featured` to make it the featured flight (this clears the flag on the others). Add `--replace` to overwrite a flight that already has that id.
3. The tool checks everything first: the id and date, the file names, the rocket IDs, the ground station numbers, and that every rocket has readable data. If anything is wrong it stops and writes nothing. Then it copies the file into `data/flights/my-flight-01/`, runs it through the same parser, detector and store the page uses, fills in the summary, and updates `index.json`. It prints what it found.
   To redo the summary for a flight that's already in the library (after a change to the detector or the tool), run the same command again with `--replace`. The `--file` has to point at a copy outside `data/flights/`, since the tool won't copy a file onto itself. The copy is byte for byte, so the log in the library doesn't change.
4. Run `node flight-console/tools/check_detection.mjs my-flight-01` to see the detected events.
5. Refresh the console. The new flight is in SAVED FLIGHTS.

For a flight with several rockets in separate files, repeat `--file` once per rocket. The first `--rocket-name`, `--board` and `--rocket-id` go with the first `--file`, and so on. Every board sends node ID 1 until it gets its own number, so two boards' files need `--rocket-id` (for example `--rocket-id a --rocket-id b`). A single file that holds several rocket IDs, like a ground station log, becomes one rocket entry per ID automatically.

## A flight's cover picture

A flight can have a cover picture, a screenshot of its 3D view. The Flight Console page doesn't show covers, but the home page's Flight Console slide shows the first simulated flight's cover, so its `cover` entry and its file stay. The Komodo flight has no cover.

A cover is added by hand. The tool doesn't make one.

1. Open the flight in the 3D view and take a screenshot with the HUD out of the way. Mine is 5 wide by 6 tall (1400 by 1680 pixels), with the whole flight in the middle and plain ground and sky around it.
2. Save it in the flight's folder, for example `data/flights/my-flight-01/cover-3d.webp`.
3. Add `cover` to the flight's entry in `index.json`, with `file`, `alt` and `credit`.

A screenshot of the 3D view uses Cesium ion's imagery and terrain, so it needs their credits. Open "Data attribution" in the 3D view at the same camera position and copy what it lists into `credit`.

Running `add_flight.mjs` with `--replace` keeps the flight's cover. If the flight's data changed, take a new screenshot, because the old one shows the old flight.

The picture in the site's `index.html` points straight at `data/flights/gps-board-sim-01/cover-3d.webp`, so a new screenshot saved under the same name shows up there by itself. The alt text and the credit on that slide are typed in by hand, copied from the flight's entry in `index.json`. A new screenshot usually needs new alt text, because the alt text describes what the picture shows. If the cover's file name, alt text or credit changes, update the home page to match.

## Checking detection

`node flight-console/tools/check_detection.mjs gps-board-sim-01` prints the thresholds, every detected event, and, for simulated flights, how far each event is from the moment the simulator's phase really started. It flags anything more than 5 seconds off (change it with `--tolerance`), any event that fired twice, and any event that never fired. The exit code is 1 when anything is flagged, so it can run as a quick test.

## Settings worth knowing about

These are in `js/config.js` unless it says otherwise.

- Detection thresholds: `PAD_*`, `LIFTOFF_*`, `APOGEE_*`, `DROGUE_*`, `MAIN_*`, `DESCENT_CONFIRM_S`, `LANDED_*`, `START_FALL_*`, `VSPEED_AVG_S` and `GROUND_ELEV_FALLBACK_M` (see "Detection"). `DETECTOR_DEFAULTS` collects them in the shape `createDetector()` expects. Every time setting is in seconds.
- The trail: `MIN_SATS`, `MAX_HDOP`, `OUTLIER_MAX_SPEED_MPS`, `OUTLIER_MIN_JUMP_M`, `OUTLIER_RESET_FIXES`, `TRACK_GAP_S`, `LINE_SMOOTH_FIXES`, `LINE_SMOOTH_MAX_M`, `TRACK_SPEED_GAP_MAX_S` and `TRACK_SPEED_MAX_MPS` (see "The breadcrumb trail"). `MAX_HDOP` is also where the HUD's HDOP line turns amber.
- The pad checklist: `PAD_READY_MIN_SATS`, `PAD_READY_MAX_HDOP`, `PAD_READY_MIN_PKT_PER_S` and `PAD_LINK_WINDOW_S` (see "The pad checklist").
- `GROUND_STATION`: the demo ground station position for replays without their own, 1 km southwest of the simulator's placeholder pad. Once the real ground station sends its own GPS position, the page uses that instead. Live data never uses the demo position (see "The live stores").
- `LINK_STALE_S` and `ALTITUDE_STALE_S`: how long before a quiet rocket, or an old altitude, is shown as old instead of live. `LINK_STALE_S` also decides where a radio silence breaks the altitude timeline's curve, and when LAST FIX turns amber.
- `LEVEL_VSPEED_MPS` (0.5): VS shows an up or down arrow only when the speed on screen, rounded to 0.1 m/s, is more than this, in the HUD and in panel 2's readings. GPS height noise on a board lying still reads as about 0.3 m/s either way.
- `PLAYBACK_SPEEDS`, `DEFAULT_SPEED` and `MAX_FRAME_STEP_S`: the speed buttons, the speed a flight starts at, and the longest step the playback clock takes in one frame.
- The `..._MAX_FPS` values: how often each part of the console redraws during playback (`HEADER_MAX_FPS` for the phase bar, `ROCKET_BAR_MAX_FPS`, `STATS_MAX_FPS` for the HUD, `MAP_MAX_FPS` for the map and the 3D view, `LOG_MAX_FPS` for the mission timeline and `CONTROLS_MAX_FPS` for the altitude timeline). `SCRUB_SEEKS_PER_S` limits seeks while the timeline is dragged. Panel 2 has its own, `DRAW_MAX_FPS` in `js/views/data-panel.js`.
- `TIMELINE_KEY_STEP_S` and `TIMELINE_KEY_BIG_STEP_S`: how far the arrow keys (and Shift with an arrow, or Page Up and Page Down) move the playhead on the altitude timeline.
- `EVENT_NOW_S`: how long after an event the mission timeline's NOW tag stays on it. `LOG_AUTOSCROLL_PX` and `LINK_COPIED_MS` are small view settings next to it.
- `TILE_API_KEY`: the public CARTO key for the dark map on the live site. See "Map keys" below.
- `ESRI_API_KEY`: the Esri key for the satellite map. It expires 9/30/2027. See "Map keys" below.
- `DEFAULT_MAP_LAYER`: the map background a first-time viewer sees (`'satellite'` or `'dark'`).
- `SATELLITE_MAX_NATIVE_ZOOM`: the deepest zoom the satellite map ever asks Esri for (20). Where Esri has no photo that deep, the deepest one it has is scaled up (see "Satellite (Esri)").
- `SATELLITE_SURE_ZOOM`: photos exist down to this zoom everywhere (13), so tiles up to it are asked for without checking.
- `SATELLITE_TILEMAP_URL` and `SATELLITE_TILEMAP_BLOCK`: where the satellite layer asks which tiles exist, and how many tiles across one answer covers (32).
- `HALO_COLOR`: the near-black outline under the dots, the line and the markers that keeps them visible on bright photos and dark water.
- `MAP_DEFAULT_ZOOM`, `FIT_PADDING_PX`, `FIT_MAX_ZOOM` and `FOLLOW_EDGE_PX`: the 2D map's zoom with one point, its first framing, and how close the board gets to an edge or the HUD before FOLLOW BOARD pans.
- `TILE_FAIL_COUNT`, `TILE_FAIL_TIMEOUT_MS` and `LIBRARY_LOAD_TIMEOUT_MS`: when the tiles count as failed, and how long to wait for Leaflet.
- `DEFAULT_VIEW`: the view a flight opens on (`'3d'` or `'map'`).
- `CESIUM_VERSION`: the CesiumJS release the 3D view loads. `CESIUM_ION_TOKEN` is the Cesium ion token (see "Map keys").
- `CESIUM_LOAD_TIMEOUT_MS` and `TERRAIN_SAMPLE_TIMEOUT_MS`: how long to wait for Cesium to download, and for the terrain and a ground height, before giving up. `GLOBE_READY_TIMEOUT_MS` is the longest the 3D view waits for its first picture once Cesium has downloaded.
- `PAD_RESAMPLE_M`: how far a launch pad has to move before its ground height is looked up again.
- `GLOBE_START_HEADING_DEG`, `GLOBE_START_PITCH_DEG`, `GLOBE_START_RANGE_PER_APOGEE`, `GLOBE_START_RANGE_MIN_M` and `GLOBE_START_RANGE_MAX_M`: the 3D camera's starting angle and distance.
- `GLOBE_ZOOM_MIN_M` and `GLOBE_ZOOM_MAX_M`: how close and how far the 3D camera can zoom.
- `GLOBE_ORBIT_DEG_PER_PX` and `GLOBE_ZOOM_PER_NOTCH`: how fast a drag turns the 3D camera and how much one wheel notch zooms. Lower both for a calmer view. `GLOBE_KEY_TURN_DEG` and `GLOBE_KEY_ZOOM` do the same for the keyboard.
- `GLOBE_PITCH_MIN_DEG`, `GLOBE_PITCH_MAX_DEG` and `GLOBE_GROUND_CLEARANCE_M`: how steep and how flat the 3D camera can look, and how far it stays above the ground. `GLOBE_MOVE_MS` is how long it takes to glide to a new view (WHOLE FLIGHT, RESET VIEW and a short trip to a near site). The follow camera has its own glide, `FOLLOW_GLIDE_MS` in `globe-view.js`.
- `GLOBE_MAX_PIXEL_RATIO`: the sharpest the 3D view draws on high-resolution screens. Lower it to save battery.
- `COLOR_WHITE` and `THERMAL_RAMP`: hex copies of the theme's white and its ironbow ramp, for code that can't read CSS. The near-black is `HALO_COLOR`, and `PAD_COLOR` is the off-white of the launch point, the dish and the board marker's outline. `ROCKET_PALETTE` gives each extra rocket a white or grey, so they stay apart from the focused rocket's speed colors.
- In `js/views/markers.js`: the sizes of everything on the map, like `DOT_PX`, `LINE_PX`, `RING_PX` and `RING_MS` (the packet ring), `LINK_SOLID` and `LINK_TRAVEL_MS` (the radio link), `SHADOW_*` and `SHADOW_EDGE_*` (the 3D ground shadow and its light edge), and `BOARD_BLUE`, the board marker's blue.
- In `js/views/map-view.js`: `THREE_SLOW_MS` and `THREE_RETRY_MS` (the 3D loading message and retries), `LABEL_FAR_ZOOM` (where the 2D labels fade out), `WHOLE_ROOM_PX` (WHOLE FLIGHT's room), `CORNER_*` (the bottom right corner) and `LEGEND_*` (where the open KEY goes). In `js/views/globe-view.js`: the sky, haze and horizon settings at the top, the flight settings (`FLY_*` and `GROUND_GUESS_M`), `LABEL_FAR_M_PER_PX` (where the 3D labels fade out), and the follow camera's `FOLLOW_*` and `RECOVERY_*` (see "FOLLOW BOARD").
- In `js/views/hud.js`: `FIELD_CH` and `UNIT_CH`, the fixed widths of the HUD's values and units, in characters. In `js/views/timeline.js`: `MIN_PLOT_PX` and the peak label's settings. In `js/bench/charts.js`: `MIN_TICK_GAP_PX`.
- In `js/hero-currents.js`: the CONFIG block for the hero, with `FISH_VISIBILITY` (0.6), and `PHONE_FISH_VISIBILITY` (0.1) just under it (see "The landing").
- The page's colors and fonts come from `../css/flight-console-theme.css`. The tokens at the top of `flight-console.css` give them jobs.

## Map keys

The 2D map, the fallback when the 3D view can't run, has two backgrounds, picked with its SATELLITE and DARK MAP buttons. Satellite is the default. The browser remembers each viewer's choice (in localStorage, under `MAP_LAYER_STORAGE_KEY`). If the browser blocks storage, the choice just isn't remembered.

### Satellite (Esri)

The photos come from Esri's World Imagery service, and the labels on top (roads, road names, places and borders) come from Esri's Static Basemap Tiles service. Both need the Esri key in `ESRI_API_KEY` in `js/config.js`.

- It is an ArcGIS Location Platform key with only the Basemaps privilege. In Esri's dashboard it is limited to dogtoothsystems.com, www.dogtoothsystems.com, chrispsparrow.github.io and http://localhost:8000, so it is safe to publish.
- It expires 9/30/2027. To renew it, make a new key (or extend this one) in the Esri Location Platform dashboard and paste it into `ESRI_API_KEY`.
- Before showing any photos, the page asks Esri once whether it accepts the key (`js/views/esri.js`). If Esri says no (an expired key, for example), or the photos keep failing to load, the page switches to the dark map and says satellite imagery isn't available right now. The viewer's choice stays "Satellite", so the next visit tries again.
- How deep the photos go depends on the place: zoom 20 on my campus in Boston, 19 at the California site, 18 at Komodo, 17 in the Sahara and 13 over open ocean. Asking for a tile that isn't there fails, and the map used to show holes and the console filled with failed requests. Now, for a tile deeper than `SATELLITE_SURE_ZOOM`, the layer first asks the same World Imagery service, with the same key, which tiles exist (its "tilemap"). One answer of about 2 KB covers 32 by 32 tiles of one zoom, the browser keeps it for a day, and the page keeps it for the visit. Where the photo isn't there, the deepest one that is gets scaled up to fill its place. Wheeling in from zoom 13 to 20 over one spot costs about 7 to 9 of these answers. If the tilemap can't answer, the layer asks for the tiles as before. Esri's labels and the dark map have tiles at every zoom the map uses, so they need no check.
- Esri asks for "Powered by Esri" and each layer's data credit on the map. Those are in `js/config.js` (`ESRI_POWERED_BY`, `SATELLITE_ATTRIBUTION`, `SATELLITE_LABELS_ATTRIBUTION`). The page shows them only while the satellite map is on.

### Dark map (CARTO)

The dark map comes from CARTO's "Dark Matter" tiles, and CARTO wants a key on every tile request. Without a key, every tile is a picture that says "API key required". I have two CARTO keys.

- The public key is in `TILE_API_KEY` in `js/config.js`. In CARTO's dashboard it is limited to pages on dogtoothsystems.com, www.dogtoothsystems.com and chrispsparrow.github.io. CARTO checks which page asked for each tile (the Referer), so the key only works on my site and is safe to publish. CARTO refuses it on localhost.
- The local key is for previewing on my laptop. It goes in `js/config.local.js` as `TILE_API_KEY_LOCAL`. That file is listed in `flight-console/.gitignore`, so Git never commits it and it never reaches the live site.

How the page picks one: `js/main.js` checks where the page is running. On localhost or 127.0.0.1 it loads `config.local.js` and uses its key. Anywhere else it uses the public key and never asks for `config.local.js`, so the live site has no missing-file errors. If the local key is empty or the file is missing, the map draws on a plain background and says the local key is missing.

To set up another computer, create `flight-console/js/config.local.js` with this one line, using the local key:

`export const TILE_API_KEY_LOCAL = 'your-local-key';`

### 3D view (Cesium ion)

The 3D view's terrain (Cesium World Terrain) and its aerial imagery (ion's default imagery) come from Cesium ion, which needs the token in `CESIUM_ION_TOKEN` in `js/config.js`.

- In ion's dashboard the token is limited to dogtoothsystems.com, www.dogtoothsystems.com, chrispsparrow.github.io, http://localhost:8000 and http://127.0.0.1:8000. It only has the `assets:read` scope, so it can read terrain and imagery and can't change anything in my account. That makes it safe to publish. It never expires.
- If ion turns the token down, the 3D view still opens. The ground is flat and plain, and notes say the ground height is approximate and the imagery didn't load.
- Cesium's logo and data credits show in the bottom right corner of the 3D view. They are required, so they always show.

## The How it works page

`/projects/flight-console.html` explains the whole system. Its own files are `../css/flight-console-overview.css` and `../js/flight-console-overview.js`, and it shares the theme (`../css/flight-console-theme.css`).

**The scroll tour.** A tall wrapper (`.fco-tour`) holds a sticky stage. The script maps the scroll position to a timeline (the `T` constants near the top of `js/flight-console-overview.js`) and moves one scene through four steps:

1. A close-up of the board.
2. The board shrinks straight into the rocket's avionics bay while the rocket's outline fades in.
3. The flame lights, the rocket shakes on the pad and climbs up the screen. The view pulls back, never letting the nose leave the frame, and the radio signal travels down to Manta.
4. The view pans to the laptop.

The scene sits centered in the window, and the four sentences take turns on its left and right (under it on a phone). Everything follows the scroll position, so it looks the same scrolling either way or after a reload. Only the flame's flicker and the shake run on time. They are CSS keyframe loops, switched on with the `is-lit` and `is-shaking` classes while they are on screen, and only inside `prefers-reduced-motion: no-preference`. With reduced motion the page shows four still pictures, each with its sentence, on alternating sides.

**The flame** has three SVG layers, each widest at the nozzle and tapering to a point: a faint amber glow a little wider than the body, the amber flame about as wide as the body, and a pale core in `--fc-ramp-6` (#FFF1B0). It flickers with three loops of different lengths: the whole flame stretches and narrows, the core jumps in length, and the glow pulses.

**The fade under the nav.** The nav and the back link stay put while the page scrolls under them. A fixed layer between them and the page, `.fco-veil`, is the page's own near-black. It is solid down to `--fco-clear` (the nav's height plus 2.4rem, just under the back link) and then fades to clear over 2rem, so text or a picture scrolling up fades out before it reaches their letters. Over the bare background it can't be seen. The script places the tour's scene below the veil (its measured height, less 8 px), so the climbing rocket is never dimmed. The phone layout and the reduced motion pictures start below it too.

The laptop's screen is still a placeholder. The HTML comment next to it says how to swap in a real screenshot (`assets/flight-console/console-screen.webp`).

**What I built.** The board's real serial output (two status blocks, 3533 and 3534) beside the same reading in the 3D view, with a caption above both panels and an amber arrow between them. The two panel labels are written in sentence case, as typed, in Share Tech Mono.

- The terminal text must match `TERMINAL` in `flight-console/test/bench-terminal.test.mjs` character for character. Change both together.
- The older block is dimmed (`.fco-term-old`). In the newer block the values that changed are amber (`.fco-term-mark`).
- The serial output sits in `.fco-term-box`. On narrow screens, where it scrolls sideways, the script fades the edge that has more text hidden behind it (`has-more-left` and `has-more-right`).
- The 3D picture is `assets/flight-console/bench-test-3d.webp`, 1100 by 1430 px. It was taken from the real Track a Rocket page, with a fake serial board sending block 3534's reading once a second, so the HUD shows the pad checklist. Its frame is as tall as the terminal panel on a wide screen and exactly the picture's 1100 by 1430 shape when stacked, and the picture fills it, centered (`object-fit: cover`). Shoot a replacement at 1100 by 1430 px, and read its credits again from the 3D view's "Data attribution" at the same camera spot.

## What the page promises

- It never shows a made-up position. With no GPS fix the HUD says NO FIX and shows how old the last good position is, and the board marker turns hollow at its last good position. A rocket that stops sending shows its packets as old the same way. On the map and in 3D a gap in the packets is a break in the line, never a bridge. On the altitude timeline a stretch with no altitude, or nothing heard for longer than `LINK_STALE_S`, is a break in the curve.
- The dots on the map are the raw fixes. Only the line is smoothed, never across a gap and never far from its fix. Weak fixes are shown as hollow rings and kept off the line, and impossible jumps aren't drawn. The graphs and the CSV are raw.
- Old numbers never look live. When there is no new altitude, the HUD turns that line amber with its age, and VS shows `--`. Warnings are amber.
- It never shows orientation it doesn't have. The board marker always stands upright and never turns.
- It only shows values a board actually sent. Missing values show `--`, never 0, and a sensor section only appears if that rocket sent that sensor.
- Every event says how it was found: "reported" (the board said so), "detected" (measured from altitude) or "inferred" (worked out from the descent rate). The timeline markers and the mission timeline draw it the same way: a filled dot for reported, a ring for detected, and a dashed ring for inferred or estimated.
- A board on a desk can't fake a liftoff, and a landing needs the board to really sit still. The recovery position is an average of fixes, never one fix on its own.
- It always says where the data came from and whether the flight is simulated, real or live, and when the ground station is only the demo position.
- The 3D view follows the same rules as the map. It never converts between GPS heights and Cesium's. It stands every point on the ground height looked up at the launch pad, and says so when it can't.
- If the 3D view can't load, the map area says so, with a button back to the map. Everything else keeps running.
- If the satellite photos can't load, the map switches to the dark map and says so. If the dark map can't load either, or Leaflet can't load, the map switches to the NO MAP panel and everything else keeps running. The altitude timeline is plain SVG, so it needs no library.

## Where later features plug in

- The Manta ground station over Web Serial: see "The Manta hook". Its lines go to its `parse()`, and its samples go to the flight store with `store.addSample()`. The player isn't needed for live data. The stage reads the same kind of store, so it follows live data too. Board restarts in a file are only handled by `parseSerialLog()`, so a live source needs its own check for that, the way `bench-feed.js` has one. Panel 2 for a live flight source would use `data-panel.js` with no player, in a spot of its own.
- Web Bluetooth: a second link next to `serial-link.js` with the same callbacks (`onLine`, `onLink`, `onNote`, `onOpen`, `onClose`), so the same source detection and panels work on it.
- Ground station position: `parseJsonLine()` already accepts `{"type":"gs","lat":..,"lon":..,"alt":..,"fix":1}`, and the store uses it as soon as one arrives, live or in a replay. For a saved flight, `groundStation` in `index.json` does the same from the start.
- Ground speed on USB: see "Ground speed" under "Detection".
- A real-data ocean currents animation for the landing: see "The landing".
- New sensors: add channels to `js/schema.js`. The parser, the HUD's MORE column and panel 2's readings pick them up without other changes, including new GPS channels and new sensor groups.
