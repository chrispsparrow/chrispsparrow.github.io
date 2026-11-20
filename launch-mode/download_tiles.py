"""download_tiles.py: saves the map for launch mode, so both maps work at the
field with no internet.

It reads the one setting, launch-mode/field.json (the field's center and the
size of the box), downloads the imagery for that box, and writes what it
saved to manifest.json in the tiles folder. The Flight Console's launch page
reads that manifest.

Where the imagery comes from (both are USGS, public domain):
  usgs-imagery-only   The National Map's USGSImageryOnly tile cache. It has
                      tiles down to zoom 16 and answers 404 past that.
  usgs-naip           The National Map's NAIP image service, for the closer
                      zooms. It draws any picture asked for, so this asks for
                      big blocks (8 by 8 tiles in one request) and cuts them
                      into tiles here. That is about 75 requests instead of
                      3,700.
Nothing is downloaded from Esri/ArcGIS Online, OpenStreetMap, CARTO, Bing or
Cesium ion. Their terms don't allow saving tiles in bulk.

The requests are throttled (--rate, tiles per second) and a run can be
stopped and started again: tiles already saved are skipped.

Usage:
  python launch-mode/download_tiles.py --count     the plan only, nothing downloaded
  python launch-mode/download_tiles.py             download (or carry on)
  python launch-mode/download_tiles.py --max-zoom 16   leave out the closer zooms

Tiles are saved as <folder>/<zoom>/<x>/<y>.jpg, the usual web map layout
(x from the west, y from the north).
"""

import argparse
import io
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIELD_FILE = os.path.join(HERE, 'field.json')

SOURCES = {
    'usgs-imagery-only': {
        'kind': 'tiles',
        'url': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    },
    'usgs-naip': {
        'kind': 'export',
        'url': 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage',
    },
}
CREDIT = 'USGS The National Map: Orthoimagery (USDA, USGS). Public domain.'
HEADERS = {'User-Agent': 'offline-map-tile-fetch/1.0 (python urllib)'}
TILE_PX = 256
BLOCK_TILES = 8            # an export request covers up to 8 by 8 tiles
EXPORT_PAUSE_S = 1.5       # between export requests, which are heavier
JPEG_QUALITY = 88
# What a tile averaged in the CRMRC download (10,432 tiles, 193 MB), for the
# size estimate that --count prints. Farmland and water. A city would be more.
AVERAGE_TILE_KB = 18.5
SHIFT = 20037508.342789244  # half the web map's width, in meters


# ------------------------------------------------------------------
# Tile math
# ------------------------------------------------------------------

def box_degrees(center, half_km):
    """The box half_km in each direction from the center: south, west, north, east."""
    lat, lon = center['lat'], center['lon']
    dlat = half_km / 111.32
    dlon = half_km / (111.32 * math.cos(math.radians(lat)))
    return {'south': lat - dlat, 'west': lon - dlon, 'north': lat + dlat, 'east': lon + dlon}


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_lon(x, z):
    return x / 2 ** z * 360.0 - 180.0


def tile_lat(y, z):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** z))))


def tile_meters(z, x, y):
    """A tile's edges in web map meters: minx, miny, maxx, maxy."""
    size = 2 * SHIFT / 2 ** z
    minx = -SHIFT + x * size
    maxy = SHIFT - y * size
    return minx, maxy - size, minx + size, maxy


def make_plan(field, max_zoom=None):
    """One entry per zoom level: its tile range, its box and where it comes from."""
    levels = []
    for spec in field['tiles']['levels']:
        half = field['boxHalfKm'] if spec['halfKm'] == 'box' else float(spec['halfKm'])
        box = box_degrees(field['center'], half)
        for z in range(int(spec['zoomMin']), int(spec['zoomMax']) + 1):
            if max_zoom is not None and z > max_zoom:
                continue
            x0, y0 = tile_xy(box['north'], box['west'], z)
            x1, y1 = tile_xy(box['south'], box['east'], z)
            levels.append({
                'z': z, 'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1,
                'count': (x1 - x0 + 1) * (y1 - y0 + 1),
                'halfKm': half, 'source': spec['source'], 'box': box,
                # The ground the tiles really cover (whole tiles, so a little
                # more than the box).
                'covered': {
                    'south': tile_lat(y1 + 1, z), 'west': tile_lon(x0, z),
                    'north': tile_lat(y0, z), 'east': tile_lon(x1 + 1, z),
                },
            })
    levels.sort(key=lambda lv: lv['z'])
    return levels


# ------------------------------------------------------------------
# Files
# ------------------------------------------------------------------

def tile_path(folder, z, x, y):
    return os.path.join(folder, str(z), str(x), f'{y}.jpg')


def is_saved(path):
    try:
        return os.path.getsize(path) > 100
    except OSError:
        return False


def write_file(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def as_jpeg(data):
    """The tile cache sends JPEG, or PNG where a tile has see-through parts.
    Everything is saved as JPEG so one file ending works everywhere."""
    if data[:2] == b'\xff\xd8':
        return data
    from PIL import Image  # only needed for the rare PNG tile
    img = Image.open(io.BytesIO(data)).convert('RGB')
    out = io.BytesIO()
    img.save(out, 'JPEG', quality=JPEG_QUALITY)
    return out.getvalue()


# ------------------------------------------------------------------
# Requests
# ------------------------------------------------------------------

class Throttle:
    """Lets requests through no faster than `rate` per second, over all threads."""

    def __init__(self, rate):
        self.gap = 1.0 / rate
        self.lock = threading.Lock()
        self.next = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next)
            self.next = at + self.gap
        if at > now:
            time.sleep(at - now)


def fetch(url, throttle=None, tries=4):
    """Returns (status, bytes). status is 200, 404, or 0 after every try failed."""
    wait = 2.0
    for attempt in range(tries):
        if throttle:
            throttle.wait()
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read(), res.headers.get('Content-Type', '')
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return 404, b'', ''
        except Exception:  # noqa: BLE001  a timeout or a dropped connection
            pass
        if attempt < tries - 1:
            time.sleep(wait)
            wait *= 2.5
    return 0, b'', ''


# ------------------------------------------------------------------
# The two ways to get a level
# ------------------------------------------------------------------

class Progress:
    def __init__(self, total):
        self.total = total
        self.done = 0
        self.new = 0
        self.bytes = 0
        self.failed = 0
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.last = 0.0

    def add(self, new=0, size=0, failed=0, count=1):
        with self.lock:
            self.done += count
            self.new += new
            self.bytes += size
            self.failed += failed
            now = time.monotonic()
            if now - self.last >= 15 or self.done == self.total:
                self.last = now
                took = now - self.started
                print(f'  {self.done}/{self.total} tiles  ({self.new} new, {self.bytes / 1e6:.1f} MB, '
                      f'{self.failed} failed, {took / 60:.1f} min)', flush=True)


def get_level_from_cache(level, folder, source, throttle, progress, workers):
    missing = []
    lock = threading.Lock()

    def one(xy):
        x, y = xy
        path = tile_path(folder, level['z'], x, y)
        if is_saved(path):
            progress.add()
            return
        status, data, _ = fetch(source['url'].format(z=level['z'], x=x, y=y), throttle)
        if status == 200 and len(data) > 100:
            data = as_jpeg(data)
            write_file(path, data)
            progress.add(new=1, size=len(data))
        else:
            with lock:
                missing.append([x, y])
            progress.add(failed=1)

    tiles = [(x, y) for y in range(level['y0'], level['y1'] + 1) for x in range(level['x0'], level['x1'] + 1)]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, tiles))
    return sorted(missing)


def get_level_from_export(level, folder, source, progress):
    from PIL import Image
    z = level['z']
    missing = []
    for by in range(level['y0'], level['y1'] + 1, BLOCK_TILES):
        for bx in range(level['x0'], level['x1'] + 1, BLOCK_TILES):
            xs = list(range(bx, min(bx + BLOCK_TILES, level['x1'] + 1)))
            ys = list(range(by, min(by + BLOCK_TILES, level['y1'] + 1)))
            tiles = [(x, y) for y in ys for x in xs]
            if all(is_saved(tile_path(folder, z, x, y)) for x, y in tiles):
                progress.add(count=len(tiles))
                continue
            minx, _, _, maxy = tile_meters(z, xs[0], ys[0])
            _, miny, maxx, _ = tile_meters(z, xs[-1], ys[-1])
            query = urllib.parse.urlencode({
                'bbox': f'{minx:.6f},{miny:.6f},{maxx:.6f},{maxy:.6f}',
                'bboxSR': 3857, 'imageSR': 3857,
                'size': f'{len(xs) * TILE_PX},{len(ys) * TILE_PX}',
                'format': 'jpg', 'compressionQuality': 92,
                'interpolation': 'RSP_BilinearInterpolation', 'f': 'image',
            })
            status, data, ctype = fetch(f"{source['url']}?{query}")
            time.sleep(EXPORT_PAUSE_S)
            img = None
            if status == 200 and ctype.startswith('image'):
                try:
                    img = Image.open(io.BytesIO(data)).convert('RGB')
                    if img.size != (len(xs) * TILE_PX, len(ys) * TILE_PX):
                        img = None
                except Exception:  # noqa: BLE001
                    img = None
            if img is None:
                missing.extend([x, y] for x, y in tiles)
                progress.add(failed=len(tiles), count=len(tiles))
                continue
            new = 0
            size = 0
            for row, y in enumerate(ys):
                for col, x in enumerate(xs):
                    out = io.BytesIO()
                    img.crop((col * TILE_PX, row * TILE_PX, (col + 1) * TILE_PX, (row + 1) * TILE_PX)).save(out, 'JPEG', quality=JPEG_QUALITY)
                    write_file(tile_path(folder, z, x, y), out.getvalue())
                    new += 1
                    size += out.tell()
            progress.add(new=new, size=size, count=len(tiles))
    return sorted(missing)


# ------------------------------------------------------------------
# The manifest
# ------------------------------------------------------------------

def folder_stats(folder, levels):
    """Counts what is really on disk. Every tile in a level's range that
    isn't there goes in the level's "missing" list, so a download that was
    stopped part way (or hasn't reached a level yet) never makes the maps
    ask for tiles that don't exist."""
    tiles = 0
    size = 0
    for lv in levels:
        saved = 0
        missing = []
        for x in range(lv['x0'], lv['x1'] + 1):
            for y in range(lv['y0'], lv['y1'] + 1):
                try:
                    s = os.path.getsize(tile_path(folder, lv['z'], x, y))
                except OSError:
                    s = 0
                if s > 100:
                    saved += 1
                    size += s
                else:
                    missing.append([x, y])
        lv['saved'] = saved
        lv['missing'] = missing
        tiles += saved
    return tiles, size


def write_manifest(folder, field, levels, complete):
    tiles, size = folder_stats(folder, levels)
    manifest = {
        'version': 1,
        'name': field.get('name', ''),
        'center': field['center'],
        'boxHalfKm': field['boxHalfKm'],
        'bounds': box_degrees(field['center'], field['boxHalfKm']),
        'tileUrl': '{z}/{x}/{y}.jpg',
        'tileSize': TILE_PX,
        'credit': CREDIT,
        'minZoom': min(lv['z'] for lv in levels),
        'maxZoom': max(lv['z'] for lv in levels),
        # False while a download is still running or was stopped part way.
        # Either way each level's "missing" list names every tile in its
        # range that isn't on disk yet.
        'complete': complete,
        'tiles': tiles,
        'bytes': size,
        'updated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'levels': [{k: lv[k] for k in ('z', 'x0', 'x1', 'y0', 'y1', 'count', 'saved', 'missing', 'halfKm', 'source', 'box', 'covered')} for lv in levels],
    }
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, 'manifest.json.part')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    os.replace(tmp, os.path.join(folder, 'manifest.json'))
    return manifest


# ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='Saves the launch area map for launch mode.')
    ap.add_argument('--count', action='store_true', help='print the plan and stop, downloading nothing')
    ap.add_argument('--rate', type=float, default=5.0, help='tile cache requests per second (default 5)')
    ap.add_argument('--workers', type=int, default=4, help='downloads at once (default 4)')
    ap.add_argument('--max-zoom', type=int, default=None, help='leave out zoom levels past this one')
    args = ap.parse_args()

    with open(FIELD_FILE, encoding='utf-8') as f:
        field = json.load(f)
    folder = os.path.join(ROOT, *field['tiles']['folder'].strip('/').split('/'))
    levels = make_plan(field, args.max_zoom)
    for lv in levels:
        lv['missing'] = []
    total = sum(lv['count'] for lv in levels)

    c = field['center']
    print(f"{field.get('name', 'Field')}: center {c['lat']}, {c['lon']}, box {field['boxHalfKm']} km each way")
    print(f'Saving to {folder}')
    for lv in levels:
        print(f"  zoom {lv['z']:>2}: {lv['count']:>5} tiles, {lv['halfKm']:g} km each way, from {lv['source']}")
    print(f'  total: {total} tiles, about {total * AVERAGE_TILE_KB / 1000:.0f} MB')
    if args.count:
        return 0

    write_manifest(folder, field, levels, complete=False)
    throttle = Throttle(args.rate)
    progress = Progress(total)
    # The smallest levels go first, so a run that is stopped early still has
    # every zoom level it can.
    for lv in sorted(levels, key=lambda lv: lv['count']):
        source = SOURCES[lv['source']]
        print(f"zoom {lv['z']} ({lv['count']} tiles)", flush=True)
        if source['kind'] == 'tiles':
            get_level_from_cache(lv, folder, source, throttle, progress, args.workers)
        else:
            get_level_from_export(lv, folder, source, progress)
        # The manifest keeps up with the download, level by level. Its
        # "missing" lists come from what is on disk (folder_stats).
        write_manifest(folder, field, levels, complete=False)

    manifest = write_manifest(folder, field, levels, complete=True)
    missing = sum(len(lv['missing']) for lv in levels)
    print(f"Done: {manifest['tiles']} of {total} tiles saved, {manifest['bytes'] / 1e6:.0f} MB, {missing} missing.")
    if missing:
        print('Run it again to try the missing tiles once more.')
    return 0 if missing == 0 else 2


if __name__ == '__main__':
    sys.exit(main())
