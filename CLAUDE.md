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

**Exception (for now):** do NOT change the avionics project's cover image or board
photos yet (currently sourced from `assets/AVIONICS PCB FILES/`). Those are being
replaced separately later.
