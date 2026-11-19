@echo off
rem launch-mode.bat: double-click this at the launch field. It starts the
rem launch mode server (launch-mode\server.mjs) in its own window, waits
rem until it answers, then opens the Flight Console's launch page at
rem http://localhost:8000/flight-console/launch.html?track in Chrome.
rem Run it again while the server is up and it just opens the page again.
rem
rem Chrome gets a profile folder of its own for launch mode, in
rem %LOCALAPPDATA%\DogtoothLaunchMode\chrome-profile. That way the switches
rem below apply even when my normal Chrome is open, no extension can get in
rem the way, and the page's crash-recovery copy and the serial port
rem permission always live in the same place. It is a normal window, so the
rem save box and the serial port chooser work as usual.
rem   --no-proxy-server  skips Chrome's automatic proxy look-up. On a
rem       connection that was up but dead, that look-up held every page,
rem       even localhost, for 30 s before anything loaded.
rem   --disable-background-timer-throttling, --disable-renderer-backgrounding,
rem   --disable-backgrounding-occluded-windows and
rem   --disable-features=IntensiveWakeUpThrottling keep the page running at
rem       full speed when it is behind another window or tab.
rem Without Chrome it tries Edge the same way. Without either it opens the
rem default browser, but the serial port needs Chrome or Edge.
rem
rem It finds the server next to itself (%~dp0), never in the current folder,
rem so it works from any folder and from a desktop shortcut. The server
rem window runs this same file with :server as its argument.
rem
rem Echoed paths stay outside ( ) blocks, because a ")" in a folder name
rem would end the block early.

setlocal
set "SELF=%~f0"
set "SERVER=%~dp0launch-mode\server.mjs"
set "PORT=8000"
set "PAGE=http://localhost:%PORT%/flight-console/launch.html?track"
set "PROFILES=%LOCALAPPDATA%\DogtoothLaunchMode"
set "SERVER_TITLE=Dogtooth launch mode server"

rem Node: "node" on the PATH first, then the usual install folder.
set "NODE="
where node >nul 2>&1
if not errorlevel 1 set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramW6432%\nodejs\node.exe" set "NODE=%ProgramW6432%\nodejs\node.exe"

if "%~1"==":server" goto server_window

title Dogtooth launch mode
if defined NODE goto have_node
echo Node is not installed, and launch mode needs it to run its server.
echo Install the LTS version from https://nodejs.org, then start this again.
goto failed

:have_node
"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 goto node_ok
echo This version of Node is too old for launch mode. It needs Node 18 or newer.
echo Install the LTS version from https://nodejs.org, then start this again.
goto failed

:node_ok
if exist "%SERVER%" goto check_server
echo The launch mode server is missing. It should be here:
echo   %SERVER%
goto failed

:check_server
rem --check answers 0 when launch mode is already running on the port,
rem 1 when nothing is, and 2 when something else has the port.
"%NODE%" "%SERVER%" --port %PORT% --check >nul 2>&1
set "STATE=%ERRORLEVEL%"
if "%STATE%"=="0" goto find_browser
if "%STATE%"=="1" goto start_server
rem Ask again with the messages showing, so the reason is on screen.
"%NODE%" "%SERVER%" --port %PORT% --check
goto failed

:start_server
echo Starting the launch mode server in its own window.
start "%SERVER_TITLE%" cmd /c ""%SELF%" :server"
"%NODE%" "%SERVER%" --port %PORT% --check --wait 20 >nul 2>&1
if not errorlevel 1 goto find_browser
echo The server did not start. Its window says why.
goto failed

:find_browser
set "BROWSER="
set "KIND="
call :look "%ProgramFiles%\Google\Chrome\Application\chrome.exe" chrome
call :look "%ProgramW6432%\Google\Chrome\Application\chrome.exe" chrome
call :look "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" chrome
call :look "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" chrome
call :look "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" edge
call :look "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" edge
call :look "%ProgramW6432%\Microsoft\Edge\Application\msedge.exe" edge
call :look "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" edge
if not defined BROWSER goto default_browser

if "%KIND%"=="chrome" echo Opening the launch page in Chrome.
if "%KIND%"=="edge" echo Chrome was not found, so the launch page opens in Edge.
start "" "%BROWSER%" --user-data-dir="%PROFILES%\%KIND%-profile" --no-first-run --no-default-browser-check --no-proxy-server --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=IntensiveWakeUpThrottling "%PAGE%"
goto started

:default_browser
echo Chrome and Edge were not found, so the page opens in the default browser.
echo The serial port only works in Chrome or Edge. Install Chrome before the launch.
start "" "%PAGE%"

:started
echo.
echo Launch mode is running at %PAGE%
echo Keep the "%SERVER_TITLE%" window open during the flight.
echo This window closes by itself in a few seconds.
timeout /t 6 /nobreak >nul 2>&1
exit /b 0

:failed
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

rem ------------------------------------------------------------------
rem The server window. launch-mode.bat starts it with :server.
rem ------------------------------------------------------------------

:server_window
title %SERVER_TITLE%
if defined NODE goto server_run
echo Node is not installed, and launch mode needs it to run its server.
goto server_end

:server_run
echo If you stop the server with Ctrl+C and Windows asks "Terminate batch job (Y/N)?",
echo type N to keep this window open and read the last messages.
echo.
"%NODE%" "%SERVER%" --port %PORT%

:server_end
echo.
echo The launch mode server has stopped. The launch page cannot save to flight-logs until it runs again.
echo Press any key to close this window.
pause >nul
exit /b 0

rem call :look "<path to a browser>" <kind> keeps the first one that exists.
:look
if defined BROWSER exit /b 0
if not exist "%~1" exit /b 0
set "BROWSER=%~1"
set "KIND=%~2"
exit /b 0
