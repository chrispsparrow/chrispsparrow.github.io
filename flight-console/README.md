# Flight Console

The Flight Console is the page on my site that plays back rocket flights from the telemetry my avionics boards send. It shows each rocket on a map or in a 3D view, its altitude and speed, and the events of the flight. Later it will also track live flights through my ground station.

This guide explains every file, how the data moves through the page, and how to add a flight.

## Trying it on my computer

The page loads its data with `fetch`, which browsers block for files opened straight from disk. So it needs a small local web server:

1. Open a terminal in the website folder (the one with the site's `index.html`).
2. Run `python -m http.server 8000`.
3. Open http://localhost:8000/flight-console/ in a browser.

The satellite map works at exactly http://localhost:8000, because that address is on the Esri key's list. On 127.0.0.1 or any other port, Esri turns the key down and the page shows the dark map instead, with a note. The dark map needs my local CARTO key on this computer (see "Map keys" below). Without it, everything else works and the dark map draws tracks on a plain background.

The 3D view works at http://localhost:8000 and at http://127.0.0.1:8000, the two local addresses on the Cesium ion token's list. On any other port, ion turns the token down and the 3D view shows a flat, plain ground with a note.

On the live site the same page is at https://www.dogtoothsystems.com/flight-console/.

## How the page decides what to show

`js/main.js` reads the address bar.

- `/flight-console/` with nothing after it shows the launcher: the hero with the demo flight button, the featured flight, how it works, the flight library, and the live tracking card. The launcher only downloads `index.json` and the featured flight's cover picture, never a flight's data files.
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
6. The store tells every view something changed. Each view reads what it needs from the store and redraws: the map (or the 3D view) moves the rocket and its label, the readings and the altitude tape update their numbers, the phase strip moves on, the timeline's playhead moves, and the mission timeline adds the event.

The views never talk to each other. They only read the store, so a live source can later feed the store directly and every view still works. The one exception is the 3D view. The map view starts it and shares its buttons, notes and "Follow rocket" setting with it.

When a flight opens, `main.js` also runs the whole flight once through a second, hidden store (the "pre-scan"). That gives the altitude timeline each rocket's whole altitude curve and the events to mark on it, and gives the altitude tape its top value, before playback gets there. Nothing from the pre-scan reaches the live store, so the readings, the map and the mission timeline only ever show what has happened up to the playhead.

## Files

### Page

- `index.html`: the page itself. It holds the site's nav and footer (copied from the home page), the launcher's fixed text and drawings (the hero's contour lines and flight arc, and the How it works picture), empty spots the views fill in, and the script tags for Leaflet and `js/main.js`. It also loads the Share Tech Mono font, used only for the green labels on the map and in the 3D view. It has no tag for CesiumJS on purpose (see "The 3D view").
- `flight-console.css`: styles for this page only. Everything is scoped under `.fc-page`, so none of it can affect other pages. It starts with the page's color and font settings (the design tokens, as CSS variables) and the shared pieces like buttons, panels and the event dots, then has one part per screen area: launcher, console top, map, readings and tape, altitude timeline, and the panels under it. Every animation only runs when the viewer hasn't asked for less motion.
- `README.md`: this guide.
- `.gitignore`: keeps `js/config.local.js` out of Git.

### Data

- `data/flights/index.json`: the flight library list (the "manifest"). A static site can't list its own folders, so this file is the only way the page knows which flights exist.
- `data/flights/gps-board-sim-01/pc_sim_flight.log`: my simulated flight. It is a byte-for-byte copy of the log my firmware's PC sim dump program wrote.
- `data/flights/gps-board-sim-01/cover-3d.webp`: that flight's cover picture for the launcher, a screenshot of its 3D view with the panels hidden. See "A flight's cover picture".
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
- `js/views/launcher-map.js`: the featured card's picture. A flight with a `cover` in `index.json` shows that picture with its credit line. Any other flight, or a cover that didn't load, gets a small map picture. It draws the track right away as a plain map drawing, then swaps in Esri satellite imagery only after the Esri key check passes and every tile has loaded. If the tiles or Leaflet fail, the drawing stays.
- `js/views/esri.js`: asks Esri once whether it accepts the satellite key. The console map and the launcher's map picture share the answer, so a visit only asks once.
- `js/views/mission-header.js`: the "All flights" link, "Simulated flight" or "Real flight", the focused rocket's name, the big T+ flight clock (it stops at the landing time once the landing is detected), and the "Copy link" button.
- `js/views/rocket-bar.js`: one chip per rocket, only for flights with 2 or more rockets. Click one to focus it.
- `js/views/phase-strip.js`: the six phases across the top (Pad, Ascent, Apogee, Drogue, Main, Landed), driven only by the detector. Drogue and Main have dashed bars because they are inferred.
- `js/views/map-view.js`: the Leaflet map, with the "Satellite", "Dark map" and "3D" buttons, the "Labels" and "Follow rocket" checkboxes, the legend, and the rocket, launch rail and ground station markers with their green labels. It shows the "No map" panel if Leaflet or the map tiles can't load. It also owns the switch to the 3D view: the "3D" button, which view a flight opens on, the loading and failure messages, and the three camera buttons.
- `js/views/globe-view.js`: the 3D view. It makes the Cesium viewer and draws the trails, the drop line, the rocket, launch rail and ground station icons, their labels, the line to the ground station and the event markers. It also looks up ground heights, moves the camera and keeps labels from overlapping. See "The 3D view".
- `js/views/cesium-loader.js`: downloads CesiumJS when the 3D view opens.
- `js/views/hud-text.js`: the words on a rocket's green label ("AGL 264 M", "NO GPS FIX · 4 S"), shared by the map and the 3D view so both always say the same thing.
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
- `cover` (optional): a picture for the featured card, shown in place of its map picture. See "A flight's cover picture". It has:
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

## A flight's cover picture

The featured card normally draws a small map of the flight's track. A flight can have a cover picture instead. The simulated flight's cover is a screenshot of its 3D view, taken partway down under the drogue.

A cover is added by hand. The tool doesn't make one.

1. Open the flight in the 3D view and take a screenshot with the panels out of the way. It has to be 5 wide by 6 tall (mine is 1400 by 1680 pixels) with the whole flight, labels included, inside the middle 62 percent of its width and 60 percent of its height. Leave plain ground and sky around that.
2. Save it in the flight's folder, for example `data/flights/my-flight-01/cover-3d.webp`.
3. Add `cover` to the flight's entry in `index.json`, with `file`, `alt` and `credit`.

The shape matters because the card's picture area changes with the window. It is almost square on a laptop, tall and narrow in a small window, and wide on a phone. The page sizes the cover so its middle always fits, and the ground around it fills the rest. The numbers are in the `.fc-pic-cover` rules in `flight-console.css`. A cover with another shape needs those numbers changed.

A screenshot of the 3D view uses Cesium ion's imagery and terrain, so it needs their credits. Open "Data attribution" in the 3D view at the same camera position and copy what it lists into `credit`. The credit shows as one line on the picture and opens in full on hover or a tap.

If the cover file doesn't load, the card shows the map picture. Running `add_flight.mjs` with `--replace` keeps the flight's cover. If the flight's data changed, take a new screenshot, because the old one shows the old flight.

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
- `DEFAULT_VIEW`: the view a flight opens on (`'3d'` or `'map'`). See "The 3D view".
- `CESIUM_VERSION`: the CesiumJS release the 3D view loads. `CESIUM_ION_TOKEN` is the Cesium ion token (see "Map keys").
- `CESIUM_LOAD_TIMEOUT_MS` and `TERRAIN_SAMPLE_TIMEOUT_MS`: how long to wait for Cesium to download, and for the terrain and a ground height, before giving up. `GLOBE_READY_TIMEOUT_MS` is the longest the "Loading the 3D view..." panel stays up once Cesium has downloaded.
- `PAD_RESAMPLE_M`: how far a launch pad has to move before its ground height is looked up again.
- `GLOBE_START_HEADING_DEG`, `GLOBE_START_PITCH_DEG`, `GLOBE_START_RANGE_PER_APOGEE`, `GLOBE_START_RANGE_MIN_M` and `GLOBE_START_RANGE_MAX_M`: the 3D camera's starting angle and distance.
- `GLOBE_ZOOM_MIN_M` and `GLOBE_ZOOM_MAX_M`: how close and how far the 3D camera can zoom. `GLOBE_FIT_MARGIN` is how much room "Whole flight" leaves.
- `GLOBE_ORBIT_DEG_PER_PX` and `GLOBE_ZOOM_PER_NOTCH`: how fast a drag turns the 3D camera and how much one wheel notch zooms. Lower both for a calmer view. `GLOBE_KEY_TURN_DEG` and `GLOBE_KEY_ZOOM` do the same for the keyboard.
- `GLOBE_PITCH_MIN_DEG`, `GLOBE_PITCH_MAX_DEG` and `GLOBE_GROUND_CLEARANCE_M`: how steep and how flat the 3D camera can look, and how far it stays above the ground. `GLOBE_MOVE_MS` is how long it takes to glide to a new view.
- `GLOBE_MAX_PIXEL_RATIO`: the sharpest the 3D view draws on high-resolution screens. Lower it to save battery.
- `GLOBE_ICON_NEAR_M`, `GLOBE_ICON_FAR_M` and `GLOBE_ICON_FAR_SCALE`: how much the 3D view's icons and labels shrink when the camera is far away.
- `DROP_LINE_COLOR` and `DROP_LINE_WIDTH_PX`: the line from the focused rocket down to the ground in 3D.
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

### 3D view (Cesium ion)

The 3D view's terrain (Cesium World Terrain) and its aerial imagery (ion's default imagery) come from Cesium ion, which needs the token in `CESIUM_ION_TOKEN` in `js/config.js`.

- In ion's dashboard the token is limited to dogtoothsystems.com, www.dogtoothsystems.com, chrispsparrow.github.io, http://localhost:8000 and http://127.0.0.1:8000. It only has the `assets:read` scope, so it can read terrain and imagery and can't change anything in my account. That makes it safe to publish. It never expires.
- If ion turns the token down, the 3D view still opens. The ground is flat and plain, and notes say the ground height is approximate and the imagery didn't load.
- Cesium's logo and data credits show in the bottom right corner of the 3D view. They are required, so they always show.

## The 3D view

The "3D" button next to "Satellite" and "Dark map" swaps the map for a 3D view of the same flight, drawn with CesiumJS on real terrain. The readings, the altitude tape, the phase strip and both timelines don't change, because they only read the store. Switching between the map and 3D keeps the playback time, play or pause, the focused rocket and "Follow rocket".

### Loading

- A flight opens on the 3D view. That is `DEFAULT_VIEW` in `js/config.js`. Set it to `'map'` and a flight opens on the map instead.
- CesiumJS is a big download (about 1.8 MB), so the launcher never loads it. `js/views/cesium-loader.js` adds Cesium's script and stylesheet when the 3D view opens: when a flight opens on it, or when someone clicks "3D".
- It comes from Cesium's own release CDN, pinned to version 1.146 (`CESIUM_VERSION` in `js/config.js`).
- Once a viewer picks the map or the 3D view, later flights in the same visit open on that one. The choice isn't kept between visits, so every visit starts on `DEFAULT_VIEW`. With `'map'` there, Cesium only downloads after a click on "3D".
- If Cesium can't load, the map area says "The 3D view needs internet to load. The map view still works." with a button back to the map. The rest of the console keeps running. A slow download isn't thrown away when the wait runs out, so a second click on "3D" picks up the same download.
- If the browser takes the 3D view's graphics away while it runs (a phone left in the background can do this), the map area says the 3D view stopped working. The next click on "3D" starts a new one.
- The map stays in place under the 3D view, paused, so switching back is instant. Leaving a flight destroys the Cesium viewer and lets go of its WebGL context, so opening many flights doesn't use more and more memory.

### What it draws

It draws the same things as the map and follows the same rules.

- The focused rocket's trail in gold with a dark outline, and the other rockets' trails thinner in their own colors. Only good GPS positions are drawn. Across a gap the trail is dashed.
- A thin line from the focused rocket straight down to the ground, so its height is easy to judge.
- The same rocket icon as the map. It always points straight up, since no board sends orientation. With no GPS fix it turns grey and hollow at the last good position, and the label says why and for how long. It also turns grey and hollow when its newest position has no height yet (a barometer that went quiet). It then stays at the last point that had one, and the distance says "Last known".
- The launch rail and the ground station on the terrain, with the same green labels.
- A dashed teal line from the ground station to the focused rocket, with the straight-line distance.
- A marker in the sky at the focused rocket's apogee, drogue, main and landing, and at any event its board reported. They are drawn like the altitude timeline's markers (a filled dot for reported, a gold ring for detected, a dashed ring for inferred), with a label like "Apogee detected · 3,000 m". A board's own event shows the board's words and no height, since the board reported none. Liftoff has no marker, because the launch rail already marks that spot. A marker only appears once playback reaches its event. An event that falls in a GPS gap gets no marker, because there is no real position to put it at.

The rocket moves from one data point to the next as packets arrive. Nothing is smoothed in between, so at one packet a second it moves once a second.

Cesium draws a label in one color and can't draw the frame and side bar the map's tags have. So the 3D labels are the same words in the same font on a dark backing. A label that would cover another one moves to another side of its icon. If no side is clear it hides until there is room. The focused rocket's label and the ground station's always show.

### Heights

Cesium places things by height above the ellipsoid, a smooth model of the Earth's shape. GPS reports height above mean sea level. The two differ by tens of meters, and the page never converts between them. Instead:

1. Once a rocket's launch pad is known, the page asks Cesium World Terrain for the ground height at that spot (`sampleTerrainMostDetailed`).
2. Every point of that rocket is drawn at that ground height plus the detector's height above ground for the point.

So the launch rail sits on the terrain, the trail starts on the ground, and a point drawn 1,000 m up is the same 1,000 m the readings panel shows. Each rocket uses its own pad. The ground station sits on the ground height looked up at its own position.

A rocket isn't drawn in 3D until its launch pad and the ground height there are known. A note says so while it waits. A rocket with a barometer is placed by its barometer's height above ground. A point with no barometer reading in the `ALTITUDE_STALE_S` before it is left out, which shows as a dashed gap, and so is any point from before the first barometer reading.

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

The camera always looks at one point and circles around it. The three buttons choose that point.

- "Follow rocket" (on at the start): the camera looks at the focused rocket and steps with it. It is the same setting as the map's "Follow rocket" checkbox.
- "Whole flight": frames the trails so far, the launch pads and the ground station, in the part of the view the readings panel and the altitude tape leave free. It keeps framing them as the trail grows, until you zoom or slide the view yourself.
- "Reset view": back to the starting angle and distance. While following, it centers on the rocket. Otherwise it aims above the launch pad, so the pad and the highest point both fit.

The starting view looks north from the side, tilted 12 degrees down. Its distance is three times the flight's highest point, taken from the pre-scan (the same number the altitude tape uses for its scale). A live flight has no pre-scan, so it will start at `GLOBE_START_RANGE_MIN_M`.

### Moving the camera

Cesium's own mouse and touch controls are made for spinning a whole globe, and this close to the ground they turn far too fast. So they are switched off, and `globe-view.js` has its own.

- Drag with one finger or the left mouse button to circle around the point the camera looks at. A drag across 720 px goes half way round (`GLOBE_ORBIT_DEG_PER_PX`).
- Use the mouse wheel or pinch to zoom. One wheel notch is 20 percent (`GLOBE_ZOOM_PER_NOTCH`).
- Twist two fingers to turn the view.
- Drag with the right mouse button, or hold Shift and drag, to slide the view over the ground. That stops following the rocket, like dragging the map does. Two fingers dragging also slide the view, but only once "Follow rocket" is off, so a pinch can't switch it off by accident.
- With keyboard focus on the 3D view, the arrow keys move the camera around the point, and + and - zoom.

Nothing keeps moving after you let go. The camera can't go under the ground or flip over the top. A drag on the 3D view never scrolls the page. The page scrolls from anywhere outside it.

"Follow rocket", "Whole flight" and "Reset view" glide to their new view. When the viewer has asked for less motion, the camera jumps there.

### Drawing only when needed

The scene only redraws when something changes: new data, a camera move, or new terrain or imagery arriving (Cesium's `requestRenderMode`). A paused flight that nobody touches draws nothing, which saves battery. While the map is showing instead, the 3D view's drawing loop is stopped.

## What the page promises

- It never shows a made-up position. With no GPS fix it says "No GPS fix" and shows how old the last good position is. A rocket that stops sending shows "No recent packets" the same way. The distance to the ground station then says "Last known". On the map and the altitude timeline, a stretch with no position or no altitude (no fix, or nothing heard for longer than `LINK_STALE_S`) is dashed or left as a break, never drawn as measured.
- Old numbers never look live. When there is no new altitude, the last one loses its gold color and says how old it is, and vertical speed shows `--`. On the map, the rocket turns grey and hollow at its last good position and its label says "NO GPS FIX" with the age.
- It never shows orientation it doesn't have. The rocket icon always points straight up.
- It only shows values a board actually sent. Missing values show `--`, never 0, and a sensor section only appears if that rocket sent that sensor.
- Every event says how it was found: "reported" (the board said so), "detected" (measured from altitude) or "inferred" (worked out from the descent rate). The timeline markers and the mission timeline draw it the same way: a filled dot for reported, a gold ring for detected, and a dashed ring for inferred or estimated.
- It always says where the data came from and whether the flight is simulated or real.
- The 3D view follows the same rules as the map: only good positions, dashed gaps, no smoothing between packets, a rocket that never turns, and events that say how they were found. It never converts between GPS heights and Cesium's. It stands every point on the ground height looked up at the launch pad, and says so when it can't.
- If the 3D view can't load, the map area says so, with a button back to the map. Everything else keeps running.
- If the satellite photos can't load, the map switches to the dark map and says so. If the dark map can't load either, or Leaflet can't load, the map switches to a plain text version and everything else keeps running. After a tile failure, the "No map" panel has both background buttons to try again. The altitude timeline is plain SVG, so it needs no library.

## Where later features plug in

- Live tracking over Web Serial or Web Bluetooth: read lines from the ground station and pass each one to `parseSerialLine()` or `parseJsonLine()` in `parser.js`. When a line gives back a sample, pass `result.sample` to `store.addSample()`. Skip lines where `parseSerialLine()` returns a kind other than `"sample"`, or where `parseJsonLine()` returns null. Board restarts are only handled by `parseSerialLog()`, which reads a whole file, so live code would need its own check for that. The player isn't needed for live data. The 3D view reads the same store, so it follows live data too.
- Ground station position: `parseJsonLine()` already accepts `{"type":"gs","lat":..,"lon":..,"alt":..,"fix":1}`, and the store uses it as soon as one arrives.
- New sensors: add channels to `js/schema.js`. The parser and the readings panel pick them up without other changes, including new GPS channels (listed under the GPS rows the panel lays out itself) and new sensor groups, which show under "More readings".
