# CLAUDE.md

Guidance for working in this repository.

## Avionics project assets

For anything related to the **avionics PCB project**, always prioritize files in
`assets/Avionics PCB Files x2/` over the older `assets/AVIONICS PCB FILES/` folder.
When both folders contain a version of the same thing (design document, schematic,
layout exports, etc.), use the one in `Avionics PCB Files x2`.

- The folder and some filenames contain spaces — URL-encode paths in every
  `href`/`src` (spaces as `%20`).
- Do **not** delete or rename anything in the older `AVIONICS PCB FILES` folder.

The homepage avionics card (Selected Work section) now uses an interactive 3D
viewer — Google `model-viewer`, self-hosted at `js/vendor/model-viewer-4.3.1.min.js`
— loading the meshopt-optimized model `assets/Avionics PCB Files x2/avionics-pcb.min.glb`
(optimized from the original `CHRISTOPHER SPARROW-Avionics_GPS_Radio_v2.glb` in the
same folder). The still image is only the viewer's poster/fallback.
