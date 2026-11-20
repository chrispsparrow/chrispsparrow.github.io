# Launch mode

Launch mode is the Flight Console set up for a launch field with no
reliable internet. It loads and runs with Wi-Fi off, keeps three copies of
every line the receiver prints, and puts the rocket's last GPS fix on screen
for recovery. I built it for the CRMRC launch on November 21, 2026.

The launch-day steps are in [CHECKLIST.md](CHECKLIST.md).

## Starting it

Double-click `launch-mode.bat` in the website folder (a desktop shortcut to
it works too). It starts the local server in its own window and opens
<http://localhost:8000/flight-console/launch.html?track> in Chrome.

- The server is `launch-mode/server.mjs`, a small Node server with no
  packages. Web Serial works on `http://localhost` without HTTPS. It has to
  be port 8000, because the Esri key for the online imagery only works there.
- Chrome gets its own profile in `%LOCALAPPDATA%\DogtoothLaunchMode`, so the
  serial port permission and the crash-recovery copy always live in the same
  place. It also starts with `--no-proxy-server`. Without that, Chrome's
  automatic proxy look-up held every page, even localhost, for 30 seconds on
  a connection that was up but dead.
- Keep the server window open. While it is closed the page can't reload or
  write the server copy of the log.

## The launch page

Launch mode is its own page, `flight-console/launch.html`, not a flag on the
normal page. It is made from `index.html` by
`node launch-mode/build-launch-page.mjs`, which swaps the internet copies of
the fonts and Leaflet for the ones in `flight-console/vendor/`, adds
`flight-console-launch.css`, and sets `window.FC_LAUNCH = true` before
anything else runs. Run it again after any change to `index.html`
(`--check` says whether the launch page is up to date).

The shared code reads `LAUNCH` from `flight-console/js/launch/launch-mode.js`.
On the normal page it is false, and the console works as it always has.
That file also holds the hub (`window.fcLaunch` on the launch page): the
field settings, the ground station, whether the internet answers, the
serial line taps and each part's test hooks.

## The one setting

`launch-mode/field.json` holds the field's center, the size of the saved map
box and the zoom levels to save. Both maps, the ground station's default and
the tile downloader read it. To use another field, change the center, then
run the downloader again.

## The saved map

`python launch-mode/download_tiles.py --count` prints the plan.
`python launch-mode/download_tiles.py` downloads it, throttled to 5 requests
a second, and can be stopped and started again.

- Zoom 0 to 16 for the whole box (15 km each way) come from USGS's
  USGSImageryOnly tile cache, which stops at zoom 16.
- Zoom 17 (inner 5 km) and 18 (inner 2 km) come from USGS's NAIP image
  service on The National Map, asked for in 8 by 8 tile blocks and cut up
  here.
- Both are public domain. Nothing is saved from Esri, OpenStreetMap, CARTO,
  Bing or Cesium ion, since their terms don't allow it.
- The tiles go in `offline-maps/crmrc/` (10,432 tiles, 193 MB), which git
  ignores, with a `manifest.json` that lists what is on disk.

Both maps put the saved tiles on top. Outside the box they show Esri's
imagery when the internet answers, and plain ground when it doesn't. Nothing
waits on the internet. The 3D view uses flat ground and never contacts
Cesium ion. The dark map (CARTO) can't be saved, so the launch page hides it.

## The receiver

The receiver board can run either of two firmware builds, and the page reads
both.

- The older one prints a `PKT node=1 ...` line for each packet and a
  `# DEKEL_RX` status line every second. The saved test capture is in this
  format.
- The newer one (built November 17, and the one on the board on November 19)
  prints a short start-up report, then one status block starting
  `==== HEARTBEAT #n` for each packet from the rocket, and
  `Error: No packets received for N s` every 5 seconds while it waits. The
  page reads those blocks the same way it reads a Dogtooth board on the USB
  cable. While it waits, the line under the bar says the receiver was found
  and is listening, and that no packets have come in yet. If its radio
  didn't start, that line says so and what to do.

On the launch page both builds get the ground station and the field's
ground height. A flight board that restarts in flight keeps its track on
the map with either one. No test played a real recording of the newer
build with the flight board sending, so step 4 of the checklist's 5-minute
test is the one check of that path from end to end.

## Flight data

Every line from the serial port goes to three places as it arrives:

- **The disk file** I pick when I first press CONNECT (File System Access
  API), written in short open, append and close cycles about once a second,
  so a crash loses at most the last second there. CHOOSE FILE picks one
  later if the save box was cancelled.
- **The server copy**, `flight-logs/flight-<date and time>-page.log`, sent in
  batches and saved to disk before the server answers.
- **The browser copy** in IndexedDB, within a quarter of a second. After a
  crash or a closed tab, the page offers RECOVER, which saves the recording
  in SAVED FLIGHTS and puts the flight back on the live view (also after
  CONNECT, as long as no packet has come in yet).

If the cable comes out, the page reconnects by itself when the same USB
device comes back (RECEIVER LOST, then RECEIVER BACK under the bar), and the
log carries on in the same files. After that the BROWSER row counts only the
lines since the reconnect. The ones before it went to SAVED FLIGHTS, so
nothing is missing. DISCONNECT stops it. The lines under the bar also say
when a connected port sends nothing (NO DATA after 8 seconds, RECEIVER
SILENT after 12),
when the server window was closed (SERVER STOPPED), and when another launch
tab already has the receiver (OTHER TAB). Only one launch tab can hold the
port. A save box name already used in the same minute gets `-2`.

Each line in a log file is the time it arrived on this laptop, then ` > `,
then the receiver's line exactly as it came. Lines the logger adds start with
`# `. LOAD FILE (in SAVED FLIGHTS) plays any of these files back.

## The backup logger

`backup-logger.bat` runs `launch-mode/backup_logger.py`, which reads the
receiver's COM port at 115200 baud with no browser and writes the same log
format to `flight-logs/backup-<date and time>.log`. Only one program can use
the port at a time, so it is the fallback when the page fails. With no
`--port` it picks the only USB serial port, or asks.

## Recovery

The launch panel on the right keeps LAST GOOD FIX pinned at the top:
latitude and longitude to 6 decimals, whether the fix is current or old and
why, the range and bearing from the ground station, the time since the last
packet, the GPS altitude and the height above ground, and COPY COORDINATES.

- The readout comes from the trail (`rocket.crumbs`), so a packet the trail
  marks as an outlier, or one at 0, 0, never takes it. A newer weak fix (few
  satellites or a high HDOP) shows under it as NEWER WEAK FIX, with COPY
  WEAK FIX. With weak fixes only, the weak one is the readout, marked weak.
- A fix farther from the last trusted one than the rocket could have gone
  in the time between (50 m/s, at least 300 m and at most 10 km) shows
  under the readout as NEWER FIX, NOT CONFIRMED, with COPY NEWER FIX. It
  takes the readout once three fixes in a row agree. The same holds for the
  first packet after a reload, so one bad packet can't replace the saved
  fix. The map, the trail and the HUD use the shared trail rule and may
  still jump to that packet, so the panel is the one to read.
- With two boards the readout follows the rocket in focus. The other
  rocket's newest fix shows under ALSO SAVED (kept in localStorage as
  `fc-launch-other-fixes`).
- The fix is kept in localStorage, so it survives a reload. Chrome only
  writes localStorage to disk every few seconds, so after a crash the panel
  also reads the newest fix from the unfinished recording in IndexedDB.
- A test capture's fix never replaces a real saved one, and a second launch
  tab follows the first tab's fixes.
- `field.json`'s `groundElevM` (44 m, from USGS) is the ground level for a
  flight first heard in the air, so its height above ground is right.

The site nav is hidden while the console is up on the launch page. Below a
1000 px wide window the panel goes under the map, with the coordinates and
COPY COORDINATES first.

The ground station is the position typed into GROUND STATION, or the field
center until then. Every range and bearing on the page uses it, and the maps
call it GROUND STATION. OPEN IN MAPS only shows while the internet answers.

## Testing without the rocket

`launch.html?track&capture=1&speed=20&shift=field` plays
`flight-console/test/radio-board-rx-capture.log` through the same code path
as real serial lines, moved to the field (TEST CAPTURE on the panel does the
same). Its logs are named `test-capture-...` and the page says it is a test.

The tests are listed in [test/README.md](test/README.md). The main ones:

- `node --test "flight-console/test/*.test.mjs"`, the unit tests.
- `node launch-mode/test/acceptance.mjs`, the whole launch-mode check in
  headless Chrome with every host except localhost blocked.
- `python launch-mode/test/backup_logger_test.py`, the backup logger against
  a fake receiver.
