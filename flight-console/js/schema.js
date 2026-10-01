// schema.js
// The channel registry: one entry for every value a board can send, with the
// sensor group it belongs to, a label and unit for display, and the column or
// field names ("aliases") that different files use for it.
// Used by: parser.js (to turn raw fields into samples), stats-panel.js (to
// build one section per sensor group), and anything that needs
// hasGoodPosition(). No DOM, so Node can import it too.
//
// An alias is either a name, or { name, scale } when the file stores the
// value in another unit. For example { name: 'uptime_ms', scale: 0.001 }
// turns milliseconds into seconds. Names are matched ignoring upper and lower
// case.
//
// kind tells the parser how to read a value:
//   'number' (the default), 'flag' (1 or 0, also accepts yes/no and
//   true/false), or 'text'.

// Sensor groups, in the order the stats panel shows them.
export const GROUPS = Object.freeze(['gps', 'baro', 'imu', 'radio', 'power', 'status']);

// How each group is named on the page.
export const GROUP_LABELS = Object.freeze({
  gps: 'GPS',
  baro: 'Barometer',
  imu: 'IMU',
  radio: 'Radio link',
  power: 'Power',
  status: 'Board status',
});

// Identity fields: not a sensor group, but every sample has them.
const IDENTITY = [
  { key: 'rocketId', group: null, label: 'Rocket ID', unit: '', kind: 'text',
    aliases: ['id', 'rocket_id', 'board_id', 'rocketid', 'node', 'node_id', 'nodeid'] },
  { key: 't', group: null, label: 'Time', unit: 's', decimals: 1,
    aliases: ['t', 't_s', 'time_s', 'up_s',
      { name: 'uptime_ms', scale: 0.001 }, { name: 'uptimems', scale: 0.001 }] },
  { key: 'type', group: null, label: 'Packet type', unit: '', kind: 'text',
    aliases: ['type'] },
];

const GPS = [
  // The firmware's "fix" means its GPS parser has a position that was updated
  // less than 2 seconds ago (packet flag bit 0, or "fix=yes" in bench_rx lines).
  { key: 'fix', group: 'gps', label: 'GPS fix', unit: '', kind: 'flag',
    aliases: ['fix', 'gps_fix', 'location_fresh'] },
  { key: 'sats', group: 'gps', label: 'Satellites', unit: '', decimals: 0,
    aliases: ['sats', 'satellites', 'num_sats'] },
  // Horizontal dilution of precision: lower is better, under 2 is good.
  { key: 'hdop', group: 'gps', label: 'HDOP', unit: '', decimals: 2,
    aliases: ['hdop', { name: 'hdop_x100', scale: 0.01 }] },
  { key: 'lat', group: 'gps', label: 'Latitude', unit: '°', decimals: 5,
    aliases: ['lat', 'latitude', 'lat_deg', { name: 'latitude_e7', scale: 1e-7 }] },
  { key: 'lon', group: 'gps', label: 'Longitude', unit: '°', decimals: 5,
    aliases: ['lon', 'lng', 'longitude', 'lon_deg', { name: 'longitude_e7', scale: 1e-7 }] },
  { key: 'altMsl', group: 'gps', label: 'Altitude above sea level', unit: 'm', decimals: 1,
    aliases: ['alt_msl_m', 'alt', 'alt_m', 'altitude_m', { name: 'altitude_cm', scale: 0.01 }] },
  { key: 'speed', group: 'gps', label: 'Horizontal speed', unit: 'm/s', decimals: 1,
    aliases: ['speed_mps', 'speed', 'spd_mps', { name: 'ground_speed_cm_per_s', scale: 0.01 }] },
  { key: 'course', group: 'gps', label: 'Course', unit: '°', decimals: 0,
    aliases: ['course_deg', 'course', 'crs_deg', { name: 'course_cdeg', scale: 0.01 }] },
  // 1 = the position is old. The firmware has no stale field of its own. For
  // decoded packets the parser sets it when the "altitude fresh" flag (bit 1)
  // is off, so a good position needs fresh lat, lon AND altitude.
  // bench_rx text lines only print fix= (bit 0), not bit 1, so for those the
  // altitude's freshness is unknown and stale stays null.
  { key: 'stale', group: 'gps', label: 'Position is old', unit: '', kind: 'flag',
    aliases: ['stale'] },
];

const BARO = [
  { key: 'altM', group: 'baro', label: 'Barometric altitude', unit: 'm', decimals: 1,
    aliases: ['baro_alt_m', 'baro_alt'] },
  { key: 'pressurePa', group: 'baro', label: 'Pressure', unit: 'Pa', decimals: 0,
    aliases: ['pressure_pa'] },
  { key: 'tempC', group: 'baro', label: 'Temperature', unit: '°C', decimals: 1,
    aliases: ['temp_c'] },
];

const IMU = [
  { key: 'ax', group: 'imu', label: 'Acceleration X', unit: 'm/s²', decimals: 2, aliases: ['ax', 'accel_x'] },
  { key: 'ay', group: 'imu', label: 'Acceleration Y', unit: 'm/s²', decimals: 2, aliases: ['ay', 'accel_y'] },
  { key: 'az', group: 'imu', label: 'Acceleration Z', unit: 'm/s²', decimals: 2, aliases: ['az', 'accel_z'] },
  { key: 'gx', group: 'imu', label: 'Rotation rate X', unit: 'deg/s', decimals: 1, aliases: ['gx', 'gyro_x'] },
  { key: 'gy', group: 'imu', label: 'Rotation rate Y', unit: 'deg/s', decimals: 1, aliases: ['gy', 'gyro_y'] },
  { key: 'gz', group: 'imu', label: 'Rotation rate Z', unit: 'deg/s', decimals: 1, aliases: ['gz', 'gyro_z'] },
  // Orientation quaternion: four numbers that describe which way the board
  // points. Only shown when a board actually sends them.
  { key: 'qw', group: 'imu', label: 'Orientation qw', unit: '', decimals: 3, aliases: ['qw'] },
  { key: 'qx', group: 'imu', label: 'Orientation qx', unit: '', decimals: 3, aliases: ['qx'] },
  { key: 'qy', group: 'imu', label: 'Orientation qy', unit: '', decimals: 3, aliases: ['qy'] },
  { key: 'qz', group: 'imu', label: 'Orientation qz', unit: '', decimals: 3, aliases: ['qz'] },
];

const RADIO = [
  // Measured by the receiver, not sent by the rocket.
  { key: 'rssi', group: 'radio', label: 'RSSI', unit: 'dBm', decimals: 1,
    aliases: ['rssi', 'rssi_dbm'] },
  { key: 'snr', group: 'radio', label: 'SNR', unit: 'dB', decimals: 1,
    aliases: ['snr', 'snr_db'] },
];

const POWER = [
  { key: 'battV', group: 'power', label: 'Battery', unit: 'V', decimals: 2,
    aliases: ['batt_v', 'vbat', 'battery_v'] },
];

const STATUS = [
  // Text the board itself reports, for example "drogue_fired".
  { key: 'event', group: 'status', label: 'Board event', unit: '', kind: 'text',
    aliases: ['event', 'status_event'] },
];

// The full registry.
export const CHANNELS = Object.freeze([
  ...IDENTITY, ...GPS, ...BARO, ...IMU, ...RADIO, ...POWER, ...STATUS,
].map((c) => Object.freeze({ kind: 'number', decimals: 1, ...c })));

// Every name a channel answers to: its aliases, plus its own key (so a file
// written in the page's own shape, like "altMsl" or "battV", reads back).
function namesOf(channel) {
  const names = channel.aliases.map((alias) => ({
    name: (typeof alias === 'string' ? alias : alias.name).toLowerCase(),
    scale: typeof alias === 'string' ? 1 : (alias.scale ?? 1),
  }));
  if (!names.some((n) => n.name === channel.key.toLowerCase())) names.push({ name: channel.key.toLowerCase(), scale: 1 });
  return names;
}

// Lower-case name -> { channel, scale }. Built once. If two channels share
// a name, the first one in the registry wins.
const ALIAS_INDEX = new Map();
// Group -> (lower-case name -> { channel, scale }), for nested JSON like
// {"baro": {"alt_m": 152}}, where the group says which channel is meant.
const GROUP_ALIAS_INDEX = new Map();
for (const channel of CHANNELS) {
  for (const { name, scale } of namesOf(channel)) {
    if (!ALIAS_INDEX.has(name)) ALIAS_INDEX.set(name, { channel, scale });
    if (channel.group) {
      if (!GROUP_ALIAS_INDEX.has(channel.group)) GROUP_ALIAS_INDEX.set(channel.group, new Map());
      const byName = GROUP_ALIAS_INDEX.get(channel.group);
      if (!byName.has(name)) byName.set(name, { channel, scale });
    }
  }
}
// Inside a group, a few general names mean that group's channel.
GROUP_ALIAS_INDEX.get('baro').set('alt_m', { channel: CHANNELS.find((c) => c.key === 'altM'), scale: 1 });
GROUP_ALIAS_INDEX.get('baro').set('alt', { channel: CHANNELS.find((c) => c.key === 'altM'), scale: 1 });

// Finds the channel a raw field name belongs to, or null if none does.
export function lookupAlias(fieldName) {
  if (typeof fieldName !== 'string') return null;
  return ALIAS_INDEX.get(fieldName.trim().toLowerCase()) ?? null;
}

// Like lookupAlias, but only among one sensor group's channels.
export function lookupAliasInGroup(group, fieldName) {
  if (typeof fieldName !== 'string') return null;
  return GROUP_ALIAS_INDEX.get(group)?.get(fieldName.trim().toLowerCase()) ?? null;
}

// Every channel in one sensor group, in registry order.
export function channelsInGroup(group) {
  return CHANNELS.filter((c) => c.group === group);
}

// The channel with this key, for example channelByKey('altMsl').
export function channelByKey(key) {
  return CHANNELS.find((c) => c.key === key) ?? null;
}

// True only when this sample holds a position that can be trusted: the board
// says it has a fix, the position is not stale, and latitude, longitude and
// altitude are all real numbers. Everything that draws or measures a
// position uses this. The firmware keeps sending the last known position
// after the fix is lost, so the numbers alone are never enough.
export function hasGoodPosition(sample) {
  const gps = sample?.gps;
  if (!gps) return false;
  return gps.fix === 1 && gps.stale !== 1 &&
    Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && Number.isFinite(gps.altMsl);
}
