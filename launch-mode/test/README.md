# Launch mode tests

These check that the Flight Console's launch page works at a field with no
internet. Nothing here is part of the website. There is nothing to install.
The tests use Node 24 and the Chrome that is already on the laptop.

## What is in this folder

- `cdp.mjs` is the test rig. It starts the local server on a test port, starts
  a headless Chrome, and drives a page in it. It can block the internet, or
  make it connect and never answer. It lists every request the page made. The
  comment at the top of the file shows how to use it.
- `smoke.mjs` is the quick check. It opens the launch page twice, once with
  the internet blocked and once with the internet up but dead. It prints
  whether the page started, its errors, and any request it made to the
  internet.
- `acceptance.mjs` is the whole launch day check list in one run. See
  below.
- `fake_receiver.py` and `backup_logger_test.py` test the backup logger
  (`launch-mode/backup_logger.py`). Their own header comments say how to run
  them.

## The acceptance test, before a launch

From the website folder:

    node launch-mode/test/acceptance.mjs

It runs every check on the launch day list, one PASS or FAIL line each with
the real numbers:

1. With the internet blocked, the launch page starts and the launch panel
   has the field's center as the ground station.
2. Both maps show the saved imagery around the field. The 3D view uses no
   Cesium ion and flat ground. The 2D map loads saved tiles at two zooms.
   From high up, the saved box has imagery and the ground outside it is
   plain.
3. The test capture plays through the live path, and every packet reaches
   the flight store.
4. The flight log is saved: the server copy in `flight-logs/`, a file
   given to the page, and IndexedDB.
5. The recovery panel shows the last fix, its altitude, range and bearing,
   the age counts up, and COPY COORDINATES works.
6. A session is cut off by closing the tab, and by killing Chrome about a
   second after the last packet. When the page opens again, the panel shows
   the last packet's fix and the time it really arrived before RECOVER is
   pressed, and says to press RECOVER. After the kill, the disk file and
   the server copy have every line but the last seconds. RECOVER brings it
   all back. A plain reload shows the SAVED FIX.
7. A saved log replays with LOAD FILE.
8. A connected port that sends nothing gets the NO DATA warning under the
   bar within about 10 seconds, and not in the first 6.
9. A packet 50 km away and a packet at 0, 0, both with a GPS fix, do not
   change the readout, COPY COORDINATES or the saved fix.
10. The cable comes out and goes back in. The page says the port was lost,
    opens it again by itself with nothing clicked, and the lines carry on
    in all three copies, in the same files.
11. The test's own server is stopped while lines keep coming. The SERVER
    STOPPED warning shows, and the disk file and the browser copy keep
    saving. Then the server is started again on the same port, and its
    copy catches up with no line lost or doubled.
12. A flight first heard in the air uses the ground height in
    `launch-mode/field.json`, so ABOVE GROUND is the GPS altitude minus
    that, not minus the normal page's 700 m.
13. With connections that open and never answer, nothing is slower.
14. Every request that tried to reach the internet in all of those runs,
    which part of the page made it, and what happened to it.
15. With the internet open, Esri's photos show outside the saved box.
16. The normal page works as before.

Headless Chrome has no serial ports and can't show a save box. Checks 6 and
8 to 12 press the real CONNECT button on a stand-in port and a stand-in save
box, which the test puts in the page before the page's own code runs. The
page reads the stand-in exactly as it reads a real port. So these checks
cover the page, not the receiver, its cable or Chrome's real save box. Try
those by hand with the board plugged in.

Then it runs the Node unit tests, the four browser checks in
`flight-console/test/`, and the backup logger test. If the receiver board is
plugged in, it runs the backup logger on its COM port for 10 seconds and
prints the first lines it saved.

It ends with exit code 0 only when every check passed, and prints how long
it took. On a quiet laptop the whole run took 16 and a half minutes. The
launch page checks (1 to 16) took about 3 of them. The panel and flight log
browser checks took about 6 each.

    node launch-mode/test/acceptance.mjs --skip unit,browser,logger   the launch page checks only, about 3 minutes
    node launch-mode/test/acceptance.mjs --only maps,panel            just those two
    node launch-mode/test/acceptance.mjs --only silent,badfix,reconnect,server   checks 8 to 11, which share one page
    node launch-mode/test/acceptance.mjs --skip-online                no checks that need the internet
    node launch-mode/test/acceptance.mjs --shots C:/some/folder       where the pictures go

`--only` and `--skip` take these names: start, maps, capture, log, panel,
restore, replay, silent, badfix, reconnect, server, ground, tarpit,
requests, online, normal, unit, browser, logger.

It uses port 8131 (and 8132 to 8135 for the other suites). Check 11 stops
the server the test started on port 8131 and starts it again. It never
stops a server it did not start. The online checks use
`http://localhost:8000` served from 127.0.0.4, so the real server on
127.0.0.1 is never touched. Look at the pictures it saves. A check that
only reads numbers can pass on a broken picture. It deletes the files its
own pages and the other suites' pages wrote in `flight-logs/`, by the names
its servers saw, and leaves everything else there alone.

If the laptop goes to sleep during the run, everything stops until it
wakes, and the checks that were running fail on their time limits. Run it
again with the laptop awake.

## How to run the quick check

From the website folder:

    node launch-mode/test/smoke.mjs

It uses port 8102, so it does not get in the way of the real server on port
8000. It ends with exit code 0 when the page started in both runs.

To save a picture of the page too:

    node launch-mode/test/smoke.mjs --shot C:/some/folder/launch.png

`--networks open` runs it with the real internet, and `--page index.html`
opens the normal page in place of the launch page.

The test Chrome starts with `--no-proxy-server`, the same as the Chrome that
`launch-mode.bat` opens. A plain Chrome window first looks for a proxy, and
on a connection that is up but dead that held every page, even localhost,
for 30 s. `--system-proxy` runs the check that way to show it.

## How to write a test with the rig

    import { startServer, launchChrome } from './cdp.mjs';

    const server = await startServer({ port: 8102 });
    const browser = await launchChrome({ network: 'blocked' });
    try {
      const page = await browser.newPage();
      await page.goto(server.url('/flight-console/launch.html?track'));
      await page.waitFor(() => window.fcStarted === true);
      console.log(page.externalRequests());
    } finally {
      await browser.close();
      await server.stop();
    }

`network` is `'blocked'` (like Wi-Fi off), `'tarpit'` (connects and never
answers) or `'open'` (the real internet).

## A test that needs http://localhost:8000

The map keys only work on a page at `http://localhost:8000`, and a test must
not take that address from the real server. Start the test's server on
another address of this laptop, and tell the test's Chrome that `localhost`
means that address:

    const server = await startServer({ port: 8000, host: '127.0.0.2' });
    const browser = await launchChrome({ network: 'open', args: server.chromeArgs });
    await page.goto(server.url('/flight-console/launch.html?track'));

`server.url()` still gives `http://localhost:8000/...`, which is what the page
sees. From Node, ask that server at `server.direct` (`http://127.0.0.2:8000`).

## The real start, by hand

`launch-mode.bat` in the website folder is what I double-click at the field.
To try it, run it, check that the server window opened and the page loaded,
then close the Chrome window and the server window. Its Chrome profile is in
`%LOCALAPPDATA%\DogtoothLaunchMode`.

## If a test is killed

A test that throws or is stopped with Ctrl+C closes its Chrome and server.
A test that is killed from outside can leave its headless Chrome running.
This ends the ones whose test is gone, and only those:

    node launch-mode/test/cdp.mjs --clean

It never touches a Chrome that the rig did not start.
