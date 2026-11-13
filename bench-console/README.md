# Bench Console

The Bench Console is the page on my site that reads a Dogtooth board over USB and shows what it reports, live. I use it on the bench to check the GPS and radio. It lives at https://www.dogtoothsystems.com/bench-console/.

It uses the Web Serial API, so it only works in Chrome and Edge on a desktop or laptop. Other browsers get a short message and an empty console.

## Using it

1. Close any serial monitor that has the board's port open (Arduino IDE, PlatformIO, PuTTY). Only one program can open a serial port at a time, and if another one has it, the page says the port didn't open.
2. Plug the board in and press **Connect**. The browser lists the serial ports. Pick the board's port.
3. The page opens it at 115,200 baud and starts reading. **Disconnect** closes the port.
4. **Save as CSV** downloads every block received since the page loaded, across every connect and disconnect.

Nothing is uploaded. Everything stays in the tab until it's closed or reloaded.

## The status block

The board prints one block like this every second:

```
==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================

GPS
  TARGET LOCK [GPS]: ------------------ LOCKED
  CONNECTED SATELLITES: --------------- 11
  LOCK QUALITY: ----------------------- 100 % (HDOP 0.99)
  LATITUDE: --------------------------- 42.3386255
  LONGITUDE: -------------------------- -71.0896268
  ALTITUDE: --------------------------- 17.3 m
  GPS DATA RATE: ---------------------- GOOD 723 char/s
  CORRUPTED DATA OCCURRENCES (GPS): --- 1

GPS MOTION MODEL
  PORTABLE: --------------------------- OFF
  AUTOMOTIVE: ------------------------- OFF
  AIRBORNE 4G: ------------------------ ON
  OTHER: ------------------------------ OFF

RADIO
  RADIO PACKETS SENT: ----------------- 65
  RADIO PACKETS SKIPPED: -------------- 0
  RADIO PACKET ERROR OCCURRENCES: ----- 0
```

How the page reads it:

- **Banner.** A line starting with `====` begins a new block. The page reads `HEARTBEAT #` and `TIME RUNNING` from it. The time can be `5.3 s`, `1 min 5.3 s` or `1 h 2 min 5 s`, and the page turns it into seconds.
- **Sections.** A line with no colon is a section name. The readings panel groups by section.
- **Fields.** Every other line is a label, a row of dashes and a value. The label is everything before the first colon. The page strips the dashes and spaces to get the value, but keeps a minus sign, so `---- -71.0896268` reads as -71.0896268. Fields are found by their label, never their position, so the board can reorder them or leave some out. Labels the page doesn't know are skipped, and they still show in the raw output.
- **Values.** `LOCKED` or `SEARCHING`. `100 % (HDOP 0.99)` gives the lock quality percent and the HDOP. `GOOD 723 char/s` gives a status word (`GOOD`, `LOW` or `SILENT`) and a rate. `ON` or `OFF` for each motion model. Everything else is a number with an optional unit. A value that isn't a number where one is expected (like `--`) shows as text and stays off the graphs.
- **End of a block.** A block is finished at the next banner, or at the blank line after the RADIO section. If the port closes partway through a block, the page keeps what it got.
- **Lost blocks.** If the heartbeat number skips ahead (64, then 66), the missing numbers are added to Lost blocks. The jump across a disconnect doesn't count, because nobody was listening. Neither does a board restart.
- **Restarts.** If `TIME RUNNING` or the heartbeat number goes back, the board restarted. The graphs and the position trace start over, since their times would overlap. The CSV keeps every block.
- **Errors.** A line starting with `Error:` can come at any time, even inside a block. It goes in the errors box. The same error again, with no other error in between, adds to its count instead of making a new row. It's also kept with the newest block for the CSV's `ERRORS` column.

Lines outside a block, like the startup banner, go in the raw output only.

### Names the page knows

Every name the page matches is in one place at the top of `js/parse.js`: `BANNER` for the banner, `ERROR_LABEL`, and `FIELDS` for the sections and labels. They're copied exactly from the board's output, capitals and brackets included, and a label must match exactly to count. If the firmware renames something, change it there. A new entry in `FIELDS` gets a row in the readings panel and a column in the CSV.

| Section | Label | Read as |
|---|---|---|
| GPS | TARGET LOCK [GPS] | LOCKED (teal) or SEARCHING (coral) |
| GPS | CONNECTED SATELLITES | number |
| GPS | LOCK QUALITY | percent and HDOP |
| GPS | LATITUDE | number |
| GPS | LONGITUDE | number |
| GPS | ALTITUDE | number and unit |
| GPS | GPS DATA RATE | GOOD (teal), LOW (gold) or SILENT (coral), then a rate |
| GPS | CORRUPTED DATA OCCURRENCES (GPS) | number |
| GPS MOTION MODEL | PORTABLE, AUTOMOTIVE, AIRBORNE 4G, OTHER | ON or OFF |
| RADIO | RADIO PACKETS SENT | number |
| RADIO | RADIO PACKETS SKIPPED | number |
| RADIO | RADIO PACKET ERROR OCCURRENCES | number |

This block format dates from 2026-11-13. Before that, the flight firmware in `DOGTOOTH_V1_FIRMWARE` printed a one-line `Label: value | ...` status line, which this page no longer reads.

## What the panels show

- **Connection bar**: the link, the last heartbeat and its number, Lost blocks, and Blocks received. The last heartbeat time comes from the banner and turns red after 3 s with no new block.
- **Latest readings**: the newest value of each field, under the board's own section names and labels. Status words are colored and always written out. GPS MOTION MODEL shows only the model that's ON, or all four if none is.
- **Position**: the last 10 minutes of positions in meters around their middle, north up, with a scale bar. The open ring is the oldest point in view and the gold dot is the newest. A position only counts if latitude and longitude are both numbers on the globe, they aren't both 0, and the same block doesn't say SEARCHING.
- **Graphs**: altitude, connected satellites, lock quality, GPS data rate, and radio packets sent and errors, over the last 10 minutes (or since the board started, if that's shorter). The time along the bottom is the board's `TIME RUNNING`, so data that arrives in a burst still lands at the right time. Lines break at each connect and disconnect and across gaps over 6 s. Altitude is left off while the block says SEARCHING. After a disconnect, the graphs stop moving so the data stays in view.
- Pointing at any graph (or tabbing to one and using the arrow keys) picks a time, and every graph and the position trace show that moment.

## The CSV file

One row per block, in the order they arrived:

- `PC time (UTC)`: when the computer got the block's banner, as ISO 8601.
- `HEARTBEAT #` and `TIME RUNNING (s)`, from the banner.
- One column per field, in the order of `FIELDS`, holding the value as the board printed it. `LOCK QUALITY` splits into `LOCK QUALITY (%)` and `HDOP`. `GPS DATA RATE` splits into `GPS DATA RATE STATUS` and `GPS DATA RATE (char/s)`. The motion model columns start with `GPS MOTION MODEL`, so `AIRBORNE 4G` makes sense on its own. A header's unit is the first unit the board sent for it.
- `ERRORS`: every `Error:` message from the block's banner until the next banner, split by ` | ` when there's more than one. An error before the first banner of a connection belongs to no block, so it's only in the errors box.

Lines outside a block, like the startup banner, aren't in the CSV.

## Checking the parser

`test/parse.test.mjs` feeds the example block and a set of edge cases through the parser and the CSV builder: a SEARCHING block, LOW and SILENT rates, `Error:` lines inside and between blocks, times past a minute and past an hour, skipped heartbeat numbers, a reconnect, a restart, unknown labels and lines before the first banner. From the repo's root folder, with Node 22 or newer:

```
node --test bench-console/test/parse.test.mjs
```

## Files

- `index.html`: the page, with the site's nav and footer copied from the home page.
- `bench-console.css`: styles for this page only, all scoped under `.bc-page`. The colors are the Flight Console's.
- `js/parse.js`: the block format and every name the page matches. No page code, so Node can run it.
- `js/csv.js`: builds the CSV file. Also runs in Node.
- `js/charts.js`: draws the graphs and the position trace on canvas.
- `js/main.js`: the serial connection, the session data and the panels.
- `test/parse.test.mjs`: the parser checks above.

When a file changes, bump its `?v=` number everywhere it's loaded, so returning visitors don't get the old copy. `bench-console.css` and `js/main.js` are loaded from `index.html`. The other three are imported by `js/main.js`, and `js/parse.js` is also imported by `js/csv.js`.
