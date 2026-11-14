// config.js
// Every adjustable number and setting for the Flight Console lives here, so
// tuning never means hunting through the code.
// Used by: detector.js, store.js, track.js, flight-state.js, player.js,
// fleet.js, library.js, the views, main.js, both Node tools in tools/ and
// the tests in test/.
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
/// Data that starts with the rocket already flying. Climbing counts once
// the liftoff climb below is seen with no pad under it, rising more than
// LIFTOFF_FIX_BACK_AGL_M (a GPS settling after power-up can have its first
// fixes far too low and climb toward the truth). Falling counts once
// the vertical speed stays under -START_FALL_MIN_MPS (m/s) for
// START_FALL_CONFIRM_S (s) and the altitude drops more than LIFTOFF_AGL_M
// in that time. That also covers a confirmed "pad" that keeps sinking more
// than LIFTOFF_AGL_M below itself (data that starts under a main
// parachute can look still at first). A GPS that settles after power-up
// sinks about 1 m/s at most, and wander changes direction, so neither can
// keep it up for 10 s.
export const START_FALL_MIN_MPS = 3;
export const START_FALL_CONFIRM_S = 10;

// Ground height (m above mean sea level) assumed when a rocket has no pad
// readings, for example when the data starts in flight. 700 m is the
// simulator's placeholder launch site. Change it for a real site.
export const GROUND_ELEV_FALLBACK_M = 700;

// Vertical speed is averaged over this many seconds before it is shown or used.
export const VSPEED_AVG_S = 3;

// Liftoff needs evidence a board sitting on a desk can't produce. On my
// bench a still board wandered 15 m by 30 m sideways, and GPS altitude
// wanders a few times more than that, with single jumps of 30 m or more.
// A real rocket climbs at 100 m/s or more, so my 1 Hz GPS goes from the
// pad to hundreds of meters in a few seconds. There are two ways in.
//
// 1. A climb: LIFTOFF_CONFIRM_READINGS altitude readings in a row (at
//    least LIFTOFF_CONFIRM_S apart from first to last), each higher than
//    the one before by at least LIFTOFF_MIN_STEP_MPS (m/s), each more than
//    LIFTOFF_AGL_M (m) above the pad, and an average climb rate over the
//    whole run (from the last reading before it) faster than
//    LIFTOFF_VSPEED_MPS (m/s). One jump, a step that stays, or slow wander
//    can't do all of that.
export const LIFTOFF_AGL_M = 30;
export const LIFTOFF_VSPEED_MPS = 30;
export const LIFTOFF_MIN_STEP_MPS = 5;
export const LIFTOFF_CONFIRM_READINGS = 3;
export const LIFTOFF_CONFIRM_S = 1;
// 2. A comeback far above the pad: the first altitude reading after a
//    break (the GPS fix dropped, or nothing came for more than
//    LIFTOFF_BREAK_S) is more than LIFTOFF_FIX_BACK_AGL_M (m) above the
//    pad, it means climbing faster than LIFTOFF_VSPEED_MPS since the last
//    pad reading, and the next reading is that high too. My GPS often
//    loses its fix in boost and gets it back high above the pad.
export const LIFTOFF_FIX_BACK_AGL_M = 150;
export const LIFTOFF_BREAK_S = 2.5;
// (Liftoff time: the first reading of the climb. If the GPS fix dropped on
// the pad after the last pad reading, the drop is the estimated liftoff
// time instead, as with a GPS-only board losing its fix in boost. After a
// plain break in the data, it is the last pad reading. Both are marked as
// estimated.)
// The receiver's ground speed (gps.speed) is horizontal only, so a rocket
// going straight up reports about the same speed as a board on a desk. It
// can't help with liftoff. It is used for the landing below.

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

// Landed. Only possible after liftoff and apogee, or once the altitude is
// at least LANDED_ARM_DROP_M (m) below its highest point (a low flight
// that never armed apogee). A board on a desk never gets there.
export const LANDED_ARM_DROP_M = 50;
// Then, over a sliding window of this many seconds (s)...
export const LANDED_WINDOW_S = 20;
// ...the altitude stays within this range (m). With 10 or more readings
// the single highest and single lowest are set aside first, so one bad
// GPS altitude can't hold the landing off...
export const LANDED_ALT_RANGE_M = 15;
// ...with no downward trend: the best straight line through the window's
// altitudes sinks slower than this (m/s)...
export const LANDED_MAX_SINK_MPS = 0.5;
// ...every GPS fix in the window is within this distance (m) of the
// window's average position (so they all fit in a circle this size). With
// 10 or more fixes the one farthest from the average is set aside first,
// so one wild fix can't hold the landing off, and it stays out of the
// recovery position too...
export const LANDED_RADIUS_M = 50;
// ...and, when the receiver sent its own ground speed, every one in the
// window is under this (m/s). A still board reports almost 0 however much
// its position wanders. Without ground speed the rest decides alone.
export const LANDED_MAX_SPEED_MPS = 2;
// The window needs at least this many altitude readings, so two readings
// 20 s apart (the fix lost in the grass) can't confirm a landing.
export const LANDED_MIN_READINGS = 5;
// The landing time is the first reading in the window no more than this
// (m) above the window's middle (median) altitude: the touchdown. The
// recovery position is the average of the fixes from there to the moment
// the landing was confirmed, never the last fix on its own.
export const LANDED_TOUCHDOWN_M = 5;

// Collected in one object, the shape createDetector() expects.
export const DETECTOR_DEFAULTS = Object.freeze({
  PAD_AVG_S,
  PAD_STILL_MAX_MPS,
  PAD_CONFIRM_S,
  PAD_SPREAD_M,
  PAD_RUN_MIN_S,
  START_FALL_MIN_MPS,
  START_FALL_CONFIRM_S,
  GROUND_ELEV_FALLBACK_M,
  VSPEED_AVG_S,
  LIFTOFF_AGL_M,
  LIFTOFF_VSPEED_MPS,
  LIFTOFF_MIN_STEP_MPS,
  LIFTOFF_CONFIRM_READINGS,
  LIFTOFF_CONFIRM_S,
  LIFTOFF_FIX_BACK_AGL_M,
  LIFTOFF_BREAK_S,
  APOGEE_ARM_AGL_M,
  APOGEE_CONFIRM_S,
  DROGUE_MIN_DESCENT_MPS,
  MAIN_MAX_DESCENT_MPS,
  MAIN_MIN_DESCENT_MPS,
  MAIN_MIN_AGL_M,
  DESCENT_CONFIRM_S,
  LANDED_ARM_DROP_M,
  LANDED_WINDOW_S,
  LANDED_ALT_RANGE_M,
  LANDED_MAX_SINK_MPS,
  LANDED_RADIUS_M,
  LANDED_MAX_SPEED_MPS,
  LANDED_MIN_READINGS,
  LANDED_TOUCHDOWN_M,
});

// ------------------------------------------------------------------
// The track on the map (track.js): which fixes join the line
// ------------------------------------------------------------------

// The quality gate. A fix joins the line only if it is a 3D fix (a fresh
// position with a fresh altitude, see track.js) with at least this many
// satellites...
export const MIN_SATS = 6;
// ...and an HDOP at most this. Other fixes show as hollow grey dots.
export const MAX_HDOP = 3;
// Outlier rejection. A fix that would mean the board moved faster than
// this (m/s, straight line through the air) since the last good fix is
// skipped. The GPS itself stops tracking at 500 m/s even in its airborne
// mode, so anything faster can't be a real fix.
export const OUTLIER_MAX_SPEED_MPS = 600;
// ...and no single hop under this many meters counts as an outlier, so
// normal GPS wander (two fixes 1 s apart can sit 20 m apart) never does.
export const OUTLIER_MIN_JUMP_M = 150;
// If this many outliers in a row agree with each other (each one possible
// from the one before), the last good fix was the wrong one. The trail
// starts again from them, after a gap.
export const OUTLIER_RESET_FIXES = 3;
// Packets further apart than this (s) leave a gap in the line instead of
// a bridge, when the packets carry no sequence number. With one, any
// missed number is a gap. The line also never bridges more than this
// between two good fixes (weak ones in between included). The board sends
// one packet a second.
export const TRACK_GAP_S = 2.5;
// The line (never the dots) is smoothed with a moving average of this
// many good fixes...
export const LINE_SMOOTH_FIXES = 3;
// ...but a line point never sits more than this (m) from its own fix. The
// smoothing only takes out small jitter, and the line keeps up with a
// rocket climbing at hundreds of meters a second.
export const LINE_SMOOTH_MAX_M = 10;
// A fix right after a gap gets the average speed across the gap for its
// color, if the gap is no longer than this (s). After a longer gap its
// speed is unknown.
export const TRACK_SPEED_GAP_MAX_S = 10;
// The speed (m/s) at the fast end of the track's speed colors.
export const TRACK_SPEED_MAX_MPS = 300;

// ------------------------------------------------------------------
// The pad checklist (flight-state.js): what READY needs
// ------------------------------------------------------------------

// GPS LOCK is good with a fix and at least this many satellites.
export const PAD_READY_MIN_SATS = 6;
// HDOP is good at or under this.
export const PAD_READY_MAX_HDOP = 3;
// LINK is good while packets arrive at this rate or better (packets a
// second, averaged over PAD_LINK_WINDOW_S).
export const PAD_READY_MIN_PKT_PER_S = 0.5;
export const PAD_LINK_WINDOW_S = 10;

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
// the HUD's PKT line turns amber and the map draws its marker hollow.
export const LINK_STALE_S = 5;
// Altitude and vertical speed older than this (s) are marked as old in the
// HUD and in panel 2's readings instead of looking live.
export const ALTITUDE_STALE_S = 1.5;
// A vertical speed shows an up or down arrow only when the number on screen
// (rounded to 0.1 m/s) is more than this.
// GPS height noise on a board that is lying still reads as about 0.3 m/s
// either way, so anything under this would only make the arrow flicker.
export const LEVEL_VSPEED_MPS = 0.5;

// ------------------------------------------------------------------
// How often each part of the console redraws while a flight plays
// (times per second). Lower numbers save battery on phones.
// ------------------------------------------------------------------

// The flight phase bar.
export const HEADER_MAX_FPS = 10;
// Rocket chips.
export const ROCKET_BAR_MAX_FPS = 8;
// The HUD.
export const STATS_MAX_FPS = 10;
// Map markers, tracks and the no-map panel, and everything drawn in the
// 3D view.
export const MAP_MAX_FPS = 12;
// Mission timeline (the event list).
export const LOG_MAX_FPS = 8;
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
// A dark outline under tracks, markers and the radio link line, so they
// stay easy to see on bright photos and over dark water (the theme's
// near-black background color).
export const HALO_COLOR = '#07060D';
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
// The first view fits the pad(s) and ground station with this much room (px)
// around them, on top of whatever the floating panels cover...
export const FIT_PADDING_PX = 60;
// ...without zooming in closer than this.
export const FIT_MAX_ZOOM = 17;
// FOLLOW BOARD pans once the focused board gets this close (px) to the
// map's edge or a HUD block (2D map). Kept smaller than FIT_PADDING_PX so
// the first view stays put.
export const FOLLOW_EDGE_PX = 40;

// ------------------------------------------------------------------
// 3D view (cesium-loader.js and globe-view.js)
// ------------------------------------------------------------------

// The CesiumJS release the 3D view uses, pinned to this exact version. It
// comes from Cesium's own release CDN, and only when the 3D view opens
// (see DEFAULT_VIEW). To move to a newer release, change the number and check that
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
// The view a flight opens on: '3d' or 'map'. With '3d', Cesium downloads
// as soon as a flight opens. With 'map', it waits for a click on "3D".
// Once the viewer picks a view, the page keeps to it for the rest of the
// visit. Nothing is kept between visits, so each visit starts here.
export const DEFAULT_VIEW = '3d';
// How long (ms) to wait for Cesium World Terrain to load, and then for
// the ground height at a launch pad, before drawing with approximate
// heights instead.
export const TERRAIN_SAMPLE_TIMEOUT_MS = 8000;
// Once Cesium has downloaded and the 3D view has started, the
// "3D VIEWER LOADING..." message goes away when the first picture is in,
// or after this long (ms) whatever has loaded by then. The download has
// its own limit, CESIUM_LOAD_TIMEOUT_MS.
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
// How long (ms) the camera takes to glide to a new view (WHOLE FLIGHT,
// RESET VIEW). With less motion asked for, it jumps. The follow camera
// has its own glide, in globe-view.js.
export const GLOBE_MOVE_MS = 600;

// ------------------------------------------------------------------
// Colors. The Flight Console has one palette, in
// css/flight-console-theme.css: near-black #07060D, white #FFFFFF,
// off-white #E8EDF2 and amber #F9A23A (hover, active states and
// warnings). The few the map and the 3D view draw with are written out
// as hex here, because they need plain colors (and Node reads this file
// too). The near-black is HALO_COLOR, above.
// ------------------------------------------------------------------

// The theme's white.
export const COLOR_WHITE = '#FFFFFF';
// The thermal "ironbow" ramp, slow to fast (the same seven stops as the
// hero's currents and --fc-ramp-0 to --fc-ramp-6 in the theme).
export const THERMAL_RAMP = Object.freeze(['#07060D', '#1E0B3A', '#5A0F6B', '#A3215A', '#E0552B', '#F9A23A', '#FFF1B0']);

// Rocket colors, handed out in order, for the rockets that aren't focused
// (flights with two or more rockets): whites and greys, so they stay
// apart from the focused rocket's speed colors.
export const ROCKET_PALETTE = Object.freeze([
  '#E8EDF2', // off-white
  '#C3C7CD', // light grey
  '#A0A3A9', // dim off-white (66% off-white, 34% background)
  '#FFFFFF', // white
  '#7C7F86', // mid grey
  '#D9DDE2', // pale grey
]);
// The start point's dot, the ground station's dish and the board marker's
// outline (the theme's off-white).
export const PAD_COLOR = '#E8EDF2';

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
