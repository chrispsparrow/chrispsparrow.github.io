# vendor

Local copies of the three things the Flight Console normally downloads from
other sites when it opens: CesiumJS, Leaflet and the fonts.

Only the launch page (`../launch.html`) uses them, so it can load at a launch
field with no internet. The normal page (`../index.html`) still gets all three
from the internet and never loads anything from this folder.

None of this is my code. Every file is an unchanged copy of what its authors
published. Don't edit them. To change one, fetch it again (the steps are at
the end). The `.gitattributes` file here tells git to leave line endings
alone, so the hashes below keep matching on every computer.

| Folder | What it is | Version | License |
|---|---|---|---|
| `cesium/` | CesiumJS, the 3D globe library | 1.146 | Apache-2.0, in `cesium/LICENSE.md` |
| `leaflet/` | Leaflet, the 2D map library | 1.9.4 | BSD-2-Clause, in `leaflet/LICENSE` |
| `fonts/` | Barlow Condensed, Funnel Sans, Share Tech Mono and Space Grotesk | listed below | SIL Open Font License 1.1, in `fonts/OFL-*.txt` |

All three were fetched on 2026-11-19.

## cesium/

The `Build/Cesium` folder of CesiumJS 1.146, the release `CESIUM_VERSION` in
`../js/config.js` names. 344 files, 13.2 MB.

- From: the npm package `cesium@1.146.0`
  (`https://registry.npmjs.org/cesium/-/cesium-1.146.0.tgz`), folder
  `package/Build/Cesium`.
- Left out: `index.js` and `index.cjs`. They are the same library packed for
  bundlers, and a page that loads `Cesium.js` with a script tag never asks for
  them.
- Added: `LICENSE.md` from the package's top folder. It also lists the
  licenses of the libraries Cesium includes.
- Checked: all 343 files from the build have the same sha256 as the same file
  under `https://cesium.com/downloads/cesiumjs/releases/1.146/Build/Cesium/`,
  which is where the normal page loads Cesium from.
  `Cesium.js` is `a5ab7e638f51d3bc5a6c710a79c9aecea42d9252b5cd2dad34980ea771c2c9af`.

On the launch page `../js/views/cesium-loader.js` loads `Cesium.js` and
`Widgets/widgets.css` from here and points Cesium at this folder for
everything else it fetches (`Assets/`, `ThirdParty/`). Cesium's workers are a
special case. When this folder is on the same site as the page, Cesium starts
them from a copy built into `Cesium.js` and never asks for `Workers/`. The
folder is kept anyway, so this is the whole build.

## leaflet/

Leaflet 1.9.4, the version `../index.html` loads from cdnjs. 9 files, 0.4 MB.

- From: the npm package `leaflet@1.9.4`, folder `package/dist`: `leaflet.js`,
  `leaflet.css`, `leaflet.js.map` and `images/`. `LICENSE` is from the
  package's top folder.
- Checked: both files hash to the `integrity` values `../index.html` pins.
  - `leaflet.js` is `sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH`
  - `leaflet.css` is `sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H`
- `leaflet.js.map` is only there so the browser's developer tools don't
  report a missing file. The page itself never loads it.

## fonts/

The four font families `../index.html` asks Google Fonts for, in the same
weights: Barlow Condensed 400, 500 and 600, Funnel Sans 400, 500 and 600,
Share Tech Mono 400 and Space Grotesk 700. 15 font files, 0.2 MB.

- From: Google Fonts. The stylesheet at the address in `../index.html` was
  fetched with a current Chrome user agent, which gives woff2 files split
  into subsets with `unicode-range`. It had 19 `@font-face` rules naming 15
  files (latin, latin-ext and vietnamese subsets). Every file was downloaded
  from `fonts.gstatic.com`.
- `fonts.css` holds the same 19 rules, in the same order, with the same
  family names, weights, `unicode-range` and `font-display: swap`. Only the
  file addresses differ. They point at the files in this folder.
- Funnel Sans is a variable font, so its three weights share one file per
  subset (`funnel-sans-400-600-*.woff2`).
- Versions, from Google's file addresses: Barlow Condensed v13, Funnel Sans
  v3, Share Tech Mono v16, Space Grotesk v22.
- The four `OFL-*.txt` files are each family's license, from
  `https://github.com/google/fonts` (`ofl/<family>/OFL.txt`).

Space Mono is not here on purpose. `../../css/style.css` names it for the home
page's hero, but the Flight Console page has none of those parts and never
loads it.

## Fetching a copy again

Do the downloads in a scratch folder outside the repo, then copy the files in.

CesiumJS, when `CESIUM_VERSION` in `../js/config.js` changes:

1. `npm pack cesium@<version>.0`, then unpack the `.tgz` file.
2. Empty `cesium/`. Copy everything in `package/Build/Cesium/` into it except
   `index.js` and `index.cjs`. Copy `package/LICENSE.md` in too.
3. Put the new version and the sha256 of `Cesium.js` in `CESIUM_VENDORED` in
   `../test/launch-page.test.mjs`. Compare that hash with the file on
   `cesium.com` first.

Leaflet, when `../index.html` moves to another version:

1. `npm pack leaflet@<version>`, then unpack it.
2. Copy `leaflet.js`, `leaflet.css`, `leaflet.js.map` and `images/` from
   `package/dist/` into `leaflet/`, and `package/LICENSE`.
3. Set `LEAFLET_VERSION` in `../../launch-mode/build-launch-page.mjs`.

Fonts, when `../index.html` asks Google for other families or weights:

1. Fetch the new Google Fonts address with a current Chrome user agent, for
   example with `curl -A`.
2. Download every `.woff2` file the stylesheet lists into `fonts/` and take
   out the ones no longer used.
3. Write the same rules into `fonts.css`, with each address swapped for the
   local file name.
4. Set `FONTS_ADDRESS` in `../../launch-mode/build-launch-page.mjs`.

After any of these, make the launch page again and run the tests from the
repo's root folder:

```
node launch-mode/build-launch-page.mjs
node --test "flight-console/test/*.test.mjs"
```
