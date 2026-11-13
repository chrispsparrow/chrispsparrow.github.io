# Bench Console

The Bench Console is the page on my site that reads a Dogtooth board over USB and shows what it reports, live. I use it on the bench to check the GPS and radio. It lives at https://www.dogtoothsystems.com/bench-console/.

It uses the Web Serial API, so it only works in Chrome and Edge on a desktop or laptop. Other browsers get a short message and an empty console.

## Using it

1. Close any serial monitor that has the board's port open (Arduino IDE, PlatformIO, PuTTY). Only one program can open a serial port at a time, and if another one has it, the page says the port didn't open.
2. Plug the board in and press **Connect**. The browser lists the serial ports. Pick the board's port.
3. The page opens it at 115,200 baud and starts reading. **Disconnect** closes the port.
4. **Save as CSV** downloads every line received since the page loaded, across every connect and disconnect.

Nothing is uploaded. Everything stays in the tab until it's closed or reloaded.

## The line format

Reading lines look like this. It's the flight firmware's status line, printed once per second:

```
Time: 16.1 s | GPS fix: yes | Satellites: 11 | Position accuracy (HDOP): 0.99 | Latitude: 42.3386255 | Longitude: -71.0896268 | Altitude: 17.3 m | GPS mode: airborne | GPS characters: 7252 | Bad GPS sentences: 1 | Radio sent: 10 | Radio skipped: 0 | Radio errors: 0
```

- Parts are split by `|`. Each part is `Label: value unit`, and the unit is optional.
- Each part is found by its label, never its position. The board can reorder parts or leave some out.
- Labels are matched without caring about case, spaces or `_`. Words in brackets count as part of the label when that makes a known label (`Position accuracy (HDOP)`). Otherwise they're read as the unit, so `Altitude (m)`, `alt` and `ALT` all mean altitude.
- Labels the page doesn't know are skipped. They still show in the raw output and in the CSV's last column.
- A value that isn't a number where one is expected (like `HDOP: ?`) shows as text and is left off the graphs.

Two other kinds of line:

- A line starting with `Error:` goes in the errors box. The same error again, with no other error in between, adds to its count instead of making a new row.
- A line starting with `Heartbeat:` updates the last heartbeat time. The heartbeat counts as late after 5 s, since the firmware sends one every 2 s. The current firmware's `heartbeat 12345` (no colon) counts too.

Every other line, like the startup banner, goes in the raw output and the CSV only.

### Labels the page knows

The list is `FIELDS` in `js/parse.js`. To add a value, add an entry there. It gets a row in the readings panel and a column in the CSV.

| Shown as | Labels the board can send |
|---|---|
| GPS fix | GPS fix, Fix |
| Satellites in use | Satellites, Sats, Sat |
| HDOP | Position accuracy (HDOP), Position accuracy, HDOP |
| Latitude | Latitude, Lat |
| Longitude | Longitude, Lon, Lng, Long |
| Altitude | Altitude, Alt |
| Radio packets sent | Radio sent, Sent, Packets sent |
| Radio errors | Radio errors, Errors |
| Board time | Time, T, Board time, Uptime |
| Radio packets skipped | Radio skipped, Skipped |
| GPS mode | GPS mode, Model, GPS model |
| GPS characters | GPS characters, NMEA chars |
| Bad GPS sentences | Bad GPS sentences, NMEA bad, NMEA errors |

The first eight always have a row. The rest get one once the board sends them.

The labels above match the status line format I specified for `DOGTOOTH_V1_FIRMWARE` on 2026-11-12 (the example line above). The firmware keeps its label strings in one place, listed in its `docs/FIRMWARE_GUIDE.md` under "Serial output format". If a label changes there, add it to `FIELDS` here. Older firmware printed `GPS fix=yes sats=7` style lines, which the page doesn't read, so those only show in the raw output.

## What the panels show

- **Latest readings**: the newest value of each label, with the unit the board sent.
- **Position**: the last 10 minutes of fixes in meters around their middle, north up, with a scale bar. The open ring is the oldest fix in view and the gold dot is the newest. A fix only counts if latitude and longitude are both numbers on the globe, they aren't both 0, and the same line doesn't say there's no fix.
- **Graphs**: altitude, satellites, HDOP, and radio packets sent and errors, over the last 10 minutes (or since the first line, if that's shorter). Lines break at each connect and disconnect and across gaps over 6 s. Altitude is left off the graph when the same line says there's no fix. After a disconnect, the graphs stop moving so the data stays in view.
- Pointing at any graph (or tabbing to one and using the arrow keys) picks a time, and every graph and the position trace show that moment.

## The CSV file

One row per line received, in order:

- `PC time (UTC)`: when the computer got the line, as ISO 8601.
- `Seconds since first line`
- `Line type`: `data`, `error`, `heartbeat` or `other`.
- One column per known value, holding the value exactly as the board printed it. The header's unit is the first unit the board sent for it.
- `Line as received`

## Files

- `index.html`: the page, with the site's nav and footer copied from the home page.
- `bench-console.css`: styles for this page only, all scoped under `.bc-page`. The colors are the Flight Console's.
- `js/parse.js`: the line format and the list of known labels. No page code, so Node can run it.
- `js/csv.js`: builds the CSV file. Also runs in Node.
- `js/charts.js`: draws the graphs and the position trace on canvas.
- `js/main.js`: the serial connection, the session data and the panels.

When `bench-console.css` or `js/main.js` changes, bump its `?v=` number in `index.html` so returning visitors don't get the old copy.
