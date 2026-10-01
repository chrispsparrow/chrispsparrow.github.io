// config.js
// Every adjustable number and setting for the Flight Console lives here, so
// tuning never means hunting through the code.
// Used by: detector.js, store.js, player.js, fleet.js, library.js, the views,
// main.js, and both Node tools in tools/.
// No DOM (page elements) in this file, so Node can import it too.

// ------------------------------------------------------------------
// Event detection (detector.js). All times are in SECONDS, never in
// readings, because boards send data at different rates.
// ------------------------------------------------------------------

// Seconds of pad readings averaged to find ground level, frozen at liftoff.
export const PAD_AVG_S = 20;

// Before liftoff the console first checks whether the rocket is sitting on a
// pad. It counts as still while its vertical speed is under this (m/s)...
export const PAD_STILL_MAX_MPS = 2.5;
// ...and the pad is confirmed once it stays still for this long (s).
export const PAD_CONFIRM_S = 3;
// Readings at the very start that stay within this much (m) of the first
// one, for at least PAD_RUN_MIN_S (s), count as pad readings, even if
// liftoff comes before PAD_CONFIRM_S. (Shorter than that, a fast-climbing
// rocket could look still between two readings at 20 Hz.)
export const PAD_SPREAD_M = 8;
export const PAD_RUN_MIN_S = 1;
// The data counts as starting in flight only if the rocket keeps moving
// one way (faster than PAD_STILL_MAX_MPS) for DESCENT_CONFIRM_S and its
// altitude changes by more than LIFTOFF_AGL_M, or if it is still falling
// and already LIFTOFF_AGL_M below its highest reading. A rocket on a
// confirmed pad that sinks more than LIFTOFF_AGL_M below it and keeps
// falling for DESCENT_CONFIRM_S was never on a pad (for example, data that
// starts under a main parachute). A short GPS glitch doesn't keep falling.

// Ground height (m above mean sea level) assumed when a rocket has no pad
// readings, for example when the data starts in flight. 700 m is the
// simulator's placeholder launch site. Change it for a real site.
export const GROUND_ELEV_FALLBACK_M = 700;

// Vertical speed is averaged over this many seconds before it is shown or used.
export const VSPEED_AVG_S = 3;

// Liftoff: higher than this above the ground (m)...
export const LIFTOFF_AGL_M = 30;
// ...or climbing faster than this (m/s).
export const LIFTOFF_VSPEED_MPS = 15;
// (Liftoff time and a lost GPS fix: if the fix dropped on the pad and no
// altitude reading arrived between the drop and the liftoff detection, as
// with a GPS-only board losing its fix in boost, the drop is taken as the
// estimated liftoff time. If altitude readings did arrive, they time the
// liftoff themselves.)

// Apogee can only be detected after the rocket has climbed this high (m AGL).
export const APOGEE_ARM_AGL_M = 100;
// Vertical speed must stay below 0 for this long (s) to confirm apogee.
export const APOGEE_CONFIRM_S = 3;

// Drogue (inferred): falling faster than this (m/s)...
export const DROGUE_MIN_DESCENT_MPS = 15;
// Main (inferred): falling slower than this (m/s)...
export const MAIN_MAX_DESCENT_MPS = 12;
// ...but still falling faster than this (m/s). Slower than this counts as
// sitting on the ground, which must not look like a main parachute.
export const MAIN_MIN_DESCENT_MPS = 1;
// ...and the slowdown must start higher than this above the ground (m), so
// slowing to land (or being carried downhill) is never called a main.
export const MAIN_MIN_AGL_M = 30;
// How long (s) a descent rate must hold to infer drogue or main.
export const DESCENT_CONFIRM_S = 3;

// Landed: over this many seconds (s)...
export const LANDED_WINDOW_S = 5;
// ...the altitude changes by less than this (m)...
export const LANDED_ALT_RANGE_M = 8;
// ...and, for rockets with GPS, horizontal speed stays under this (m/s).
export const LANDED_MAX_SPEED_MPS = 2;

// Collected in one object, the shape createDetector() expects.
export const DETECTOR_DEFAULTS = Object.freeze({
  PAD_AVG_S,
  PAD_STILL_MAX_MPS,
  PAD_CONFIRM_S,
  PAD_SPREAD_M,
  PAD_RUN_MIN_S,
  GROUND_ELEV_FALLBACK_M,
  VSPEED_AVG_S,
  LIFTOFF_AGL_M,
  LIFTOFF_VSPEED_MPS,
  APOGEE_ARM_AGL_M,
  APOGEE_CONFIRM_S,
  DROGUE_MIN_DESCENT_MPS,
  MAIN_MAX_DESCENT_MPS,
  MAIN_MIN_DESCENT_MPS,
  MAIN_MIN_AGL_M,
  DESCENT_CONFIRM_S,
  LANDED_WINDOW_S,
  LANDED_ALT_RANGE_M,
  LANDED_MAX_SPEED_MPS,
});

// ------------------------------------------------------------------
// Ground station
// ------------------------------------------------------------------

// Demo ground station position: 1 km southwest (bearing 225 degrees) of the
// simulator's placeholder pad at 35.1234567, -117.1234567. Replaced by "gs"
// packets once the real ground station sends its own GPS position.
export const GROUND_STATION = Object.freeze({
  lat: 35.1170973,
  lon: -117.1312309,
  altMsl: 700,
});

// ------------------------------------------------------------------
// Playback (player.js and controls.js)
// ------------------------------------------------------------------

// Speed buttons shown under the map, as multiples of real time.
export const PLAYBACK_SPEEDS = Object.freeze([1, 5, 20]);
// Speed a flight starts playing at when it is opened.
export const DEFAULT_SPEED = 5;
// Longest real-time step (s) the clock takes in one frame. After the tab was
// hidden, playback carries on from where it was instead of jumping ahead.
// (On a very slow device, under 4 frames a second, playback runs a little
// slower than the chosen speed.) Samples are never skipped either way.
export const MAX_FRAME_STEP_S = 0.25;

// ------------------------------------------------------------------
// When shown values count as old
// ------------------------------------------------------------------

// A rocket with no packet for this long (s) is shown as out of contact:
// no "GPS fix", a hollow map marker with the age of its last good fix.
export const LINK_STALE_S = 5;
// Altitude and vertical speed older than this (s) are marked as old in the
// stats panel instead of looking live.
export const ALTITUDE_STALE_S = 1.5;
// Vertical speeds smaller than this (m/s) show with no up or down arrow.
export const LEVEL_VSPEED_MPS = 0.05;
// Below this horizontal speed (m/s) a GPS course points nowhere in
// particular, so it gets no compass name.
export const COURSE_MIN_SPEED_MPS = 0.5;

// ------------------------------------------------------------------
// How often each part of the console redraws while a flight plays
// (times per second). Lower numbers save battery on phones.
// ------------------------------------------------------------------

// Mission header (clock, phase, flags).
export const HEADER_MAX_FPS = 10;
// Rocket chips.
export const ROCKET_BAR_MAX_FPS = 8;
// Stats panel.
export const STATS_MAX_FPS = 10;
// Map markers, tracks and the no-map panel.
export const MAP_MAX_FPS = 12;
// Event log.
export const LOG_MAX_FPS = 8;
// Debug panel (only while it is open).
export const DEBUG_MAX_FPS = 4;
// Play button, scrub bar position and time.
export const CONTROLS_MAX_FPS = 20;
// Seeks while the scrub bar is being dragged.
export const SCRUB_SEEKS_PER_S = 30;

// ------------------------------------------------------------------
// Small view settings
// ------------------------------------------------------------------

// How long (ms) "Link copied" stays next to the copy button.
export const LINK_COPIED_MS = 2500;
// The event log follows new entries only if you are within this many
// pixels of the bottom (so reading older entries isn't interrupted).
export const LOG_AUTOSCROLL_PX = 48;

// ------------------------------------------------------------------
// Map (map-view.js)
// ------------------------------------------------------------------

// CARTO basemaps key for the live site. CARTO asks for a key on every tile
// request (without one every tile is an "API key required" picture). This
// is the PUBLIC key: CARTO only accepts it from pages on dogtoothsystems.com,
// www.dogtoothsystems.com and chrispsparrow.github.io (it checks the
// Referer), so it is safe to publish. It does not work on localhost.
export const TILE_API_KEY = 'cb1_45ls_1_0832753cfacefc93cbc56bf5';
// On localhost or 127.0.0.1 the page instead loads js/config.local.js (not
// committed, see .gitignore) and uses its TILE_API_KEY_LOCAL. If that file
// or key is missing, the map draws on a plain background and says why.
// CARTO "Dark Matter" raster tiles. {key} is filled in from the key in use
// and {r} becomes "@2x" on high-resolution screens.
export const TILE_URL = 'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key={key}';
// Required credit for the map data and the tiles.
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';
// Deepest zoom level CARTO serves, and the map's deepest zoom.
export const TILE_MAX_ZOOM = 20;

// Esri key for the satellite layer (ArcGIS Location Platform API key, with
// only the Basemaps privilege). Esri only accepts it from pages on
// dogtoothsystems.com, www.dogtoothsystems.com, chrispsparrow.github.io and
// http://localhost:8000, so it is safe to publish. It does not work on
// 127.0.0.1 or other ports.
// It expires 9/30/2027. Renew it from the Esri Location Platform dashboard
// and paste the new key here. If the key is rejected (expired, for example),
// the map shows the dark map and says satellite imagery isn't available.
export const ESRI_API_KEY = 'AAPTa2ur8bkfWxnXJzQ0kE6tVFA..K7Cdcxmt2hOIPTg9jtq0S_app4Zim_RkWEv37WmqCo-ktduo__CT6Ovtut5VPqQymnxSMRBoDhiX3k6bNlWKXesPV3pqBd-sZhkDThC7upNMpLWJXqfVsIkVfkAaWW-CbepDr7QwbWv3NYC1mc9T_JpLN6zRqF79VZ9HPs9AMKKVlBP9dYjL1tSG0hEs_roNAzKqKmNIFGVnUQfluAeTLLE_p1M_fIRYlfX8E8bty26HbkSFL3ySxlS1jRnKAQ..AT1_caklFlpC';
// Esri World Imagery photos, 256 px tiles. Esri tile addresses put y before x.
export const SATELLITE_URL = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}';
// Deepest zoom with real imagery. Zoom 19 had photos at every US launch site
// I checked, and zoom 20 had none, so closer zooms scale up zoom 19 tiles.
export const SATELLITE_MAX_NATIVE_ZOOM = 19;
// Esri's labels for imagery (roads, road names, places and borders) from the
// Static Basemap Tiles service. These tiles are 512 px, one zoom level
// "behind" the 256 px tiles, which map-view.js allows for.
export const SATELLITE_LABELS_URL = 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/labels/static/tile/{z}/{y}/{x}?token={key}';
// Asked once before the satellite layer goes on, to check that Esri accepts
// the key. Esri answers with the labels style's details, or an error.
export const ESRI_KEY_CHECK_URL = 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/labels/static?token={key}';
// Required credits. Esri asks for "Powered by Esri" on every map that uses
// its services, plus each layer's data credit (copied from the services'
// own copyright text, September 2026).
export const ESRI_POWERED_BY = 'Powered by <a href="https://www.esri.com">Esri</a>';
export const SATELLITE_ATTRIBUTION = 'Source: Esri, Vantor, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community';
export const SATELLITE_LABELS_ATTRIBUTION = 'Sources: Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community';
// The map background a first-time viewer sees: 'satellite' or 'dark'.
export const DEFAULT_MAP_LAYER = 'satellite';
// Where the browser remembers the viewer's choice (localStorage).
export const MAP_LAYER_STORAGE_KEY = 'fc-map-layer';
// A dark outline under tracks, markers and the ground station line, so they
// stay easy to see on bright photos.
export const HALO_COLOR = '#0B0D10';
export const HALO_OPACITY = 0.7;
// Outline width (px) on each side of a line or ring.
export const HALO_WIDTH_PX = 1.5;
// More tile errors than this, with no tile loaded at all...
export const TILE_FAIL_COUNT = 3;
// ...within this many milliseconds, and that layer counts as failed: the
// satellite layer gives way to the dark map, and the dark map to the no-map
// panel. The Esri key check gives up after the same time.
export const TILE_FAIL_TIMEOUT_MS = 8000;
// How long (ms) to wait for Leaflet or Chart.js to download before giving up.
export const LIBRARY_LOAD_TIMEOUT_MS = 10000;
// Zoom level used when there is only one point to show.
export const MAP_DEFAULT_ZOOM = 15;
// Rocket marker size (px), for other rockets and the focused one.
export const MARKER_RADIUS_PX = 7;
export const MARKER_RADIUS_FOCUSED_PX = 10;
// Track line width (px), for other rockets and the focused one.
export const TRACK_WEIGHT_PX = 2;
export const TRACK_WEIGHT_FOCUSED_PX = 3.5;
// The first view fits the pad(s) and ground station with this much room (px) around them...
export const FIT_PADDING_PX = 60;
// ...without zooming in closer than this.
export const FIT_MAX_ZOOM = 17;
// "Follow rocket" pans once the focused rocket gets this close (px) to the
// map's edge. Kept smaller than FIT_PADDING_PX so the first view stays put.
export const FOLLOW_EDGE_PX = 40;

// ------------------------------------------------------------------
// Chart (alt-chart.js)
// ------------------------------------------------------------------

// Seconds of pad data drawn before liftoff (shown as negative flight time).
export const CHART_PAD_S = 10;
// Most chart redraws per second while a flight plays.
export const CHART_MAX_FPS = 8;

// ------------------------------------------------------------------
// Colors
// ------------------------------------------------------------------

// Rocket colors, handed out in order. Chosen to stand apart on the dark
// map and chart. Amber is left out on purpose: it marks important numbers.
export const ROCKET_PALETTE = Object.freeze([
  '#39FF14', // neon green (the site's chart green)
  '#FF2BD6', // neon pink (the site's chart pink)
  '#38BDF8', // sky blue
  '#C084FC', // violet
  '#FB923C', // orange
  '#F87171', // red
  '#E5E7EB', // light grey
  '#A3E635', // lime
]);
// Ground station marker and line.
export const GROUND_STATION_COLOR = '#2DD4BF';
// Launch pad marker.
export const PAD_COLOR = '#F4F2ED';

// ------------------------------------------------------------------
// Flight library (library.js)
// ------------------------------------------------------------------

// Folder that holds index.json and one subfolder per flight, relative to
// flight-console/index.html.
export const LIBRARY_BASE = 'data/flights/';
// The manifest file inside LIBRARY_BASE.
export const MANIFEST_FILE = 'index.json';

// ------------------------------------------------------------------
// Units
// ------------------------------------------------------------------

// Feet in one meter.
export const FEET_PER_METER = 3.28084;
