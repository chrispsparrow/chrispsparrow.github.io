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
- `fake_receiver.py` and `backup_logger_test.py` test the backup logger
  (`launch-mode/backup_logger.py`). Their own header comments say how to run
  them.

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
