# Flight Console

The Flight Console is the page on my site for watching my rocket avionics. Plug a Dogtooth board into the computer over USB and it shows the board's readings live, with its GPS position in 3D. It also plays back saved flights from the telemetry my boards send. Later it will track live flights through my Manta ground station.

The Bench Console used to be its own page. It is now part of this one (see "The live console"), and its old address sends visitors here.

This guide explains every file, how the data moves through the page, and how to add a flight.

## Trying it on my computer

The page loads its data with `fetch`, which browsers block for files opened straight from disk. So it needs a small local web server:

1. Open a terminal in the website folder (the one with the site's `index.html`).
2. Run `python -m http.server 8000`.
3. Open http://localhost:8000/flight-console/ in a browser.

The satellite map works at exactly http://localhost:8000, because that address is on the Esri key's list. On 127.0.0.1 or any other port, Esri turns the key down and the page shows the dark map instead, with a note. The dark map needs my local CARTO key on this computer (see "Map keys" below). Without it, everything else works and the dark map draws tracks on a plain background.

The 3D view works at http://localhost:8000 and at http://127.0.0.1:8000, the two local addresses on the Cesium ion token's list. On any other port, ion turns the token down and the 3D view shows a flat, plain ground with a note.

The live console needs the Web Serial API, so it only connects in Chrome and Edge on a desktop or laptop. Web Serial also only works on a secure page, and localhost counts as one.

On the live site the same page is at https://www.dogtoothsystems.com/flight-console/.

## The three screens

`js/main.js` reads the address bar and shows one of three screens.

- `/flight-console/` with nothing after it is the landing: one full-screen hero, nothing else. It downloads no flight data.
- `/flight-console/?track` is the console, live. The CONNECT button opens the board's serial port, and the SAVED FLIGHTS dropdown in the same bar lists the saved flights. `?track#fc-saved` opens the console with that dropdown open and keyboard focus on its button. Nothing on the site links there now, but the address still works.
- `/flight-console/?flight=gps-board-sim-01` is the console, playing that saved flight. While it loads, the console stays up and its 3D panel says "Loading the flight...".
- If the flight id isn't in the library, or the library or the flight's data didn't load, it shows a short message with a BACK TO THE CONSOLE button (and TRY AGAIN when it looks like a connection problem). The message says whether it looks like a connection problem or a missing or damaged file on the site.
- Until `main.js` starts, the page says "Loading the Flight Console...". If the page's own code fails to download, a small script in `index.html` says so instead of leaving the page empty.

Links inside the page (TRACK A ROCKET on the landing, the lines in SAVED FLIGHTS, the close button on a replay's name, BACK TO THE CONSOLE) change the address with `history.pushState`, so no page reload happens. A middle click or Ctrl+click still opens a new tab, since every link has a real address. When the browser's back or forward button changes the address, the browser fires a `popstate` event and `main.js` runs the same check again. After every switch inside the page, keyboard focus moves to the new screen's main heading.

Page titles: "Flight Console | Dogtooth Systems" on the landing, and "Track a Rocket | Dogtooth Systems" on the live console and on every replay.

## The landing

The landing is one full-screen hero, and its text is all in `index.html`. Stacked in the middle, like the home page hero: the Dogtooth tuna, FLIGHT CONSOLE in orange stencil letters, and two buttons. TRACK A ROCKET opens the console in place (`./?track`, with `data-fc-nav="track"`). HOW IT WORKS goes to `../projects/flight-console.html`, which explains the whole system.

Every size in the stack comes from one CSS variable, `--fc-hero-w`, the title's width: about half the window on a desktop, the full width less the gutters on a phone, and smaller on short windows so the stack always fits under the nav. The hero is a CSS size container, so the width uses `cqw` units, which leave out a desktop scrollbar (with `vw` the title came out wider than the fish and buttons on narrow windows). Browsers without container units fall back to `vw`. The two buttons are each half of it, less half the gap, so together they line up with the ends of the title. On phones under 360 px wide they stack.

Behind the hero, made-up ocean currents move, in the style of earth.nullschool.net. `js/hero-currents.js` draws them on Canvas 2D:

- The flow is a stream function on a grid: three layers of smooth noise at different sizes, turned down in calm patches, plus two meandering jets and a few drifting eddies. The water moves along its lines, so it never piles up anywhere. A new grid is built every 0.3 s of motion, a few rows per frame, and the streaks read a blend of two.
- A soft speed color sits under the streaks. It is worked out at 1/8 of the screen's resolution, blurred, and scaled up. The colors are one array at the top of the file (`SPEED_RAMP`), dark navy for still water up through blues to near white in the fastest jets, with a warm ramp in a comment to swap in for comparison.
- Thousands of pale streaks ride the flow and leave fading trails. `SPEED`, `PARTICLE_COUNT` and `TRAIL_FADE` at the top of the file set how fast they move, how many there are on a 1920 by 1080 window, and how long the trails last.
- The fish is not a picture. The script fills the tuna's outline from `01_primary_full_logo_kicad_white_tuna.svg` into a solid mask (holes and the thin lines in the logo filled in, the open mouth kept), and bends the flow around it with a distance field, so no streak ever crosses it and the fastest water hugs its edge. A navy layer with a sharp edge sits on top. The mask goes where the empty `.fc-hero-fish` box is in the layout, so the CSS decides where the fish goes and how big it is.
- The nav is see-through and sits over the top of the water, so the water right behind it is drawn dimmer: the speed colors use only a share of the real speed there and the streaks are fainter, easing back to full strength a little below the nav. The flow itself doesn't change. The bottom edge of the hero fades the same way, so a bright jet doesn't stop in a hard line where the footer starts. The settings are `NAV_FADE_START` and the lines under it.

It runs at most about 60 frames a second, scales the number of streaks and the canvas resolution to the window, pauses while the tab is hidden or the hero is off screen (or the landing isn't showing), and draws one still frame for visitors who ask for reduced motion. The hero is plain navy until the first frame of water. The fish mask takes the most work, so it is built once, in short slices spread over several tasks, and the page keeps answering clicks and keys meanwhile.

Without JavaScript, the fish box shows the plain logo tuna instead. The same happens when the script can't get the tuna's outline within 1.5 s or at all: the water runs without the fish and the plain logo shows in the box. If the outline arrives later, the currents take the fish over.

`js/views/launcher.js` starts it once with `startCurrents(canvas, { fishSlot, onFish })`, which returns a `stop()` function. `onFish(true or false)` tells the page whether the currents are drawing the fish, and launcher.js sets or removes `data-currents` on the landing to match, which shows or hides the plain logo. Nothing else on the page uses `hero-currents.js`. So a real-data currents animation could replace it later, as long as it exports the same shape: a start function that takes the canvas and an options object and returns a stop function.

## The console: the bar, two panels and the modes

The console (`<section id="fc-console">` in `index.html`) fills the window under the site's nav, and the page never scrolls. The site footer hides while it is up (`main.js` sets `data-fc-screen` on the `<body>`, and the CSS reads it). Top to bottom:

- **The bar.** CONNECT on the left and SAVED FLIGHTS on the right, and while a replay is open, its name with a close button in between. There is no status strip: CONNECT shows the link on itself. It says CONNECTING while the port picker is open and the port opens, DISCONNECT while connected, and DISCONNECTING. Its small square fills orange while the board's status blocks arrive on time, and empties when one is 3 s late. A line only screen readers hear says the same in words ("Connected at 115,200 baud"). Pressed during a replay, CONNECT goes back to live first and opens the port picker right away.
- **Status lines**, under the bar, only while one has something to say: a note about the link ("No port was picked, so nothing changed.", "The board was unplugged..."), the Chrome or Edge warning, and NOT RECOGNIZED for data the console doesn't know (with a RAW OUTPUT button that opens the raw output in panel 2). The Chrome or Edge warning only shows after CONNECT is pressed in a browser without Web Serial. The link note and the warning have a close button.
- **Two panels**, side by side in one sliding track, like the pages of a monitor (`js/views/panels.js`). One is on screen at a time:
  - **Panel 1, the 3D view**, in every mode. It fills the panel with no frame around it. With nothing connected it waits looking at the whole Earth. Its camera buttons and KEY are in the bottom left corner, and Cesium's credits in the bottom right. In windows 860 pixels wide or less the credits sit on their own line just above the camera buttons instead (`map-view.js` keeps the buttons' height in `--fc-ctl-h`), so the two never overlap, even when the buttons wrap to two rows.
  - **Panel 2, graphs and readings.** Live, the board's readings (grouped Global Positioning System (GPS), GPS motion model and radio, with the errors from the board at the top), the raw serial output (closed at first) and the graphs of the last 10 minutes, with SAVE AS COMMA-SEPARATED VALUES (CSV) next to their heading. Each graph says NO DATA until the first block. In a replay, the mission timeline, the flight details (with COPY LINK) and the detection check instead, since the bench graphs don't apply to a saved flight.

  The arrow tabs at the left and right edges switch the panels. Only the one toward the other panel shows. The left and right arrow keys switch them too, except while keyboard focus is in something that uses those keys itself: the 3D view (its camera), a graph (it picks a time), the altitude timeline, the SAVED FLIGHTS dropdown, a form field, the raw output, or anything else that scrolls sideways. The panel off screen is inert, so the keyboard and screen readers skip it. The panels slide, except for viewers who ask for less motion. `data-panel` on the console (`globe` or `data`) says which panel is on screen.

The console's `data-mode` says what the panels hold:

- `idle`: no source found yet. The 3D view waits looking at the whole Earth, and panel 2's readings and graphs say NO DATA.
- `bench`: a Dogtooth board's status block came in over USB. The 3D view flies down to the board's position with the readings panel over it (height above ground, vertical speed, horizontal speed, the GPS fix and the last block's age, with the acronyms spelled out), and panel 2 fills in with the board's own readings and graphs. The readings panel is added on its own when the board is found, so the 3D view keeps running.
- `flight`: a flight source, like the Manta ground station. Nothing makes this mode yet. The 3D view has the readings panel over it. It goes by the source's `mode` in `main.js`, so a future source with `mode: 'flight'` just works.
- `replay`: a saved flight. The 3D view has the flight clock (with the rocket's name and the simulated or real label), the phase strip, the readings panel and the altitude timeline (with PLAY or PAUSE and the speeds) floating over it. The timeline is the console's one altitude display. Panel 2 has the mission timeline, the flight details and the detection check.

The overlays on the 3D view are marked `data-fc-cover`, so WHOLE FLIGHT frames the flight in the part of the view they leave free. The altitude timeline's height is kept in `--fc-tl-space` on the panel (`main.js` measures it), so the 3D view's controls and credits sit just above it.

On a wide screen everything fits the window at 1920 by 1080, 1440 by 900, 1366 by 768 and 1280 by 720, and long lists scroll inside their own box. In shorter windows (760 pixels tall or less, like a laptop's browser) the readings and the timeline get tighter, so the readings and their "More readings" toggle still fit above the credits. At 620 pixels tall or less the whole readings panel scrolls, and "More readings" opens in place under the main rows.

On phones each panel still fills the screen under the bar and panel 2 scrolls inside itself. The overlays on the 3D view get small: the clock, its caption and the simulated or real label share one line (the flight's name is already in the bar, so the rocket's name there is only for screen readers), the six phases fit one line without their start times (those are in the mission timeline), the readings are a compact grid, and the timeline puts PLAY, the speeds and the time in one row under a short strip, with its heading only for screen readers. On short phones (and phones turned sideways) panel 1 stacks instead: the clock and phase strip, then the 3D view at a fixed height, then the readings and the timeline, and it scrolls inside itself. Each part keeps its full height there and the panel scrolls. The page never scrolls sideways, at 390 or 320 pixels wide either.

## The live console

### How a line travels

1. `js/live/serial-link.js` opens the port with the Web Serial API at 115,200 baud, reads it, and hands every finished line to `main.js`. It knows nothing about what the lines say.
2. `js/live/sources.js` works out what is talking from the lines that arrive. The first line that matches a source decides it for the rest of that connection. A new connection starts over, since a different board may be plugged in. After 60 lines with text in them and no match, it calls the data unknown, and the console says so.
3. Every line also goes to `js/live/bench-panel.js`, the Bench Console's panels moved here. It finds the status blocks in the lines (`BlockParser` in `js/bench/parse.js`), keeps every block for the CSV, counts heartbeats and lost blocks, collects errors, and draws the readings, the graphs and the raw output.
4. Each finished block goes to `js/live/bench-feed.js`, which turns it into one normalized sample (`{ rocketId, t, type, gps, ... }`, see `js/schema.js`) for the live store. Its clock is the board's own TIME RUNNING, and it keeps moving between blocks, so the views can tell when the data gets old. A board restart (TIME RUNNING or the heartbeat number going back) clears the store and starts over.
5. The live store (`js/store.js`) is the same store the replays use. The live 3D view and map read it.

The live session (the link, the panel, the detector and the live stores) is made the first time the console opens and is kept for the whole visit. So a trip to a replay and back keeps the connection open and keeps every block for the CSV. The live map and 3D view are different: they are made only while the console shows live data, and destroyed when the page switches to a replay or the landing, since only one map can run at a time. Coming back to `?track` makes them again, and they draw everything the store already has.

Leaving the page for real (a link in the nav, or closing the tab) closes the port and drops every block. So while there are blocks that weren't saved as a CSV file, the browser asks before it leaves. After Save as CSV it only asks again once new blocks come in.

If a line makes the code that reads it throw, `serial-link.js` logs the error and goes on with the next line, so one bad line can't stop the reading.

### A board on a desk in the 3D view

The map and the 3D view were written for flights, so they talk about a rocket, a launch point and the whole flight. Before a source is found (idle) and in bench mode, `main.js` runs the 3D view on the bench store and passes `BENCH_WORDS` (from `js/views/hud-text.js`) in the views' `ctx.words`: the camera button says FOLLOW BOARD, the KEY says "Board track" and "Start point", there is no WHOLE FLIGHT button, and the readings panel says "No data from this board yet" before its first reading. Replays use `FLIGHT_WORDS`. Before any data comes in, the 3D view has no notes, since nothing is connected yet.

### The live store: no liftoff, no ground station

The live bench store is made with two differences from a replay's store:

- Liftoff detection is off (`LIFTOFF_AGL_M` and `LIFTOFF_VSPEED_MPS` set to `Infinity` in `BENCH_DETECTOR` in `js/live/bench-feed.js`, which `LIVE_STORE_OPTIONS` there uses, so the page and the tests make the store the same way). A board on a desk isn't flying, and one GPS altitude jump of 30 m or more would read as "Liftoff detected". The same two numbers decide when data "started in flight", which a board on a desk never did either. The pad is still found, and the 3D view needs it to place the board. The thresholds in `config.js` don't change.
- It has no ground station (`groundStation: null`). A replay's store starts with the demo ground station in `config.js`, at the simulator's placeholder pad in California. For a board on a desk that would put a ground station thousands of kilometers away. So the live store has none: `getGroundStation()` returns null, and the map, the 3D view and the readings panel leave out the dish, the line to it and every distance to it. The KEY drops those two rows. The map waits on a wide view of the world, and the 3D view waits looking down at the whole Earth, until there is a position to show. The console never makes a ground station out of the board's own position. A real ground station's own "gs" packets would still set one.

Replays work exactly as before, with the demo ground station.

### The Manta hook

The ground station isn't built yet, so nothing on the page reads it. There are two marked spots for it:

- `js/live/sources.js` has a commented-out entry for "Manta ground station" with what to fill in: a `test(line)` that is true only for the ground station's own lines, a `parse(line)` that gives back `{ kind: 'sample', sample }` (`parseSerialLine()` in `js/parser.js` is a good start), and `mode: 'flight'`.
- `main.js` has a "MANTA HOOK" comment over `feedFlightLine()`. It already passes each line of a flight source to its `parse()` (a line that makes it throw is skipped) and puts the samples in a flight store with the normal detector and no demo ground station. Before it is used, that store's clock also has to keep moving between packets (`store.setTime`), the way `bench-feed.js` does it for the board. The square on the CONNECT button also only follows the Dogtooth status blocks (`data-beat` in `bench-panel.js`), so Manta needs its own on-time check there.

When a source with `mode: 'flight'` is found, the console switches to flight mode: the 3D view on the flight store, with the readings panel over it.

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

The banner line is also how `sources.js` recognizes a Dogtooth board.

How the console reads it:

- **Banner.** A line starting with `====` begins a new block. The console reads `HEARTBEAT #` and `TIME RUNNING` from it. The time can be `5.3 s`, `1 min 5.3 s` or `1 h 2 min 5 s`, and the console turns it into seconds.
- **Sections.** A line with no colon is a section name. The readings in panel 2 group by section. The GPS group's heading spells out Global Positioning System (GPS), and lock quality's second line spells out horizontal dilution of precision (HDOP), since those are their first uses on the screen.
- **Fields.** Every other line is a label, a row of dashes and a value. The label is everything before the first colon. The console strips the dashes and spaces to get the value, but keeps a minus sign, so `---- -71.0896268` reads as -71.0896268. Fields are found by their label, never their position, so the board can reorder them or leave some out. Labels the console doesn't know are skipped, and they still show in the raw output.
- **Values.** `LOCKED` or `SEARCHING`. `100 % (HDOP 0.99)` gives the lock quality percent and the HDOP. `GOOD 723 char/s` gives a status word (`GOOD`, `LOW` or `SILENT`) and a rate. `ON` or `OFF` for each motion model. Everything else is a number with an optional unit. A value that isn't a number where one is expected (like `--`) shows as text and stays off the graphs.
- **End of a block.** A block is finished at the next banner, or at the blank line after the RADIO section. If the port closes partway through a block, the console keeps what it got.
- **Lost blocks.** If the heartbeat number skips ahead (64, then 66), the missing numbers count as lost blocks. The jump across a disconnect doesn't count, because nobody was listening. Neither does a board restart. The panel keeps the count, but the console doesn't show it anymore.
- **Heartbeat.** Each banner is a heartbeat. While connected, the square on DISCONNECT is filled orange, and it empties once 3 s pass with no new block. When the port closes (DISCONNECT, or the board is unplugged), the NOT RECOGNIZED line under the bar goes away, since nothing is coming in any more.
- **Restarts.** If `TIME RUNNING` or the heartbeat number goes back, the board restarted. The graphs start over, since their times would overlap, and so does the live store (the 3D track). The CSV keeps every block.
- **Errors.** A line starting with `Error:` can come at any time, even inside a block. It goes in the errors box at the top of the readings in panel 2. The same error again, with no other error in between, adds to its count instead of making a new row. It's also kept with the newest block for the CSV's `ERRORS` column.
- **Position.** A position only counts if latitude and longitude are both numbers on the globe, they aren't both 0, and the same block doesn't say SEARCHING. The board prints 0.0000000 while it searches, so no made-up position is ever drawn.

Lines outside a block, like the startup banner, go in the raw output only.

What the graphs show: NO DATA until the first block, then the last 10 minutes (or since the board started, if that's shorter). The time along the bottom is the board's `TIME RUNNING`, so data that arrives in a burst still lands at the right time. Lines break at each connect and disconnect and across gaps over 6 s. Altitude is left off while the block says SEARCHING. After a disconnect, the graphs stop moving so the data stays in view. Pointing at any graph (or tabbing to one and using the arrow keys) picks a time, and every graph shows that moment.

### Names the console knows

Every name the console matches is in one place at the top of `js/bench/parse.js`: `BANNER` for the banner, `ERROR_LABEL`, and `FIELDS` for the sections and labels. They're copied exactly from the board's output, capitals and brackets included, and a label must match exactly to count. If the firmware renames something, change it there. A new entry in `FIELDS` gets a row in the readings and a column in the CSV.

| Section | Label | Read as |
|---|---|---|
| GPS | TARGET LOCK [GPS] | LOCKED (plain) or SEARCHING (orange) |
| GPS | CONNECTED SATELLITES | number |
| GPS | LOCK QUALITY | percent and HDOP |
| GPS | LATITUDE | number |
| GPS | LONGITUDE | number |
| GPS | ALTITUDE | number and unit |
| GPS | GPS DATA RATE | GOOD (plain), LOW (orange outline) or SILENT (orange), then a rate |
| GPS | CORRUPTED DATA OCCURRENCES (GPS) | number |
| GPS MOTION MODEL | PORTABLE, AUTOMOTIVE, AIRBORNE 4G, OTHER | ON or OFF |
| RADIO | RADIO PACKETS SENT | number |
| RADIO | RADIO PACKETS SKIPPED | number |
| RADIO | RADIO PACKET ERROR OCCURRENCES | number |

GPS MOTION MODEL shows only the model that's ON, or all four if none is.

This block format dates from 2026-11-13. Before that, the flight firmware in `DOGTOOTH_V1_FIRMWARE` printed a one-line `Label: value | ...` status line, which the console no longer reads.

### The CSV file

SAVE AS COMMA-SEPARATED VALUES (CSV), next to the graphs' heading in panel 2, downloads every block received since the page loaded, across every connect and disconnect, and across trips to a replay and back. One row per block, in the order they arrived:

- `PC time (UTC)`: when the computer got the block's banner, as ISO 8601.
- `HEARTBEAT #` and `TIME RUNNING (s)`, from the banner.
- One column per field, in the order of `FIELDS`, holding the value as the board printed it. `LOCK QUALITY` splits into `LOCK QUALITY (%)` and `HDOP`. `GPS DATA RATE` splits into `GPS DATA RATE STATUS` and `GPS DATA RATE (char/s)`. The motion model columns start with `GPS MOTION MODEL`, so `AIRBORNE 4G` makes sense on its own. A header's unit is the first unit the board sent for it.
- `ERRORS`: every `Error:` message from the block's banner until the next banner, split by ` | ` when there's more than one. An error before the first banner of a connection belongs to no block, so it's only in the errors box.

Lines outside a block, like the startup banner, aren't in the CSV. Nothing is uploaded. Everything stays in the tab until it's closed or reloaded.

### The old Bench Console address

`/bench-console/` is now a tiny page that sends visitors to `/flight-console/?track`: a meta refresh, a `location.replace` script (so Back skips it), a canonical link, and a visible link for anyone with both turned off.

## Saved flights and replays

SAVED FLIGHTS, the small dropdown on the right of the console's bar (`js/views/saved-menu.js`), is a log with one line per flight in the library (`data/flights/index.json`): its name, its date and its flight time (`summary.flightDurationS`). A LIVE line at the top goes back to the live console, and the line for what is on screen now is marked. A plain click on a line opens it in place. A middle click or Ctrl+click opens a new tab, since every line is a real link. It works from the keyboard: Enter, Space or the down arrow opens it, the up and down arrows move between lines, Home and End go to the ends, and Escape closes it and puts focus back on its button. Tabbing out of it or clicking anywhere else closes it too.

While a replay is open, its name shows in the middle of the bar with a close button, the slim way back to live. Either way, back at `?track` a connected board is still connected and its data is still there.

### How one sample travels from the file to the screen

1. `library.js` downloads the flight's data file listed in `data/flights/index.json`.
2. `parser.js` turns each line into a normalized sample: `{ rocketId, t, type, gps, baro, imu, radio, power, status, extra }`. For my board's log it checks each packet's Fletcher checksum first and decodes the 34 bytes exactly like the firmware does. A simulator "phase" value goes into a separate truth list, never onto the sample.
3. `player.js` sorts every rocket's samples by time and feeds them to the store as its clock runs. At 5x speed it feeds five seconds of data per second of real time, and it never skips a sample.
4. `store.js` files the sample under its rocket and hands it to that rocket's own detector.
5. `detector.js` updates ground level, altitude above ground and vertical speed, and returns any new events, like "Apogee detected".
6. The store tells every view something changed. Each view reads what it needs from the store and redraws: the 3D view (or the map) moves the board marker and its trail, the readings update their numbers, the phase strip and the clock move on, the timeline's playhead moves, and the mission timeline adds the event.

The views never talk to each other. They only read the store, which is why the live console can feed the same store and the 3D view follows the board. The one exception is the 3D view. The map view starts it and shares its buttons, notes and "Follow rocket" setting with it.

When a flight opens, `main.js` also runs the whole flight once through a second, hidden store (the "pre-scan"). That gives the altitude timeline each rocket's whole altitude curve and the events to mark on it, and gives the 3D view its starting distance, before playback gets there. Nothing from the pre-scan reaches the shown store, so the readings, the map and the mission timeline only ever show what has happened up to the playhead. Live data has no pre-scan (an empty one is passed).

Opening a flight always builds a brand new store, player and set of views. Leaving it destroys them, so nothing from one flight can show up in the next.

## Tests

From the website folder, with Node 22 or newer:

```
node --test "flight-console/test/*.test.mjs"
```

- `test/bench-parse.test.mjs` feeds the example block and a set of edge cases through the block parser and the CSV builder: a SEARCHING block, LOW and SILENT rates, `Error:` lines inside and between blocks, times past a minute and past an hour, skipped heartbeat numbers, a reconnect, a restart, unknown labels and lines before the first banner.
- `test/bench-feed.test.mjs` checks the bench feed: blocks become samples with a good fix only when they should, the store's clock keeps moving, a restart starts over, and a board on a desk shows a pad and fires no flight events. The desk runs use the page's own live store options (`LIVE_STORE_OPTIONS.bench`), including a 35 m altitude jump and a steady 40 m climb that must not read as liftoff, and a store with no ground station keeps none until a "gs" packet sets one.
- `test/serial-link.test.mjs` checks the serial link with a fake port: lines split across USB chunks come out whole, and a listener that throws on one line doesn't stop the rest.
- `test/live-sources.test.mjs` checks the source detector: the banner means a Dogtooth board, other lines don't, a new connection starts over, unknown data is called unknown, and the Manta hook is there but switched off.

## Files

### Page

- `index.html`: the page itself. It holds the site's nav and footer (copied from the home page), the landing's text, the console (the bar, the status lines, the two panels and the arrow tabs, with the live panel's fixed text and the empty spots the views fill in), and the script tags for Leaflet and `js/main.js`. Its fonts come from the theme (see below), and Space Mono is used only for the raw serial output. It has no tag for CesiumJS on purpose (see "The 3D view").
- `flight-console.css`: styles for this page only. Everything is scoped under `.fc-page`, so none of it can affect other pages. The palette and the fonts live in `../css/flight-console-theme.css` (navy, orange used sparingly, off-white, and shades mixed from them). The tokens at the top of this file only give those colors jobs, including the `--bc-*` names the live panel and its graphs read. Then come the shared pieces (buttons in Saira Stencil One, labels and readouts in Share Tech Mono, headings in Barlow Condensed, sharp corners), the landing, the console (bar, status lines, panels and tabs), panel 1 and its overlays, the 3D view's frame, the 2D map, and panel 2, live and replay. Every animation only runs when the viewer hasn't asked for less motion.
- `README.md`: this guide.
- `.gitignore`: keeps `js/config.local.js` out of Git.

### Data

- `data/flights/index.json`: the flight library list (the "manifest"). A static site can't list its own folders, so this file is the only way the page knows which flights exist.
- `data/flights/gps-board-sim-01/pc_sim_flight.log`: my simulated flight. It is a byte-for-byte copy of the log my firmware's PC sim dump program wrote.
- `data/flights/gps-board-sim-01/cover-3d.webp`: that flight's cover picture, a screenshot of its 3D view with the panels hidden. The home page's Flight Console slide shows it. See "A flight's cover picture".
- `data/flights/.gitattributes`: tells Git to leave the log files' line endings alone, so the copies stay exact.

### Code that works without a page (Node can run it too)

- `js/config.js`: every number and setting I might want to change: detection thresholds, the demo ground station position, playback speeds, the map tile addresses, keys and credits, timeouts and colors. Each one has a short comment.
- `js/config.local.js`: my local CARTO map key, only on my laptop. Git ignores it (see "Map keys").
- `js/schema.js`: the channel registry. It lists every value a board can send, which sensor group it belongs to, its label and unit, and the names different files use for it. It also has `hasGoodPosition()`, the test every rocket position goes through before the page trusts it. Ground station packets use a lighter check (a fix plus latitude and longitude) because they may not carry an altitude.
- `js/parser.js`: the only code that understands flight file formats. It reads CSV files, JSON lines (including ground station position packets), and my firmware's serial output: `SIM PKT` hex lines from the simulator and `PKT` key=value lines from the bench_rx receiver. A bench_rx line missing any of its fields counts as a bad line, since those text lines have no checksum and a cut-off number would otherwise look real. If a board restarts mid-log, its clock starts over, so the parser shifts the later times to follow on and adds a note that the console shows under the data source.
- `js/library.js`: loads and checks `index.json`, skipping broken entries without breaking the rest, and loads one flight's files.
- `js/fleet.js`: who each rocket is: name, short name (`callsign`), color and board. My board's callsign is "DOGTOOTH GPS RADIO". Any other rocket's callsign is its name in capitals. (The map and the 3D view used to show the callsign on a label next to the rocket. They have no labels now.) A rocket ID nobody registered gets the next color and a plain name.
- `js/geo.js`: distance and bearing between two positions, compass names, and number, time and distance formatting.
- `js/detector.js`: works out ground level, altitude above ground, vertical speed and the flight events, one sample at a time. Vertical speed only exists once the readings cover a full `VSPEED_AVG_S` window, so one noisy reading at 20 Hz can't swing it. (A single reading more than `LIFTOFF_AGL_M` above the pad still counts as liftoff, as the rule says.) Before liftoff the console first waits to see the rocket sit still for `PAD_CONFIRM_S` before it trusts the readings as a pad. If the data instead starts with the rocket already moving one way for a while, or a "pad" keeps sinking below itself, the data began in flight. The console then says so, uses `GROUND_ELEV_FALLBACK_M` for ground level, and marks both as estimated. A short log that starts just before launch still keeps its pad readings.
- `js/store.js`: holds everything the console knows right now: rockets, samples, events, detectors, the ground station (or none, for live data) and which rocket is focused. Views subscribe to it.
- `js/player.js`: the playback clock for saved flights: play, pause, speed, seek and replay.
- `js/truth-check.js`: compares detected events with the simulator's true phases. Only the debug panel and the check tool use it. The detector never does.
- `js/bench/parse.js`: the Dogtooth status block format and every name the console matches (see "Names the console knows").
- `js/bench/csv.js`: builds the CSV file.
- `js/live/sources.js`: the source detector, and the Manta hook.
- `js/live/bench-feed.js`: turns the board's blocks into samples for the live store. It also holds the live stores' options (`BENCH_DETECTOR` and `LIVE_STORE_OPTIONS`).

### Code for the page

- `js/main.js`: picks the screen from the address, runs the routing, makes the live session (link, panel, detector, live stores) and the live map, loads saved flights, runs the pre-scan, and connects each replay's store, player and views. The "MANTA HOOK" is here.
- `js/hero-currents.js`: the moving ocean currents and the fish behind the landing's hero. One export, `startCurrents(canvas, options)`, which returns `stop()`.
- `js/live/serial-link.js`: the serial port, opened with Web Serial at 115,200 baud and read line by line.
- `js/live/bench-panel.js`: the CONNECT button (its words and its square), the Chrome or Edge warning, errors, readings, graphs, raw output and Save as CSV. It finds its parts by the `bc-*` ids in `index.html`.
- `js/bench/charts.js`: draws the live graphs on canvas, in the colors from the `--bc-*` variables (the browser works each one out, color-mix included) and the readout font. Before any data a graph says NO DATA.

### Views (they draw parts of the page)

- `js/views/dom.js`: small helpers for building page elements (HTML and SVG), limiting how often a view redraws, checking for reduced motion, and drawing an event's dot by how it was found.
- `js/views/icons.js`: the button icons, and `iconNode()`, which turns an icon's markup into an element.
- `js/views/markers.js`: the markers the map, the 3D view and the KEY share: the Dogtooth board (a plain rounded rectangle in the board's blue, #184590, with a thin off-white outline, always upright, since no board sends orientation), the start point (a small off-white dot with a thin dark ring) and the ground station (a small off-white satellite dish). None of them has a text label.
- `js/views/launcher.js`: starts the landing's ocean currents (`js/hero-currents.js`).
- `js/views/saved-menu.js`: the SAVED FLIGHTS dropdown: one line per flight (name, date, flight time), a LIVE line, the keyboard, and notes when the library didn't load or an entry had to be skipped. It only reads the manifest, never a flight's data files.
- `js/views/panels.js`: the two panels: the arrow tabs, the left and right arrow keys (and where they belong to something else), and keeping the panel off screen inert.
- `js/views/esri.js`: asks Esri once whether it accepts the satellite key. Every map in the visit shares the answer, so a visit only asks once.
- `js/views/mission-header.js`: the replay's clock in the top left corner of the 3D view: the big off-white T+ flight time (it stops at the landing time once the landing is detected), the focused rocket's name, and "Simulated flight" or "Real flight" with any honesty labels.
- `js/views/rocket-bar.js`: one chip per rocket, only for flights with 2 or more rockets. Click one to focus it.
- `js/views/phase-strip.js`: the six phases across the top (Pad, Ascent, Apogee, Drogue, Main, Landed), driven only by the detector. Drogue and Main have dashed bars because they are inferred.
- `js/views/map-view.js`: the 3D view's frame: it starts the 3D view, shows the loading and failure messages, and owns the camera buttons and the KEY in the bottom left corner. It is also the 2D map the 3D view falls back to (Leaflet, with SATELLITE, DARK MAP and 3D buttons, the "Labels" and "Follow rocket" checkboxes, and the same markers and fading trail as the 3D view, with no text labels), and the "No map" panel if Leaflet or the map tiles can't load. With no ground station it leaves out the dish, the line and the KEY's rows.
- `js/views/globe-view.js`: the 3D view. It makes the Cesium viewer and draws the fading trails, the board markers and their pulse rings, the start points, the ground station's dish and the event markers. It draws no text. It also looks up ground heights and moves the camera. See "The 3D view".
- `js/views/cesium-loader.js`: downloads CesiumJS when the 3D view opens.
- `js/views/hud-text.js`: `FLIGHT_WORDS` and `BENCH_WORDS`, what the views call the thing they track (see "A board on a desk in the 3D view"). It also keeps `rocketHudLine()`, the status line the map and the 3D view used to draw next to a rocket ("AGL 264 M", "NO GPS FIX, 4 S"). Neither view draws it now, but the bench feed tests still check the age rules through it.
- `js/views/stats-panel.js`: the readings panel floating over the 3D view in a replay, in bench mode and in flight mode (top right, or a compact grid on phones): altitude above ground level (AGL), vertical speed (VS), horizontal speed, Global Positioning System (GPS) and last packet, with everything else under "More readings", one section per sensor group the rocket actually sent. Since the map and the 3D view have no text labels, this is where those numbers are. Horizontal speed is the board's own GPS speed when it sends one (with its course). The Dogtooth status block has none, so then it is worked out from the last two good fixes: the distance between them over the time between them. That needs two fixes in a row, with no fix gap and no radio silence between them, and otherwise shows `--` with the reason. Its labels spell out each acronym the first time the screen shows it.
- `js/views/timeline.js`: the altitude timeline along the bottom of the 3D view, the console's one altitude display. It shows the focused rocket's whole altitude curve (orange up to the playhead), other rockets as thin lines, and event markers that jump to their event. Click, drag or use the arrow keys to move through the flight. PLAY or PAUSE and the speed buttons sit beside it.
- `js/views/event-log.js`: the mission timeline in panel 2: every event in time order on a line, each dot drawn by how the event was found, in dim off-white with the newest one in orange (a lost GPS fix is orange too). It shows a "Now" tag while the playhead is on that event. Screen readers only hear events that arrive during normal playback, never the whole list again after a seek.
- `js/views/flight-info.js`: the "About this flight" panel in panel 2: the flight's title, simulated or real, COPY LINK, description, date, launch site, boards, data files with reading and bad line counts, and any notes from the parser.
- `js/views/debug-panel.js`: the "Detection check" section for simulated flights, in panel 2.

### Tests and tools (run with Node from the website folder)

- `test/bench-parse.test.mjs`, `test/bench-feed.test.mjs`, `test/live-sources.test.mjs` and `test/serial-link.test.mjs`: see "Tests".
- `tools/add_flight.mjs`: adds a flight to the library.
- `tools/check_detection.mjs`: prints the detected events for a flight and compares them with the simulator's truth.

### Version numbers

When a file changes, bump its `?v=` number everywhere it's loaded, so returning visitors don't get the old copy. `flight-console.css` and `js/main.js` are loaded from `index.html`. The modules work the same way: GitHub Pages lets a browser keep a file for 10 minutes, and a new `main.js` mixed with an old cached `launcher.js` wouldn't even start. So `main.js` imports `store.js`, `views/event-log.js`, `views/debug-panel.js` and `live/bench-panel.js` with `?v=2`, `views/launcher.js`, `views/mission-header.js`, `views/hud-text.js`, `views/timeline.js` and `views/flight-info.js` with `?v=3`, and `views/map-view.js` and `views/stats-panel.js` with `?v=4`. `map-view.js` imports `globe-view.js` with `?v=4`, and `hud-text.js` with `?v=3` (so do `globe-view.js` and `stats-panel.js`). Every file that imports a module uses the same query, since two different addresses would load a module twice. The `js/bench/` files are imported with `?v=3` by the `js/live/` files and by each other, except `charts.js`, which `bench-panel.js` imports with `?v=4`. The other `js/live/` files import each other with no query, so `main.js` imports them with none too. Every view that uses `icons.js` imports it with `?v=2`. `views/markers.js` is new and has no query yet. `config.js` keeps its address (ten modules import it with no query, and a new query there would mean new numbers for nearly every file). That works as long as new code only uses settings an old cached `config.js` also has. So a new setting that other files need goes in the file that uses it, the way the trail and ring settings live in `markers.js`.

## The library file, index.json

Each flight in the `flights` list has these fields:

- `id`: a short name made of letters, numbers, `-` and `_`. It is the folder name under `data/flights/` and the value after `?flight=`.
- `title`: shown in SAVED FLIGHTS and on the replay's line in the console's bar.
- `date`: the flight date as `YYYY-MM-DD`. SAVED FLIGHTS shows it, newest first.
- `kind`: `"simulated"` or `"real"`. The page always shows which one it is.
- `featured`: `true` for one flight. The page no longer shows it differently (the old launcher's featured card is gone), but `add_flight.mjs` still keeps it on only one flight.
- `description`: one or two plain sentences.
- `site`: the launch site's name.
- `cover` (optional): a picture of the flight. The page itself doesn't show it anymore. The home page's Flight Console slide shows the simulated flight's. See "A flight's cover picture". It has:
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
  - The rest fed the old launcher's featured card. The page doesn't show them anymore, but `add_flight.mjs` still fills them in and they cost nothing to keep. They all describe one rocket, the one that flew highest:
    - `trackRocketId`: which rocket that is.
    - `track`: its path as `[latitude, longitude]` pairs, simplified to at most 60 points. Only good GPS positions are in it.
    - `trackGaps`: the places in `track` where the GPS had no fix, or nothing came in for longer than `LINK_STALE_S` (a radio silence). Each number is the index of the first point after a gap, so the line from the point before it is drawn dashed. If the GPS drops out so often that every gap won't fit in 60 points, the shortest stretches between gaps join the gap around them, so missing data is never drawn as a solid line.
    - `padPoint` and `landingPoint`: `[latitude, longitude]` of the launch pad (the last good position before liftoff) and the landing point (the first good position once the landing was detected). `null` if there was no pad or no detected landing.
    - `altProfile`: its altitude as `[seconds from liftoff, meters above ground]` pairs, simplified to at most 60 points, from 10 s before liftoff to 10 s after landing. A pair with `null` meters marks a gap with no altitude reading (no fix, or a radio silence longer than `LINK_STALE_S`), which a drawing of it shows as a break.
    - `driftM`: meters from the pad to the landing point.
    - `maxGsDistanceM`: the farthest the rocket got from the ground station, in meters.
    - `gsDemo`: `true` when those ground station distances use the demo ground station position from `config.js`, because the data had no ground station GPS packets.
  - Any summary value can be `null`. SAVED FLIGHTS leaves a missing flight time blank.

## Adding a flight

1. Put the log file somewhere on my computer. It stays where it is. The tool only reads it.
2. From the website folder, run (all on one line):

   `node flight-console/tools/add_flight.mjs --id my-flight-01 --title "My first real flight" --kind real --date 2026-10-18 --file "C:\path\to\flight.log" --rocket-name "GPS and radio board" --board "SAMD21, SAM-M8Q GPS and E22 LoRa radio" --site "Launch site name" --description "One or two plain sentences."`

   Add `--featured` to make it the featured flight (this clears the flag on the others). Add `--replace` to overwrite a flight that already has that id.
3. The tool checks everything first: the id and date, the file names, the rocket IDs, and that every rocket has readable data. If anything is wrong it stops and writes nothing. Then it copies the file into `data/flights/my-flight-01/`, runs it through the same parser, detector and store the page uses, fills in the summary (including a simplified track and altitude line, left from the old launcher's featured card), and updates `index.json`. It prints what it found.
   To redo the summary for a flight that's already in the library (after a change to the detector or the tool), run the same command again with `--replace`. The `--file` has to point at a copy outside `data/flights/`, since the tool won't copy a file onto itself. The copy is byte for byte, so the log in the library doesn't change.
4. Run `node flight-console/tools/check_detection.mjs my-flight-01` to see the detected events.
5. Refresh the console. The new flight is in SAVED FLIGHTS.

For a flight with several rockets in separate files, repeat `--file` once per rocket. The first `--rocket-name`, `--board` and `--rocket-id` go with the first `--file`, and so on. Every board sends node ID 1 until it gets its own number, so two boards' files need `--rocket-id` (for example `--rocket-id a --rocket-id b`). A single file that holds several rocket IDs, like a ground station log, becomes one rocket entry per ID automatically.

## A flight's cover picture

A flight can have a cover picture, a screenshot of its 3D view. The Flight Console page doesn't show covers anymore (the old launcher's featured card is gone), but the home page's Flight Console slide shows the simulated flight's cover, so its `cover` entry and its file stay.

A cover is added by hand. The tool doesn't make one.

1. Open the flight in the 3D view and take a screenshot with the panels out of the way. Mine is 5 wide by 6 tall (1400 by 1680 pixels), with the whole flight in the middle and plain ground and sky around it.
2. Save it in the flight's folder, for example `data/flights/my-flight-01/cover-3d.webp`.
3. Add `cover` to the flight's entry in `index.json`, with `file`, `alt` and `credit`.

A screenshot of the 3D view uses Cesium ion's imagery and terrain, so it needs their credits. Open "Data attribution" in the 3D view at the same camera position and copy what it lists into `credit`.

Running `add_flight.mjs` with `--replace` keeps the flight's cover. If the flight's data changed, take a new screenshot, because the old one shows the old flight.

The picture in the site's `index.html` points straight at `data/flights/gps-board-sim-01/cover-3d.webp`, so a new screenshot saved under the same name shows up there by itself. The alt text and the credit on that slide are typed in by hand, copied from the flight's entry in `index.json`. A new screenshot usually needs new alt text, because the alt text describes what the picture shows. If the cover's file name, alt text or credit changes, update the home page to match.

## Checking detection

`node flight-console/tools/check_detection.mjs gps-board-sim-01` prints the thresholds, every detected event, and, for simulated flights, how far each event is from the moment the simulator's phase really started. It flags anything more than 5 seconds off (change it with `--tolerance`), any event that fired twice, and any event that never fired.

## Settings worth knowing about

All of these are in `js/config.js`.

- Detection thresholds. For example, `LIFTOFF_AGL_M` is how high above the pad counts as liftoff, and `APOGEE_CONFIRM_S` is how long the rocket must be falling before apogee is confirmed. Every time setting is in seconds, so boards at 1 or 20 readings per second behave the same.
- `GROUND_STATION`: the demo ground station position for replays, 1 km southwest of the simulator's placeholder pad. Once the real ground station sends its own GPS position, the page uses that instead and says so. Live data never uses the demo position (see "The live store: no liftoff, no ground station").
- `LINK_STALE_S` and `ALTITUDE_STALE_S`: how long before a quiet rocket, or an old altitude, is shown as old instead of live.
- The `..._MAX_FPS` values: how often each part of the console redraws during playback.
- `TILE_API_KEY`: the public CARTO key for the dark map on the live site. See "Map keys" below.
- `ESRI_API_KEY`: the Esri key for the satellite map. It expires 9/30/2027. See "Map keys" below.
- `DEFAULT_MAP_LAYER`: the map background a first-time viewer sees (`'satellite'` or `'dark'`).
- `SATELLITE_MAX_NATIVE_ZOOM`: the deepest zoom with real Esri photos (19). Closer zooms scale those photos up.
- `HALO_COLOR`, `HALO_OPACITY` and `HALO_WIDTH_PX`: the thin dark outline under tracks and markers that keeps them visible on photos.
- `TRACK_COLOR`, `GROUND_STATION_COLOR` and `PAD_COLOR`: the focused rocket's orange trail and pulse rings, and the off-white of the start dot, the dish and the board marker's outline. `ROCKET_PALETTE` gives each rocket its own color (its trail while another rocket is focused), all mixed from the theme's navy, orange and off-white. These are hex copies of the theme's colors, since the map and the 3D view need plain colors and Node reads `config.js` too. The board marker's blue is in `js/views/markers.js`.
- `TIMELINE_KEY_STEP_S` and `TIMELINE_KEY_BIG_STEP_S`: how far the arrow keys (and Shift with an arrow, or Page Up and Page Down) move the playhead on the altitude timeline.
- `EVENT_NOW_S`: how long after an event the mission timeline's "Now" tag stays on it.
- `LINK_STALE_S` also decides where a radio silence breaks the altitude timeline's curve and the trail on the map and in 3D.
- `DEFAULT_VIEW`: the view a flight opens on (`'3d'` or `'map'`). See "The 3D view".
- `CESIUM_VERSION`: the CesiumJS release the 3D view loads. `CESIUM_ION_TOKEN` is the Cesium ion token (see "Map keys").
- `CESIUM_LOAD_TIMEOUT_MS` and `TERRAIN_SAMPLE_TIMEOUT_MS`: how long to wait for Cesium to download, and for the terrain and a ground height, before giving up. `GLOBE_READY_TIMEOUT_MS` is the longest the "Loading the three-dimensional (3D) view..." panel stays up once Cesium has downloaded.
- `PAD_RESAMPLE_M`: how far a launch pad has to move before its ground height is looked up again.
- `GLOBE_START_HEADING_DEG`, `GLOBE_START_PITCH_DEG`, `GLOBE_START_RANGE_PER_APOGEE`, `GLOBE_START_RANGE_MIN_M` and `GLOBE_START_RANGE_MAX_M`: the 3D camera's starting angle and distance.
- `GLOBE_ZOOM_MIN_M` and `GLOBE_ZOOM_MAX_M`: how close and how far the 3D camera can zoom. `GLOBE_FIT_MARGIN` is how much room WHOLE FLIGHT leaves.
- `GLOBE_ORBIT_DEG_PER_PX` and `GLOBE_ZOOM_PER_NOTCH`: how fast a drag turns the 3D camera and how much one wheel notch zooms. Lower both for a calmer view. `GLOBE_KEY_TURN_DEG` and `GLOBE_KEY_ZOOM` do the same for the keyboard.
- `GLOBE_PITCH_MIN_DEG`, `GLOBE_PITCH_MAX_DEG` and `GLOBE_GROUND_CLEARANCE_M`: how steep and how flat the 3D camera can look, and how far it stays above the ground. `GLOBE_MOVE_MS` is how long it takes to glide to a new view.
- `GLOBE_MAX_PIXEL_RATIO`: the sharpest the 3D view draws on high-resolution screens. Lower it to save battery.
- In `js/views/markers.js`, not `config.js` (it loads with no version number, so a new setting there could meet an old cached copy): `TRAIL_WINDOW_S`, `TRAIL_WIDTH_PX` and `TRAIL_OTHER_WIDTH_PX`, how many seconds of track the fading trail shows behind each board marker (30) and how wide it is for the focused rocket and the others, on the map and in 3D. `RING_PULSE_MS` and `RING_PULSE_FPS`, how long one pulse of the orange rings takes and the most frames a second the 3D view draws while they pulse. And `BOARD_BLUE`, the board marker's blue.
- The page's colors and fonts come from `../css/flight-console-theme.css`. The tokens at the top of `flight-console.css` give them jobs.

## Map keys

The 2D map, the fallback when the 3D view can't run, has two backgrounds, picked with its SATELLITE and DARK MAP buttons. Satellite is the default. The browser remembers each viewer's choice (in localStorage). If the browser blocks storage, the choice just isn't remembered.

### Satellite (Esri)

The photos come from Esri's World Imagery service, and the "Labels" layer (roads, road names, places and borders) comes from Esri's Static Basemap Tiles service. Both need the Esri key in `ESRI_API_KEY` in `js/config.js`.

- It is an ArcGIS Location Platform key with only the Basemaps privilege. In Esri's dashboard it is limited to dogtoothsystems.com, www.dogtoothsystems.com, chrispsparrow.github.io and http://localhost:8000, so it is safe to publish.
- It expires 9/30/2027. To renew it, make a new key (or extend this one) in the Esri Location Platform dashboard and paste it into `ESRI_API_KEY`.
- Before showing any photos, the page asks Esri once whether it accepts the key. If Esri says no (an expired key, for example), or the photos keep failing to load, the page switches to the dark map and says satellite imagery isn't available right now. The viewer's choice stays "Satellite", so the next visit tries again.
- Esri asks for "Powered by Esri" and each layer's data credit on the map. Those are in `js/config.js` (`ESRI_POWERED_BY`, `SATELLITE_ATTRIBUTION`, `SATELLITE_LABELS_ATTRIBUTION`). The page shows them only while the satellite map is on. The credit line shows one line and opens in full on hover, keyboard focus or a tap.

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

## The 3D view

The console's first panel is a 3D view of the board or the flight, drawn with CesiumJS on real terrain, in every mode. The 2D map is only its fallback: if the 3D view can't start, it says why and offers BACK TO THE MAP, and the map's 3D button tries again. The readings, the phase strip and both timelines don't change between the two, because they only read the store. Switching keeps the playback time, play or pause, the focused rocket and following.

### Look

The 3D view sits on the page with no frame, border or box. The space around the Earth is the page's navy (`scene.backgroundColor`), and there are no stars, skybox, sun or moon. The glow of the atmosphere around the Earth is darkened and tinted toward the navy (`SKY_*` at the top of `globe-view.js`). Below `SKY_GLOW_MIN_M` (100 km) above the ground the glow is off, so the sky over the ground is the page's own navy, and the haze over distant ground is darker and greyer (`GROUND_HAZE_*`).

Close to the ground, the ground itself fades into the navy toward the horizon, so it never ends in a hard line against the sky. It is a material on the globe only (`horizonFade` in `globe-view.js`), so the markers and the trails stay as they are, even with the rocket right at the horizon. Before every frame the fade's start and end distances are worked out from where they show on screen (`HORIZON_FADE_FROM` and `HORIZON_FADE_TO`, shares of the view's height below the horizon). They are capped at shares of the distance to the horizon (`HORIZON_FADE_FROM_MAX` and `HORIZON_FADE_TO_MAX`), because far mountains sit higher than sea level and show closer to the horizon. Cesium's own fog look is off close to the ground, since it would lighten the far ground again. (Its density stays, so it still skips drawing ground hidden in it.) A soft navy fade under the console's bar hides the line where the panel starts. There is no text in the 3D view. The markers are the board's blue with an off-white outline, an off-white start dot and an off-white dish, and orange is kept for the focused rocket's trail, its pulse rings and the event markers.

### Loading

- A flight opens on the 3D view. That is `DEFAULT_VIEW` in `js/config.js`. Set it to `'map'` and a flight opens on the map instead.
- CesiumJS is a big download (about 1.8 MB), so the landing never loads it. `js/views/cesium-loader.js` adds Cesium's script and stylesheet when the 3D view opens: when the console opens (live or a replay), or when someone clicks the map's 3D button.
- It comes from Cesium's own release CDN, pinned to version 1.146 (`CESIUM_VERSION` in `js/config.js`).
- Once a viewer goes to the map, later screens in the same visit open on it. The choice isn't kept between visits, so every visit starts on `DEFAULT_VIEW`. With `'map'` there, Cesium only downloads after a click on "3D".
- If Cesium can't load, the map area says "The 3D view needs internet to load. The map view still works." with a button back to the map. The rest of the console keeps running. A slow download isn't thrown away when the wait runs out, so a second click on "3D" picks up the same download.
- If the browser takes the 3D view's graphics away while it runs (a phone left in the background can do this), the map area says the 3D view stopped working. The next click on "3D" starts a new one.
- The map stays in place under the 3D view, paused, so switching back is instant. Leaving a flight destroys the Cesium viewer and lets go of its WebGL context, so opening many flights doesn't use more and more memory.

### What it draws

It draws the same things as the map and follows the same rules.

- The trail: a thin solid line (2 px for the focused rocket, in orange, and 1.5 px for the others, in their own colors) that fades out behind the board marker like a comet's tail. It shows the last `TRAIL_WINDOW_S` (30, in `markers.js`) seconds of good positions before the marker, from almost solid at the marker to nothing at the far end. It is a Cesium polyline with its own material (`trailMaterial` in `globe-view.js`), whose opacity follows the point's place along the line. Only good GPS positions are drawn. A gap (no fix, a radio silence, or a point with no height) is left as a break, never bridged. The pulse rings sit on top of the trail. Their collection uses Cesium's `OPAQUE_AND_TRANSLUCENT` blending, so their faint pixels blend with the trail instead of cutting holes in it (the comment above `ringBlend` in `globe-view.js` says why).
- The board marker: a plain rounded rectangle in the board's blue (#184590) with a thin off-white outline (`markers.js`). It is a billboard with no rotation and no scaling, so it always stands upright and keeps one size on screen at any zoom, and it is never hidden behind terrain. It never turns, since no board sends orientation. While the GPS fix is good, three orange rings pulse outward around it (see "Drawing only when needed"). With no GPS fix right now it turns hollow (a solid navy middle, so the start dot under a board on a desk doesn't show through, and a dim outline) at the last good position and the rings stop. It also turns hollow when its newest position has no height yet (a barometer that went quiet). It then stays at the last point that had one.
- The start point (the launch point in a replay): a small off-white dot with a thin dark ring, on the terrain.
- The ground station: a small off-white satellite dish, on the terrain. There is no line from it to the rocket, since in a chase view it looked like a line hanging down from the marker. The distance and bearing from the ground station are in the readings panel's More readings.
- A marker in the sky at the focused rocket's apogee, drogue, main and landing, and at any event its board reported. They are drawn like the altitude timeline's markers (a filled dot for reported, an orange ring for detected, a dashed ring for inferred). Liftoff has no marker, because the start point already marks that spot. A marker only appears once playback reaches its event. An event that falls in a GPS gap gets no marker, because there is no real position to put it at.

There are no text labels in the 3D view. The readings panel shows the height above ground, vertical speed, horizontal speed, the GPS fix and how old the data is, and the KEY names every marker and line. In 3D its last row, "Flight event, like apogee or landing", stands for the event markers. The live KEY leaves that row out, since a board on a desk has no flight events, and so does the 2D map, which draws no event markers.

The rocket moves from one data point to the next as packets arrive. Nothing is smoothed in between, so at one packet a second it moves once a second.

### Heights

Cesium places things by height above the ellipsoid, a smooth model of the Earth's shape. GPS reports height above mean sea level. The two differ by tens of meters, and the page never converts between them. Instead:

1. Once a rocket's launch pad is known, the page asks Cesium World Terrain for the ground height at that spot (`sampleTerrainMostDetailed`).
2. Every point of that rocket is drawn at that ground height plus the detector's height above ground for the point.

So the start point sits on the terrain, the trail starts on the ground, and a point drawn 1,000 m up is the same 1,000 m the readings panel shows. Each rocket uses its own pad. The ground station sits on the ground height looked up at its own position.

A rocket isn't drawn in 3D until its launch pad and the ground height there are known. A note says so while it waits. A rocket with a barometer is placed by its barometer's height above ground. A point with no barometer reading in the `ALTITUDE_STALE_S` before it is left out, which shows as a break in the trail, and so is any point from before the first barometer reading.

For the simulated flight, the pad's ground height came out to about 814 m above the ellipsoid. The simulator's "700 m above sea level" is a placeholder and isn't the real ground there.

Heights above ground are measured from the pad. If the rocket lands on higher or lower ground than the pad, the end of the trail can sit a little under or over the terrain there.

If the ground height can't be looked up, the page shows "3D ground height is approximate." and does one of these:

- If the lookup for a pad fails, or takes longer than `TERRAIN_SAMPLE_TIMEOUT_MS`, each point goes at its GPS altitude, used as it is. A pad that already had a ground height keeps it.
- If there is no pad position (the data starts in flight, or the GPS only got its first fix after liftoff), each point also goes at its GPS altitude.
- If Cesium World Terrain doesn't load, or takes longer than `TERRAIN_SAMPLE_TIMEOUT_MS`, the ground is drawn flat and heights above ground are measured from it. If the terrain arrives after that, the page switches to it and looks the ground heights up then.
- If the lookup at the ground station fails, it stands at its own altitude if it sent one, or at a launch pad's ground height. With neither, it isn't drawn.

### Distance to the ground station

The map's distance ("1.16 km, bearing 52° (NE)") is measured along the ground between the two map positions. It ignores height.

The 3D view's distance ("2.28 km straight line") is the straight line through the air from the ground station to the rocket, so it counts the rocket's height too. With the rocket 1,950 m up and about 1.2 km away on the map, the straight line is about 2.3 km. It is the distance the radio signal travels. It uses the heights as drawn: the ground station on its ground, and the rocket at its pad's ground height plus its height above ground.

### Camera

The camera always looks at one point and circles around it. The three buttons in the bottom left corner choose that point.

- FOLLOW ROCKET (on at the start, FOLLOW BOARD for a board on a desk): the camera looks at the focused rocket and steps with it. It is the same setting as the map's "Follow rocket" checkbox.
- WHOLE FLIGHT: frames the trails so far, the launch pads and the ground station, in the part of the view the readings panel leaves free. It keeps framing them as the trail grows, until you zoom or slide the view yourself.
- RESET VIEW: back to the starting angle and distance. While following, it centers on the rocket. Otherwise it aims above the launch pad, so the pad and the highest point both fit.

The starting view looks north from the side, tilted 12 degrees down. Its distance is three times the flight's highest point, taken from the pre-scan (the same number the altitude timeline uses for its scale). Live data has no pre-scan, so it starts at `GLOBE_START_RANGE_MIN_M`. Until there is a position to look at, the camera waits over the ground station. With no ground station (nothing connected yet, or a board on the bench), it waits far out, looking down at the whole Earth. When the first position comes in, it flies down to it in Cesium's own flight (`FLY_IN_S`), or jumps there for viewers who ask for less motion. Anything the viewer does with the camera on the way ends the flight at its goal.

### Moving the camera

Cesium's own mouse and touch controls are made for spinning a whole globe, and this close to the ground they turn far too fast. So they are switched off, and `globe-view.js` has its own.

- Drag with one finger or the left mouse button to circle around the point the camera looks at. A drag across 720 px goes half way round (`GLOBE_ORBIT_DEG_PER_PX`).
- Use the mouse wheel or pinch to zoom. One wheel notch is 20 percent (`GLOBE_ZOOM_PER_NOTCH`).
- Twist two fingers to turn the view.
- Drag with the right mouse button, or hold Shift and drag, to slide the view over the ground. That stops following the rocket, like dragging the map does. Two fingers dragging also slide the view, but only once FOLLOW ROCKET is off, so a pinch can't switch it off by accident.
- With keyboard focus on the 3D view, the arrow keys move the camera around the point, and + and - zoom.

Nothing keeps moving after you let go. The camera can't go under the ground or flip over the top. A drag on the 3D view never scrolls anything. (The console doesn't scroll at all, except on short phones, where panel 1 scrolls from anywhere outside the 3D view.)

FOLLOW ROCKET, WHOLE FLIGHT and RESET VIEW glide to their new view. When the viewer has asked for less motion, the camera jumps there.

### Drawing only when needed

The scene only redraws when something changes: new data, a camera move, or new terrain or imagery arriving (Cesium's `requestRenderMode`). While the map is showing instead, the 3D view's drawing loop is stopped.

The one exception is the orange pulse rings. While a board marker has a good GPS fix, its rings grow and fade outward like the map's, so the view asks for a new frame at most `RING_PULSE_FPS` (30) times a second. The loop rests while the 3D panel is off screen and stops when no ring shows (no fix, or the page has moved on). For viewers who ask for less motion the rings stay still and nothing redraws, so a paused flight that nobody touches draws nothing then.

## What the page promises

- It never shows a made-up position. With no GPS fix it says "No GPS fix" and shows how old the last good position is. A rocket that stops sending shows "No recent packets" the same way. On the map, in 3D and on the altitude timeline, a stretch with no position or no altitude (no fix, or nothing heard for longer than `LINK_STALE_S`) is left as a break, or dashed on the timeline, never drawn as measured.
- Old numbers never look live. When there is no new altitude, the last one dims and says how old it is, and vertical speed shows `--`. On the map and in 3D, the board marker turns hollow at its last good position and its rings stop, and the readings panel says "No GPS fix" with the age.
- It never shows orientation it doesn't have. The board marker always stands upright and never turns.
- It only shows values a board actually sent. Missing values show `--`, never 0, and a sensor section only appears if that rocket sent that sensor.
- Every event says how it was found: "reported" (the board said so), "detected" (measured from altitude) or "inferred" (worked out from the descent rate). The timeline markers and the mission timeline draw it the same way: a filled dot for reported, an orange ring for detected, and a dashed ring for inferred or estimated.
- It always says where the data came from and whether the flight is simulated or real.
- The 3D view follows the same rules as the map: only good positions, gaps left as breaks, no smoothing between packets, a marker that never turns, and events that say how they were found. It never converts between GPS heights and Cesium's. It stands every point on the ground height looked up at the launch pad, and says so when it can't.
- If the 3D view can't load, the map area says so, with a button back to the map. Everything else keeps running.
- If the satellite photos can't load, the map switches to the dark map and says so. If the dark map can't load either, or Leaflet can't load, the map switches to a plain text version and everything else keeps running. After a tile failure, the "No map" panel has both background buttons to try again. The altitude timeline is plain SVG, so it needs no library.

## Where later features plug in

- The Manta ground station over Web Serial: see "The Manta hook". Its lines go to its `parse()`, and its samples go to the flight store with `store.addSample()`. The player isn't needed for live data. The 3D view reads the same store, so it follows live data too. Board restarts in a file are only handled by `parseSerialLog()`, so a live source needs its own check for that, the way `bench-feed.js` has one.
- Web Bluetooth: a second link next to `serial-link.js` with the same callbacks (`onLine`, `onLink`, `onNote`, `onOpen`, `onClose`), so the same source detection and panels work on it.
- Ground station position: `parseJsonLine()` already accepts `{"type":"gs","lat":..,"lon":..,"alt":..,"fix":1}`, and the store uses it as soon as one arrives, live or in a replay.
- A real-data ocean currents animation for the landing: see "The landing".
- New sensors: add channels to `js/schema.js`. The parser and the readings panel pick them up without other changes, including new GPS channels (listed under the GPS rows the panel lays out itself) and new sensor groups, which show under "More readings".
