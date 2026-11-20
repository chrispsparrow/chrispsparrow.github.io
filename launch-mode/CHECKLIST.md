# Launch day checklist

For the CRMRC launch on Saturday, November 21, 2026. Launch mode runs from
the `launch-mode` branch in `C:\Users\chris\Projects\site-launch-mode`.
This file works with no internet. Open it in any text editor.

## 1. Do this before Saturday (about 5 minutes, at home)

Only a person can do these: Chrome needs a person to pick the serial port,
and the real Wi-Fi-off check means turning Wi-Fi off.

1. Plug the receiver board into the laptop.
2. Double-click `launch-mode.bat`. A server window titled "Dogtooth launch
   mode server" opens, then Chrome opens the launch page on the field.
3. Press CONNECT. Pick a folder for the flight log in the save box and keep
   the suggested name. Then pick the receiver's COM port in Chrome's list.
   If the list doesn't open, press CONNECT again. Chrome remembers the port
   for launch day.
4. Check the FLIGHT LOG rows on the right. DISK FILE, BROWSER and SERVER
   should all show the line count going up. With the flight board off, the
   line under the bar says the receiver is listening and no packets have
   come in yet. That is normal. Then switch on the rocket's flight board
   with its antenna on, by a window so its GPS can get a fix. LAST GOOD FIX
   should fill in with its position, and the 3D view should show the board.
   This is the only test of the receiver's current firmware with a real
   flight board sending (the saved test capture is the older format), so
   don't skip it.
5. Pull the USB cable for a second and plug it back in. Don't click
   anything. RECEIVER LOST shows under the bar, then RECEIVER BACK, and the
   line count carries on in the same files. This is the one check of the
   automatic reconnect with real hardware, so don't skip it.
6. Press DISCONNECT. Double-click `backup-logger.bat` and watch the lines
   arrive in its window. Press Ctrl+C, then type N to keep the window open.
   The file is in `flight-logs\`.
7. Turn Wi-Fi off. Close Chrome and the server window. Double-click
   `launch-mode.bat` again. The page should load, both maps (3D, and
   SATELLITE for the 2D map) should show the field, and CONNECT should
   work. Turn Wi-Fi back on.
8. Open SAVED FLIGHTS, press LOAD FILE and pick the log from step 3. It
   should play back.

## 2. Windows settings to change first

- **USB selective suspend off.** It is on for this laptop right now, and it
  can drop the receiver. In Terminal (Admin):
  ```
  powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
  powercfg /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
  powercfg /setactive SCHEME_CURRENT
  ```
- **Never sleep and keep the screen on.** Settings, System, Power and
  battery, Screen, sleep and hibernate timeouts: set every one to Never,
  on battery and plugged in. Sleep is already Never on this laptop. The
  screen timeouts are not.
- **Closing the lid does nothing.** Control Panel, Power Options, "Choose
  what closing the lid does": Do nothing. Keep the lid open anyway.
- **No screen lock.** Settings, Accounts, Sign-in options: "If you've been
  away, when should Windows require you to sign in again?" set to Never.
  Turn Dynamic lock off. Settings, Personalization, Lock screen, Screen
  saver: None.
- **Power.** Settings, System, Power and battery: Power mode set to Best
  performance, and Energy saver off (never turn on automatically). Bring
  the charger or a power bank.
- **Chrome keeps the tab running.** In the launch mode Chrome window (it
  has its own profile, so do it there): Settings, Performance. Turn Memory
  saver off, or add `localhost:8000` under "Always keep these sites
  active". Turn Energy saver off.
- **No restarts.** Settings, Windows Update: Pause updates for 1 week.

## 3. At the field

1. Double-click `launch-mode.bat`. Keep the server window open all day.
2. Type the ground station position where you stand into GROUND STATION and
   press SET, or leave it on the field center.
3. Press CONNECT, keep the suggested file name, and check that DISK FILE,
   BROWSER and SERVER all count up.
4. After landing, read LAST GOOD FIX and press COPY COORDINATES. The fix
   stays on screen after packets stop, after the cable comes out and after
   a reload. If a NEWER WEAK FIX shows under it (few satellites, the rocket
   lying in grass), it is newer but less sure. COPY WEAK FIX copies that one.
   NEWER FIX, NOT CONFIRMED is a position too far from the last one to trust
   yet. It takes over once three fixes in a row agree. If the map and the
   panel disagree, go by the panel.
5. Use only one launch tab. A second one says OTHER TAB and won't connect.

## If something goes wrong

- **The page crashed or the tab closed.** Double-click `launch-mode.bat`
  again. The panel already shows the last fix. Press RECOVER to put the
  flight back on the live view and into SAVED FLIGHTS. If the save box
  suggests a name ending in -2, keep it. Picking the earlier file would
  empty it.
- **SERVER STOPPED under the bar.** The server window was closed. Don't
  reload or close the page, since the disk file and browser copy are still
  saving. Double-click `launch-mode.bat`, close the extra tab it opens, and
  come back to the first one.
- **NO DATA under the bar.** Nothing is coming from the port, so it is
  probably the wrong one. Press DISCONNECT, then CONNECT, and pick the
  receiver's port.
- **RECEIVER SILENT under the bar.** The receiver has printed nothing for
  12 seconds. Unplug it and plug it back in. The page reconnects by itself.
- **The line under the bar says the radio didn't start.** Unplug the
  receiver and plug it back in. If it says the same again, switch to the
  spare receiver or check its antenna and wiring.
- **The BROWSER count dropped after a reconnect.** That row only counts the
  lines since the reconnect. The earlier ones are in SAVED FLIGHTS, and
  DISK FILE and SERVER still have every line.
- **The page won't work at all.** Use the backup logger. Only one program
  can use the receiver's COM port at a time, so first press DISCONNECT on
  the page or close its tab. (While the page is trying to reconnect,
  DISCONNECT also stops that and frees the port.) Then double-click `backup-logger.bat`. It
  saves every line to `flight-logs\backup-<date and time>.log`. Keep its
  window open. Load that file later with LOAD FILE.
- **Where the data is.** The file you picked on CONNECT, plus the server's
  copy in `flight-logs\` in the launch mode folder, plus the browser's copy
  in SAVED FLIGHTS.
