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

Reading lines look like this:

```
GPS fix: yes | Satellites: 9 | HDOP: 0.92 | Latitude: 42.3398712 | Longitude: -71.0891234 | Altitude: 31.4 m | Radio sent: 128 | Radio errors: 0
```

- Parts are split by `|`. Each part is `Label: value unit`, and the unit is optional.
- Each part is found by its label, never its position. The board can reorder parts or leave some out.
- Labels are matched without caring about case, spaces, `_` or a unit in brackets, so `Altitude (m)`, `alt` and `ALT` all mean altitude.
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
| HDOP | HDOP |
| Latitude | Latitude, Lat |
| Longitude | Longitude, Lon, Lng, Long |
| Altitude | Altitude, Alt |
| Radio packets sent | Radio sent, Sent, Packets sent |
| Radio errors | Radio errors, Errors |
| Board time | Time, T, Board time, Uptime |
| Radio status | Radio, Radio status |
| Radio packets skipped | Radio skipped, Skipped |
| GPS dynamic model | Model, GPS model |
| NMEA characters read | NMEA chars |
| NMEA checksum failures | NMEA bad, NMEA errors |

The first eight always have a row. The rest get one once the board sends them.

When I checked on 2026-11-12, the status line in my `DOGTOOTH_V1_FIRMWARE` code still printed the older `GPS fix=yes sats=7` style. The page doesn't read that style, so those lines only show in the raw output until the firmware prints `Label: value` parts.

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
