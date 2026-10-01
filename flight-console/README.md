# Flight Console

The Flight Console is the page on my site that plays back rocket flights from the telemetry my avionics boards send. It shows each rocket on a map, its altitude and speed, and the events of the flight. Later it will also track live flights through my ground station.

This guide explains every file, how the data moves through the page, and how to add a flight.

## Trying it on my computer

The page loads its data with `fetch`, which browsers block for files opened straight from disk. So it needs a small local web server:

1. Open a terminal in the website folder (the one with the site's `index.html`).
2. Run `python -m http.server 8000`.
3. Open http://localhost:8000/flight-console/ in a browser.

The satellite map works at exactly http://localhost:8000, because that address is on the Esri key's list. On 127.0.0.1 or any other port, Esri turns the key down and the page shows the dark map instead, with a note. The dark map needs my local CARTO key on this computer (see "Map keys" below). Without it, everything else works and the dark map draws tracks on a plain background.

On the live site the same page is at https://www.dogtoothsystems.com/flight-console/.

## How the page decides what to show

`js/main.js` reads the address bar.

- `/flight-console/` with nothing after it shows the launcher: the hero with the demo flight button, the featured flight, how it works, the flight library, and the live tracking card. The launcher only downloads `index.json`, never a flight's data files.
- `/flight-console/?flight=gps-board-sim-01` skips the launcher and opens the console for that flight.
- If the id isn't in the library, or the library or the flight's data didn't load, it shows a short message with a link back to all flights. The message says whether it looks like a connection problem or a missing or damaged file on the site.
- Until `main.js` starts, the page says "Loading the Flight Console...". If the page's own code fails to download, a small script in `index.html` says so instead of leaving the page empty.

"Watch" and "All flights" change the address with `history.pushState`, so no page reload happens. When the browser's back or forward button changes the address, the browser fires a `popstate` event and `main.js` runs the same check again. Opening a flight always builds a brand new store, player and set of views. Leaving it destroys them, so nothing from one flight can show up in the next.

## How one sample travels from the file to the screen

1. `library.js` downloads the flight's data file listed in `data/flights/index.json`.
2. `parser.js` turns each line into a normalized sample: `{ rocketId, t, type, gps, baro, imu, radio, power, status, extra }`. For my board's log it checks each packet's Fletcher checksum first and decodes the 34 bytes exactly like the firmware does. A simulator "phase" value goes into a separate truth list, never onto the sample.
3. `player.js` sorts every rocket's samples by time and feeds them to the store as its clock runs. At 5x speed it feeds five seconds of data per second of real time, and it never skips a sample.
4. `store.js` files the sample under its rocket and hands it to that rocket's own detector.
5. `detector.js` updates ground level, altitude above ground and vertical speed, and returns any new events, like "Apogee detected".
6. The store tells every view something changed. Each view reads what it needs from the store and redraws: the map moves the rocket and its label, the readings and the altitude tape update their numbers, the phase strip moves on, the timeline's playhead moves, and the mission timeline adds the event.

The views never talk to each other. They only read the store, so a live source can later feed the store directly and every view still works.

When a flight opens, `main.js` also runs the whole flight once through a second, hidden store (the "pre-scan"). That gives the altitude timeline each rocket's whole altitude curve and the events to mark on it, and gives the altitude tape its top value, before playback gets there. Nothing from the pre-scan reaches the live store, so the readings, the map and the mission timeline only ever show what has happened up to the playhead.

## Files

### Page

- `index.html`: the page itself. It holds the site's nav and footer (copied from the home page), the launcher's fixed text and drawings (the hero's contour lines and flight arc, and the How it works picture), empty spots the views fill in, and the script tags for Leaflet and `js/main.js`. It also loads the Share Tech Mono font, used only for the green labels on the map.
- `flight-console.css`: styles for this page only. Everything is scoped under `.fc-page`, so none of it can affect other pages. It starts with the page's color and font settings (the design tokens, as CSS variables) and the shared pieces like buttons, panels and the event dots, then has one part per screen area: launcher, console top, map, readings and tape, altitude timeline, and the panels under it. Every animation only runs when the viewer hasn't asked for less motion.
- `README.md`: this guide.
- `.gitignore`: keeps `js/config.local.js` out of Git.

### Data

- `data/flights/index.json`: the flight library list (the "manifest"). A static site can't list its own folders, so this file is the only way the page knows which flights exist.
- `data/flights/gps-board-sim-01/pc_sim_flight.log`: my simulated flight. It is a byte-for-byte copy of the log my firmware's PC sim dump program wrote.
- `data/flights/.gitattributes`: tells Git to leave the log files' line endings alone, so the copies stay exact.

### Code that works without a page (Node can run it too)

- `js/config.js`: every number and setting I might want to change: detection thresholds, the demo ground station position, playback speeds, the map tile addresses, keys and credits, timeouts and colors. Each one has a short comment.
- `js/config.local.js`: my local CARTO map key, only on my laptop. Git ignores it (see "Map keys").
- `js/schema.js`: the channel registry. It lists every value a board can send, which sensor group it belongs to, its label and unit, and the names different files use for it. It also has `hasGoodPosition()`, the test every rocket position goes through before the page trusts it. Ground station packets use a lighter check (a fix plus latitude and longitude) because they may not carry an altitude.
- `js/parser.js`: the only code that understands file formats. It reads CSV files, JSON lines (including ground station position packets), and my firmware's serial output: `SIM PKT` hex lines from the simulator and `PKT` key=value lines from the bench_rx receiver. A bench_rx line missing any of its fields counts as a bad line, since those text lines have no checksum and a cut-off number would otherwise look real. If a board restarts mid-log, its clock starts over, so the parser shifts the later times to follow on and adds a note that the console shows under the data source.
- `js/library.js`: loads and checks `index.json`, skipping broken entries without breaking the rest, and loads one flight's files.
- `js/fleet.js`: who each rocket is: name, map label name (`callsign`), color and board. My board's map label is "DOGTOOTH GPS RADIO". Any other rocket's label is its name in capitals. A rocket ID nobody registered gets the next color and a plain name.
- `js/geo.js`: distance and bearing between two positions, compass names, and number, time and distance formatting.
- `js/detector.js`: works out ground level, altitude above ground, vertical speed and the flight events, one sample at a time. Vertical speed only exists once the readings cover a full `VSPEED_AVG_S` window, so one noisy reading at 20 Hz can't swing it. (A single reading more than `LIFTOFF_AGL_M` above the pad still counts as liftoff, as the rule says.) Before liftoff the console waits to see the rocket sit still for `PAD_CONFIRM_S` before it trusts the readings as a pad. If the data instead starts with the rocket already moving one way for a while, or a "pad" keeps sinking below itself, the data began in flight. The console then says so, uses `GROUND_ELEV_FALLBACK_M` for ground level, and marks both as estimated. A short log that starts just before launch still keeps its pad readings.
- `js/store.js`: holds everything the console knows right now: rockets, samples, events, detectors, the ground station and which rocket is focused. Views subscribe to it.
- `js/player.js`: the playback clock for recorded flights: play, pause, speed, seek and replay.
- `js/truth-check.js`: compares detected events with the simulator's true phases. Only the debug panel and the check tool use it. The detector never does.

### Views (they draw parts of the page)

- `js/views/dom.js`: small helpers for building page elements (HTML and SVG), limiting how often a view redraws, checking for reduced motion, and drawing an event's dot by how it was found.
- `js/views/icons.js`: the drawings the page shares: the rocket (always pointing straight up, since no board sends orientation), the launch rail, the ground station tower, and the button icons.
- `js/views/launcher.js`: the launcher: the hero's buttons and the apogee label on its flight arc (from the featured flight's summary), the featured flight card, the flight library rows, and the notes when the library didn't load.
- `js/views/launcher-map.js`: the featured card's small map picture. It draws the track right away as a plain map drawing, then swaps in Esri satellite imagery only after the Esri key check passes and every tile has loaded. If the tiles or Leaflet fail, the drawing stays.
- `js/views/esri.js`: asks Esri once whether it accepts the satellite key. The console map and the launcher's map picture share the answer, so a visit only asks once.
- `js/views/mission-header.js`: the "All flights" link, "Simulated flight" or "Real flight", the focused rocket's name, the big T+ flight clock (it stops at the landing time once the landing is detected), and the "Copy link" button.
- `js/views/rocket-bar.js`: one chip per rocket, only for flights with 2 or more rockets. Click one to focus it.
- `js/views/phase-strip.js`: the six phases across the top (Pad, Ascent, Apogee, Drogue, Main, Landed), driven only by the detector. Drogue and Main have dashed bars because they are inferred.
- `js/views/map-view.js`: the Leaflet map, with the "Satellite" and "Dark map" buttons, the "Labels" and "Follow rocket" checkboxes, the legend, and the rocket, launch rail and ground station markers with their green labels. It shows the "No map" panel if Leaflet or the map tiles can't load.
- `js/views/stats-panel.js`: the readings panel floating over the map (under it on phones): altitude, vertical speed, ground speed, GPS and last packet, with everything else under "More readings", one section per sensor group the rocket actually sent.
- `js/views/alt-tape.js`: the altitude tape on the left edge of the map (a thin strip on phones), from 0 to the rocket's highest point in the pre-scan, with the altitude now and the highest point so far.
- `js/views/timeline.js`: the altitude timeline under the map. It shows the focused rocket's whole altitude curve (gold up to the playhead), other rockets as thin lines, and event markers that jump to their event. Click, drag or use the arrow keys to move through the flight. Play, pause and the speed buttons sit under it.
- `js/views/event-log.js`: the mission timeline: every event in time order on a line, each dot drawn by how the event was found, with the newest one in gold. It shows a "Now" tag while the playhead is on that event. Screen readers only hear events that arrive during normal playback, never the whole list again after a seek.
- `js/views/flight-info.js`: the "About this flight" panel: the flight's title, simulated or real, description, date, launch site, boards, data files with reading and bad line counts, and any notes from the parser.
- `js/views/debug-panel.js`: the "Detection check" section for simulated flights.
- `js/main.js`: picks launcher or console from the address, loads the data, runs the pre-scan, and connects the store, player and views.

### Tools (run with Node from the website folder)

- `tools/add_flight.mjs`: adds a flight to the library.
- `tools/check_detection.mjs`: prints the detected events for a flight and compares them with the simulator's truth.

## The library file, index.json

Each flight in the `flights` list has these fields:

- `id`: a short name made of letters, numbers, `-` and `_`. It is the folder name under `data/flights/` and the value after `?flight=`.
- `title`: shown on the launcher and in the console.
- `date`: the flight date as `YYYY-MM-DD`. The launcher shows newest first.
- `kind`: `"simulated"` or `"real"`. The page always shows which one it is.
- `featured`: `true` for the one flight shown large on the launcher. Only one flight should have it.
- `description`: one or two plain sentences.
- `site`: the launch site's name.
- `rockets`: one entry per rocket, each with:
  - `rocketId`: the rocket's ID. If only one rocket lists a file and the file holds one board ID, every sample in that file gets this ID. A file with several board IDs keeps them, so each rocket that lists it should use one of those IDs.
  - `name`: shown everywhere the rocket is named.
  - `board`: a short board description.
  - `file`: the data file's name inside the flight's folder. Several rockets can list the same file if it has a rocket ID column.
  - `timeOffsetS` (optional): seconds added to that file's times, to line up boards whose clocks started at different moments.
- `summary`: filled in by `add_flight.mjs` from the real data.
  - `rocketCount`: how many rockets.
  - `maxAglM`: the highest altitude above ground, in meters. The launcher's "Apogee" numbers and the label on the hero's flight arc come from it.
  - `flightDurationS`: seconds from liftoff to landing, or the whole data span if either wasn't detected.
  - `sensors`: the sensor groups found, like `["gps"]`.
  - `events`: the flight events detected.
  - The rest feed the launcher's featured card, so the launcher never has to download a flight's data files. They all describe one rocket, the one that flew highest:
    - `trackRocketId`: which rocket that is.
    - `track`: its path as `[latitude, longitude]` pairs, simplified to at most 60 points. Only good GPS positions are in it.
    - `trackGaps`: the places in `track` where the GPS had no fix, or nothing came in for longer than `LINK_STALE_S` (a radio silence). Each number is the index of the first point after a gap, so the line from the point before it is drawn dashed. If the GPS drops out so often that every gap won't fit in 60 points, the shortest stretches between gaps join the gap around them, so missing data is never drawn as a solid line.
    - `padPoint` and `landingPoint`: `[latitude, longitude]` of the launch pad (the last good position before liftoff) and the landing point (the first good position once the landing was detected). `null` if there was no pad or no detected landing.
    - `altProfile`: its altitude as `[seconds from liftoff, meters above ground]` pairs, simplified to at most 60 points, from 10 s before liftoff to 10 s after landing. A pair with `null` meters marks a gap with no altitude reading (no fix, or a radio silence longer than `LINK_STALE_S`), which the launcher draws as a break.
    - `driftM`: meters from the pad to the landing point.
    - `maxGsDistanceM`: the farthest the rocket got from the ground station, in meters.
    - `gsDemo`: `true` when those ground station distances use the demo ground station position from `config.js`, because the data had no ground station GPS packets. The launcher says so next to the number.
  - Any summary value can be `null`. The launcher shows `--` for it, or leaves out the map picture or altitude line.

## Adding a flight

1. Put the log file somewhere on my computer. It stays where it is. The tool only reads it.
2. From the website folder, run (all on one line):

   `node flight-console/tools/add_flight.mjs --id my-flight-01 --title "My first real flight" --kind real --date 2026-10-18 --file "C:\path\to\flight.log" --rocket-name "GPS and radio board" --board "SAMD21, SAM-M8Q GPS and E22 LoRa radio" --site "Launch site name" --description "One or two plain sentences."`

   Add `--featured` to make it the featured flight (this clears the flag on the others). Add `--replace` to overwrite a flight that already has that id.
3. The tool checks everything first: the id and date, the file names, the rocket IDs, and that every rocket has readable data. If anything is wrong it stops and writes nothing. Then it copies the file into `data/flights/my-flight-01/`, runs it through the same parser, detector and store the page uses, fills in the summary (including the simplified track and altitude line for the featured card), and updates `index.json`. It prints what it found.
   To redo the summary for a flight that's already in the library (after a change to the detector or the tool), run the same command again with `--replace`. The `--file` has to point at a copy outside `data/flights/`, since the tool won't copy a file onto itself. The copy is byte for byte, so the log in the library doesn't change.
4. Run `node flight-console/tools/check_detection.mjs my-flight-01` to see the detected events.
5. Refresh the launcher. The new flight is there.

For a flight with several rockets in separate files, repeat `--file` once per rocket. The first `--rocket-name`, `--board` and `--rocket-id` go with the first `--file`, and so on. Every board sends node ID 1 until it gets its own number, so two boards' files need `--rocket-id` (for example `--rocket-id a --rocket-id b`). A single file that holds several rocket IDs, like a ground station log, becomes one rocket entry per ID automatically.

## Checking detection

`node flight-console/tools/check_detection.mjs gps-board-sim-01` prints the thresholds, every detected event, and, for simulated flights, how far each event is from the moment the simulator's phase really started. It flags anything more than 5 seconds off (change it with `--tolerance`), any event that fired twice, and any event that never fired.

## Settings worth knowing about

All of these are in `js/config.js`.

- Detection thresholds. For example, `LIFTOFF_AGL_M` is how high above the pad counts as liftoff, and `APOGEE_CONFIRM_S` is how long the rocket must be falling before apogee is confirmed. Every time setting is in seconds, so boards at 1 or 20 readings per second behave the same.
- `GROUND_STATION`: the demo ground station position, 1 km southwest of the simulator's placeholder pad. Once the real ground station sends its own GPS position, the page uses that instead and says so.
- `LINK_STALE_S` and `ALTITUDE_STALE_S`: how long before a quiet rocket, or an old altitude, is shown as old instead of live.
- The `..._MAX_FPS` values: how often each part of the console redraws during playback.
- `TILE_API_KEY`: the public CARTO key for the dark map on the live site. See "Map keys" below.
- `ESRI_API_KEY`: the Esri key for the satellite map. It expires 9/30/2027. See "Map keys" below.
- `DEFAULT_MAP_LAYER`: the map background a first-time viewer sees (`'satellite'` or `'dark'`).
- `SATELLITE_MAX_NATIVE_ZOOM`: the deepest zoom with real Esri photos (19). Closer zooms scale those photos up.
- `HALO_COLOR`, `HALO_OPACITY` and `HALO_WIDTH_PX`: the thin dark outline under tracks and markers that keeps them visible on photos.
- `TRACK_COLOR`, `GROUND_STATION_COLOR` and `PAD_COLOR`: the focused rocket's gold track, the teal ground station and the off-white launch rail. `ROCKET_PALETTE` gives each rocket its own color (its dot, and its track while another rocket is focused). It leaves out gold, green, teal and red on purpose, because those already mean something on the page.
- `ROCKET_ICON_PX` and `ROCKET_ICON_FOCUSED_PX`: the rocket icon's height on the map, for other rockets and the focused one.
- `TIMELINE_KEY_STEP_S` and `TIMELINE_KEY_BIG_STEP_S`: how far the arrow keys (and Shift with an arrow, or Page Up and Page Down) move the playhead on the altitude timeline.
- `EVENT_NOW_S`: how long after an event the mission timeline's "Now" tag stays on it.
- `LINK_STALE_S` also decides where a radio silence breaks the altitude timeline's curve and makes the map's track dashed.
- The page's colors and fonts (the design tokens) are CSS variables at the top of `flight-console.css`.

## Map keys

The map has two backgrounds, picked with the "Satellite" and "Dark map" buttons on the map. Satellite is the default. The browser remembers each viewer's choice (in localStorage). If the browser blocks storage, the choice just isn't remembered.

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

## What the page promises

- It never shows a made-up position. With no GPS fix it says "No GPS fix" and shows how old the last good position is. A rocket that stops sending shows "No recent packets" the same way. The distance to the ground station then says "Last known". On the map and the altitude timeline, a stretch with no position or no altitude (no fix, or nothing heard for longer than `LINK_STALE_S`) is dashed or left as a break, never drawn as measured.
- Old numbers never look live. When there is no new altitude, the last one loses its gold color and says how old it is, and vertical speed shows `--`. On the map, the rocket turns grey and hollow at its last good position and its label says "NO GPS FIX" with the age.
- It never shows orientation it doesn't have. The rocket icon always points straight up.
- It only shows values a board actually sent. Missing values show `--`, never 0, and a sensor section only appears if that rocket sent that sensor.
- Every event says how it was found: "reported" (the board said so), "detected" (measured from altitude) or "inferred" (worked out from the descent rate). The timeline markers and the mission timeline draw it the same way: a filled dot for reported, a gold ring for detected, and a dashed ring for inferred or estimated.
- It always says where the data came from and whether the flight is simulated or real.
- If the satellite photos can't load, the map switches to the dark map and says so. If the dark map can't load either, or Leaflet can't load, the map switches to a plain text version and everything else keeps running. After a tile failure, the "No map" panel has both background buttons to try again. The altitude timeline is plain SVG, so it needs no library.

## Where later features plug in

- A 3D view: add it to `VIEW_MODES` in `js/views/map-view.js`. The view switcher sits in the map's top left controls and only appears once there is more than one view, so today there is no switcher and no 3D button.
- Live tracking over Web Serial or Web Bluetooth: read lines from the ground station and pass each one to `parseSerialLine()` or `parseJsonLine()` in `parser.js`. When a line gives back a sample, pass `result.sample` to `store.addSample()`. Skip lines where `parseSerialLine()` returns a kind other than `"sample"`, or where `parseJsonLine()` returns null. Board restarts are only handled by `parseSerialLog()`, which reads a whole file, so live code would need its own check for that. The player isn't needed for live data.
- Ground station position: `parseJsonLine()` already accepts `{"type":"gs","lat":..,"lon":..,"alt":..,"fix":1}`, and the store uses it as soon as one arrives.
- New sensors: add channels to `js/schema.js`. The parser and the readings panel pick them up without other changes, including new GPS channels (listed under the GPS rows the panel lays out itself) and new sensor groups, which show under "More readings".
