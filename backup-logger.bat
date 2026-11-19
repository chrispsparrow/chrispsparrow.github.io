@echo off
rem backup-logger.bat: double-click this to start the backup flight logger
rem (launch-mode\backup_logger.py). It saves every line from the receiver
rem board's serial port to a new file in flight-logs\, with no browser.
rem
rem It is the fallback for when the Flight Console launch page fails. Only
rem one program can use the receiver's port at a time, so press DISCONNECT
rem on the page (or close its tab) before starting this.
rem
rem Options go on to the logger, for example from a terminal:
rem   backup-logger.bat --port COM5
rem   backup-logger.bat --port socket://127.0.0.1:8116 --seconds 5
rem
rem It finds the logger next to itself (%~dp0), never in the current folder,
rem so it works from any folder and from a shortcut. The window stays open
rem at the end so the last messages can be read.
rem
rem Echoed paths stay outside ( ) blocks, because a ")" in a folder name
rem would end the block early.

setlocal
title Dogtooth backup logger
set "LOGGER=%~dp0launch-mode\backup_logger.py"
set "CODE=1"

rem Python: "python" first, then the "py" launcher. The Microsoft Store
rem stand-in that some laptops have for python.exe fails this check.
set "PY="
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto have_python
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto have_python
echo Python is not installed, and the backup logger needs it.
echo Install Python 3 from python.org, then add pyserial with this command:
echo   python -m pip install pyserial
goto done

:have_python
%PY% -c "import serial.tools.list_ports" >nul 2>&1
if not errorlevel 1 goto have_pyserial
echo pyserial is not installed, and the backup logger needs it to read the port.
echo Install it with this command, then start this again:
echo   %PY% -m pip install pyserial
goto done

:have_pyserial
if exist "%LOGGER%" goto run
echo The logger is missing. It should be here:
echo   %LOGGER%
goto done

:run
echo If you stop it with Ctrl+C and Windows asks "Terminate batch job (Y/N)?",
echo type N to keep this window open. The file is saved either way.
echo.
%PY% "%LOGGER%" %*
set "CODE=%ERRORLEVEL%"

:done
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
