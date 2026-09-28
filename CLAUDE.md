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

## Flight firmware project

The firmware source for the flight computer project lives outside this repo in
`../Clion/` (the `Sillygoose Drivers/AvionicsSillyGooseDrivers/Avionics` PlatformIO
project, plus `Clion.zip`). It must stay out of this repo. Never copy the zip or the
source files here. The only things from it on the site are
`assets/firmware/flight-data.json` (converted from `SimData.h`), the short code
snippets on `projects/flight-firmware.html`, and the JavaScript port of the flight
logic in `js/flight-replay.js`. If the firmware changes, update the port to match it
exactly rather than fixing the logic in JavaScript.

## Writing voice

Follow these rules for all visible text on the site: headings, paragraphs, card
text, captions, labels, list items, buttons and links, alt text, page titles, and
meta descriptions.

- Write like a second-year electrical engineering student describing their own
  work. Plain, friendly, never salesy, and never talking down to the reader.
- Short sentences. Use "I" for my own work and "we" for team work.
- Say what something does and why it matters before how it works. Use standard
  engineering terms (PCB, firmware, I²C, SPI, UART, PWM, ADC, RF, KiCad) without
  adding plain-English definitions in parentheses. Part numbers are fine on project
  pages, but keep them off the home page.
- The Skills list only includes things backed by my resume
  (`assets/Christopher_Sparrow_Resume.pdf`) or my project files. Don't add tools,
  chips, or standards I haven't used.
- No press-release or chatbot language: no "cutting-edge," "robust," "seamless,"
  "leverage," "passionate," or "precision," no taglines, and no "it's not X, it's Y"
  lines.
- No em dashes, semicolons, dramatic colons ("Our goal: ..."), or fragments for
  effect ("Motor stops. Toothpaste dispensed."). No symbols standing in for words.
  Write "and" instead of "&", and skip arrows and slashes like "adult/child" in
  sentences.
- American spelling (modeling, synchronizing, specializing).
- Don't exaggerate. Keep claims as strong as the facts and no stronger.
- If a line sounds like an ad when you read it out loud, rewrite it.
- Don't use stamp-style labels anywhere on the site. That means no revision marks
  (like "REV A") and no dot-joined meta strings (like "SELECTED WORK · 01 / 02").

## Typography

- The site's text font is **Funnel Sans** (Google Fonts, `--font-text`). It is used
  for body text, nav links, labels, buttons, tags, and captions.
- Headings (`h1` to `h6`, the section divider words, and the nav name) use
  **Space Grotesk** (`--font-display`).
- Monospace (`--font-mono`, Space Mono) is only for real code blocks, like the
  MicroPython snippet on the toothpaste page. Don't use it for labels or UI text.
- Don't force labels into all caps with wide letter spacing in CSS.
- **Exception: the home page hero.** Its subline, two buttons, and SCROLL
  label keep their original Space Mono look, with spaced-out caps. Leave them as
  they are.
