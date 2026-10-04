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
// Playback (player.js and the altitude timeline, timeline.js)
// ------------------------------------------------------------------

// Speed buttons under the altitude timeline, as multiples of real time.
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
// readings panel, the altitude tape and the map label instead of looking live.
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

// Mission header (clock, flags) and the phase strip.
export const HEADER_MAX_FPS = 10;
// Rocket chips.
export const ROCKET_BAR_MAX_FPS = 8;
// Readings panel and altitude tape.
export const STATS_MAX_FPS = 10;
// Map markers, tracks and the no-map panel, and everything drawn in the
// 3D view.
export const MAP_MAX_FPS = 12;
// Mission timeline (the event list).
export const LOG_MAX_FPS = 8;
// Debug panel (only while it is open).
export const DEBUG_MAX_FPS = 4;
// Altitude timeline: the playhead, the played part of the curve, the play
// button and the time.
export const CONTROLS_MAX_FPS = 20;
// Seeks while the altitude timeline is being dragged.
export const SCRUB_SEEKS_PER_S = 30;
// How far (s of recording time) the arrow keys move the playhead when the
// altitude timeline has keyboard focus, and how far Page Up and Page Down
// (or Shift with an arrow key) move it.
export const TIMELINE_KEY_STEP_S = 1;
export const TIMELINE_KEY_BIG_STEP_S = 10;

// ------------------------------------------------------------------
// Small view settings
// ------------------------------------------------------------------

// How long (ms) "Link copied" shows on the copy button.
export const LINK_COPIED_MS = 2500;
// The mission timeline follows new entries only if you are within this many
// pixels of the bottom (so reading older entries isn't interrupted).
export const LOG_AUTOSCROLL_PX = 48;
// The newest entry in the mission timeline shows a "Now" tag while the
// playhead is within this many seconds (of flight data) after the event was
// confirmed. After that it stays highlighted, without the tag.
export const EVENT_NOW_S = 10;

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
export const HALO_COLOR = '#04080F';
export const HALO_OPACITY = 0.7;
// Outline width (px) on each side of a line or ring.
export const HALO_WIDTH_PX = 1.5;
// More tile errors than this, with no tile loaded at all...
export const TILE_FAIL_COUNT = 3;
// ...within this many milliseconds, and that layer counts as failed: the
// satellite layer gives way to the dark map, and the dark map to the no-map
// panel. The Esri key check gives up after the same time.
export const TILE_FAIL_TIMEOUT_MS = 8000;
// How long (ms) to wait for Leaflet to download before giving up.
export const LIBRARY_LOAD_TIMEOUT_MS = 10000;
// Zoom level used when there is only one point to show.
export const MAP_DEFAULT_ZOOM = 15;
// Rocket icon height (px), for other rockets and the focused one.
export const ROCKET_ICON_PX = 22;
export const ROCKET_ICON_FOCUSED_PX = 30;
// Track line width (px), for other rockets and the focused one. The focused
// rocket's track is gold (TRACK_COLOR), the others use their own colors.
export const TRACK_WEIGHT_PX = 2;
export const TRACK_WEIGHT_FOCUSED_PX = 3.5;
// The first view fits the pad(s) and ground station with this much room (px)
// around them, on top of whatever the floating panels cover...
export const FIT_PADDING_PX = 60;
// ...without zooming in closer than this.
export const FIT_MAX_ZOOM = 17;
// "Follow rocket" pans once the focused rocket gets this close (px) to the
// map's edge or a floating panel. Kept smaller than FIT_PADDING_PX so the
// first view stays put.
export const FOLLOW_EDGE_PX = 40;

// ------------------------------------------------------------------
// 3D view (cesium-loader.js and globe-view.js)
// ------------------------------------------------------------------

// The CesiumJS release the 3D view uses, pinned to this exact version. It
// comes from Cesium's own release CDN, and only when a viewer asks for the
// 3D view. To move to a newer release, change the number and check that
// both addresses below still open.
export const CESIUM_VERSION = '1.146';
// The folder Cesium loads its own extra files from (its workers and assets).
export const CESIUM_BASE_URL = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
export const CESIUM_JS_URL = `${CESIUM_BASE_URL}Cesium.js`;
export const CESIUM_CSS_URL = `${CESIUM_BASE_URL}Widgets/widgets.css`;
// How long (ms) to wait for Cesium to download before giving up.
export const CESIUM_LOAD_TIMEOUT_MS = 30000;
// Cesium ion token, for Cesium World Terrain and ion's aerial imagery. It
// is restricted to my sites: ion only accepts it from pages on
// https://dogtoothsystems.com, https://www.dogtoothsystems.com,
// https://chrispsparrow.github.io, http://localhost:8000 and
// http://127.0.0.1:8000. It only has the assets:read scope, so it can't
// change anything in my ion account, and it never expires. That makes it
// safe to publish here.
export const CESIUM_ION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IlZCZlpOUEZ2TGM4RGFua2YiLCJqdGkiOiI4YTE3MTgzNS00OWI3LTRkZWUtYWY2My05YmQ0MjMxMDE1ZDQiLCJpZCI6NTEyNDgwLCJzdWIiOiJjaHJpc3BzcGFycm93IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6ImRvZ3Rvb3Roc3lzdGVtcyBmbGlnaHQgY29uc29sZSIsImlhdCI6MTc5MDgwNDQ0OH0.w7czJXSDb0m3jKbuE_MjS1tzy0kj6FDvregkSO5zwdI';
// Where the browser remembers whether the viewer last used the map or the
// 3D view (localStorage). Cesium still never downloads by itself. If it is
// already on the page from an earlier flight in the same visit, the 3D
// view starts straight away.
export const VIEW_STORAGE_KEY = 'fc-map-view';
// How long (ms) to wait for Cesium World Terrain to load, and then for
// the ground height at a launch pad, before drawing with approximate
// heights instead.
export const TERRAIN_SAMPLE_TIMEOUT_MS = 8000;
// Once Cesium has downloaded and the 3D view has started, the "Loading
// the 3D view..." panel goes away when the first picture is in, or after
// this long (ms) whatever has loaded by then. The download has its own
// limit, CESIUM_LOAD_TIMEOUT_MS.
export const GLOBE_READY_TIMEOUT_MS = 8000;
// A launch pad that moves less than this (m) keeps the ground height
// already looked up for it (GPS readings wander a little on the pad).
export const PAD_RESAMPLE_M = 10;
// The 3D view draws at most this many screen pixels per CSS pixel, so
// phones with very sharp screens don't burn battery on detail nobody sees.
export const GLOBE_MAX_PIXEL_RATIO = 2;
// The starting camera: this many degrees clockwise from north (0 looks
// north, with east on the right)...
export const GLOBE_START_HEADING_DEG = 0;
// ...at this pitch in degrees. Negative looks down, so -12 is 12 degrees
// down from level. Keep it negative, or the camera starts under the
// ground looking up...
export const GLOBE_START_PITCH_DEG = -12;
// ...from this many times the flight's highest point away, so the climb,
// the highest point and the drift all fit...
export const GLOBE_START_RANGE_PER_APOGEE = 3;
// ...but never closer or farther than this (m). The first value is also
// the distance when the highest point isn't known yet.
export const GLOBE_START_RANGE_MIN_M = 1500;
export const GLOBE_START_RANGE_MAX_M = 60000;
// How close (m) and how far (m) the camera can zoom from what it looks at.
export const GLOBE_ZOOM_MIN_M = 40;
export const GLOBE_ZOOM_MAX_M = 400000;
// How far the 3D camera turns for each pixel of a drag (degrees). Lower is
// calmer. At 0.25, a drag across 720 px goes half way round.
export const GLOBE_ORBIT_DEG_PER_PX = 0.25;
// One notch of the mouse wheel moves the camera this many times closer or
// farther. 1.2 is 20 percent a notch.
export const GLOBE_ZOOM_PER_NOTCH = 1.2;
// The arrow keys turn the camera this far sideways (degrees) and half as
// far up or down. The + and - keys zoom by GLOBE_KEY_ZOOM.
export const GLOBE_KEY_TURN_DEG = 10;
export const GLOBE_KEY_ZOOM = 1.25;
// The steepest and the flattest the camera can look (degrees). Negative
// looks down, so -88 is almost straight down. A little above 0 lets it
// look up at a rocket from below.
export const GLOBE_PITCH_MIN_DEG = -88;
export const GLOBE_PITCH_MAX_DEG = 30;
// The camera stays at least this far (m) above the ground.
export const GLOBE_GROUND_CLEARANCE_M = 15;
// How long (ms) the camera takes to glide to a new view ("Follow rocket",
// "Whole flight", "Reset view"). With less motion asked for, it jumps.
export const GLOBE_MOVE_MS = 600;
// "Whole flight" leaves this much room around everything it frames (1 is
// a tight fit).
export const GLOBE_FIT_MARGIN = 1.35;
// Icons and labels keep their full size up to the first distance (m) and
// shrink to the given fraction by the second, so a far view isn't crowded.
export const GLOBE_ICON_NEAR_M = 20000;
export const GLOBE_ICON_FAR_M = 400000;
export const GLOBE_ICON_FAR_SCALE = 0.7;
// The drop line from the focused rocket down to the ground: its color and
// its width (px), not counting the thin dark outline.
export const DROP_LINE_COLOR = '#E8E6DF';
export const DROP_LINE_WIDTH_PX = 2;

// ------------------------------------------------------------------
// Colors
// ------------------------------------------------------------------

// Rocket colors, handed out in order. Chosen to stand apart on the map and
// the altitude timeline. Some colors are left out on purpose, because they
// already mean something on this page: gold (the focused rocket and the
// most important numbers), green (only the labels on the map), teal (the
// ground station) and coral or red (no GPS fix and other warnings).
export const ROCKET_PALETTE = Object.freeze([
  '#C084FC', // violet
  '#38BDF8', // sky blue
  '#FF2BD6', // neon pink (the site's chart pink)
  '#E5E7EB', // light grey
  '#FB923C', // orange
  '#818CF8', // indigo
]);
// The focused rocket's track on the map and its played curve on the altitude
// timeline (the page's gold).
export const TRACK_COLOR = '#D4A843';
// Ground station icon and line (the page's teal).
export const GROUND_STATION_COLOR = '#3FB8A8';
// Launch pad icon (the page's off-white).
export const PAD_COLOR = '#E8E6DF';

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
