"""backup_logger.py: the backup flight logger. It reads the receiver board's
serial port and saves every line to a text file. No browser is involved.

Why it exists: at the launch, the Flight Console's launch page reads the
receiver and keeps the flight log. If the page or Chrome fails, this is the
fallback. Only one program can hold a serial port at a time, so this runs
when the page is not connected (press DISCONNECT there, or close its tab).

Usage:
  python launch-mode/backup_logger.py               finds the receiver by itself
  python launch-mode/backup_logger.py --port COM5   uses that port
  python launch-mode/backup_logger.py --list        lists the serial ports and stops
  python launch-mode/backup_logger.py --port socket://127.0.0.1:8116
                                                    a pyserial URL, which is how the
                                                    tests feed it with no board
  --baud 115200     the speed (the receiver uses 115200, 8 data bits, no parity, 1 stop bit).
                    1200 is refused, because it restarts the board in its bootloader.
  --out FILE        the file to add to, in place of a new one in flight-logs/
  --seconds N       stops by itself after N seconds (the tests use this)

The file is flight-logs/backup-YYYY-MM-DD-HHMMSS.log in the website folder,
a new one for each run. It is the same format the launch page writes, so
the console can load it back:
  # Dogtooth flight log
  # started 2026-11-21T14:03:22.123-05:00
  # written by the backup logger on COM5 at 115200 baud
  # each line: the time it arrived on this computer, then ' > ', then the receiver's line
  2026-11-21T14:03:23.004-05:00 > PKT node=1 seq=806 ...
  # connection closed 2026-11-21T14:09:10.512-05:00
  # connected 2026-11-21T14:09:16.730-05:00
The receiver's line is kept exactly as it came. Only its line ending is
taken off. "# connected" is written when a connection starts again, so the
first one has no such line. "# connection closed" is written every time one
ends, also when the logger is stopped with Ctrl+C.

How it keeps every line:
  - A line is written to the disk (flush and fsync) before the port is read
    again, so a crash or a dead battery loses nothing that was received.
  - The window is printed to from a second thread. A stuck window (a click
    in an old-style console pauses its output) can't stop the saving.
  - Bytes that are not valid UTF-8 are saved as the replacement mark.
  - A line with no ending is written after it has sat for two seconds, and
    straight away when the port drops.
  - A stop (Ctrl+C, --seconds, a closed window) first takes what has
    already reached the computer, so the last line is not cut in two.
  - If the cable comes out it keeps the same file and tries again every two
    seconds.

It needs pyserial (python -m pip install pyserial).

Used by: backup-logger.bat (the double-click start),
launch-mode/test/backup_logger_test.py (the tests), and me from a terminal.
"""

import argparse
import datetime
import os
import queue
import signal
import sys
import threading
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None

BAUD = 115200             # the same speed the page uses (js/live/serial-link.js)
RESET_BAUD = 1200         # the speed that restarts a SAMD21 board in its bootloader, never used
RETRY_S = 2.0             # how often a missing or busy port is tried again
READ_WAIT_S = 0.2         # the longest one read waits, so Ctrl+C is answered quickly
PARTIAL_WAIT_S = 2.0      # a line with no ending is written after sitting this long
STOP_TAKE_S = 0.5         # at a stop, how long it keeps taking bytes that already arrived
STATUS_EVERY_S = 10.0     # how often the window says how much is saved
QUIET_AFTER_S = 12.0      # silence this long is worth a mention (the receiver prints at least every 5 s)
GONE_CHECK_S = 2.0        # how often a silent port is looked up in the port list
MAX_LINE = 4096           # a "line" longer than this is cut, like the page does, so noise can't grow forever
RX_BUFFER = 65536         # asked of the Windows driver, in case the disk is slow for a moment
CLOSE_WAIT_S = 4.0        # Windows gives a closing window about 5 seconds
CONSOLE_QUEUE = 2000      # lines waiting to be printed before new ones are skipped

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOGS_DIR = os.path.join(ROOT, 'flight-logs')

HEADER_FORMAT = "# each line: the time it arrived on this computer, then ' > ', then the receiver's line"


# ------------------------------------------------------------------
# Time and small text helpers
# ------------------------------------------------------------------

def stamp(when=None):
    """Local time with milliseconds and the UTC offset: 2026-11-21T14:03:22.123-05:00."""
    if when is None:
        when = datetime.datetime.now().astimezone()
    return when.isoformat(timespec='milliseconds')


def default_log_path():
    """A new file name from the clock. Two runs in the same second wait for the next one."""
    while True:
        name = datetime.datetime.now().strftime('backup-%Y-%m-%d-%H%M%S.log')
        path = os.path.join(LOGS_DIR, name)
        if not os.path.exists(path):
            return path
        time.sleep(0.2)


def is_packet(line):
    """A line that is one packet from the rocket: the receiver's older
    firmware prints "PKT node=1 ...", its newer one starts a status block
    with "==== HEARTBEAT #12 | TIME RUNNING: ... ====" for each packet."""
    return line.startswith('PKT ') or (line.startswith('=') and ' HEARTBEAT #' in line)


def count(n, word):
    """'1 line', '2 lines'."""
    return f'{n:,} {word}' if n == 1 else f'{n:,} {word}s'


def reason(err):
    """One line of an error, for the window."""
    return ' '.join(str(err).split()) or type(err).__name__


# Control characters would move the cursor or ring the bell in the window.
# The file keeps them. Only the copy on screen swaps them out.
_SCREEN = {code: '�' for code in list(range(32)) + [127] if code != 9}


def shown(line):
    return line.translate(_SCREEN)


def is_url(port):
    """True for a pyserial URL such as socket://127.0.0.1:8116."""
    return '://' in port


def port_key(name):
    """A port's name in one spelling, so 'com5' and '\\\\.\\COM5' match 'COM5'."""
    return name.upper().replace('\\\\.\\', '')


# ------------------------------------------------------------------
# The window
# ------------------------------------------------------------------

class Console:
    """Prints to the window from its own thread.

    Printing can block. A click in an old-style Windows console pauses its
    output until a key is pressed, and a print from the reading loop would
    then stop the reading. So the loop only hands text over, and when the
    window is stuck the newest text is skipped and counted.
    """

    def __init__(self, stream=None, size=CONSOLE_QUEUE):
        self._stream = stream if stream is not None else sys.stdout
        self._queue = queue.Queue(maxsize=size)
        self.skipped = 0
        self._thread = threading.Thread(target=self._run, name='console', daemon=True)
        self._thread.start()

    def say(self, text=''):
        try:
            self._queue.put_nowait(text)
        except queue.Full:
            self.skipped += 1

    def _run(self):
        while True:
            text = self._queue.get()
            try:
                self._stream.write(text + '\n')
                self._stream.flush()
            except Exception:
                pass    # a closed or broken window must never stop the logging
            finally:
                self._queue.task_done()

    def drain(self, timeout=2.0):
        """Waits until everything said so far is on screen. False when the window is stuck."""
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.01)
        return True


# ------------------------------------------------------------------
# Lines out of bytes
# ------------------------------------------------------------------

class LineSplitter:
    """Turns the bytes from the port into finished lines.

    The port hands over pieces of any size, cut anywhere. A line is done at
    its line feed. The line ending (LF, or CR LF) is taken off and nothing
    else is touched, the same as the page's serial-link.js.
    """

    def __init__(self):
        self._rest = bytearray()
        # When the first byte of the unfinished line came (time.monotonic).
        # Timed from the first byte, not the newest, so bytes that trickle in
        # with no line ending still reach the disk within the wait.
        self.since = None
        self._ending_owed = False

    def feed(self, data, now=None):
        """Adds bytes and returns the lines they finished."""
        now = time.monotonic() if now is None else now
        fresh = not self._rest      # the bytes held after this call began in this call
        self._rest += data
        lines = []
        start = 0
        while True:
            end = self._rest.find(b'\n', start)
            if end < 0:
                break
            line = self._text(self._rest[start:end])
            start = end + 1
            # A line that was written before its ending came (take_rest) is
            # still owed that ending. When it comes it is not a new, empty line.
            owed, self._ending_owed = self._ending_owed, False
            if owed and line == '':
                continue
            lines.append(line)
        del self._rest[:start]
        while len(self._rest) > MAX_LINE:
            cut = MAX_LINE
            # Don't cut a UTF-8 character in half.
            while cut > MAX_LINE - 3 and (self._rest[cut] & 0xC0) == 0x80:
                cut -= 1
            lines.append(self._text(self._rest[:cut]))
            del self._rest[:cut]
            fresh = True
        if not self._rest:
            self.since = None
        elif fresh or start > 0:
            self.since = now
        return lines

    @property
    def waiting(self):
        """True when part of a line is held, waiting for its ending."""
        return len(self._rest) > 0

    def take_rest(self, more_coming=False):
        """The unfinished line as it stands, or None. Used when it has sat too
        long (more_coming, because the same connection may still send its
        ending) or when the connection ended."""
        if not self._rest:
            self._ending_owed = self._ending_owed and more_coming
            return None
        line = self._text(self._rest)
        self._rest.clear()
        self.since = None
        self._ending_owed = more_coming
        return line

    def overdue(self, now, wait):
        """True when an unfinished line has been held for at least wait seconds."""
        return self.since is not None and now - self.since >= wait

    @staticmethod
    def _text(raw):
        if raw.endswith(b'\r'):
            raw = raw[:-1]
        return bytes(raw).decode('utf-8', errors='replace')


# ------------------------------------------------------------------
# The file
# ------------------------------------------------------------------

class LogFile:
    """The log on disk. add() returns only after the text is on the disk.

    The file is opened for appending and is never cut or overwritten, so an
    --out file that already holds a flight keeps it. If a write fails (a
    full disk, a locked file) the text is held in memory and save() tries
    again, picking up after the last byte the disk took.
    """

    def __init__(self, path, opener=open):
        self.path = os.path.abspath(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._held = bytearray()
        self._synced = True
        self.error = None
        # An older file cut off in the middle of a line gets its line feed first.
        try:
            with open(self.path, 'rb') as old:
                old.seek(0, os.SEEK_END)
                if old.tell() > 0:
                    old.seek(-1, os.SEEK_END)
                    if old.read(1) != b'\n':
                        self._held += b'\n'
        except FileNotFoundError:
            pass
        self._file = opener(self.path, 'ab', buffering=0)

    @property
    def held(self):
        """How many bytes are waiting for the disk. 0 when everything is saved."""
        return len(self._held)

    def add(self, text):
        self._held += text.encode('utf-8', errors='replace')
        return self.save()

    def save(self):
        """Writes what is held and makes the disk keep it. True when nothing is left waiting."""
        if not self._held and self._synced:
            return True
        try:
            while self._held:
                wrote = self._file.write(self._held)
                self._synced = False
                del self._held[:wrote]
            self._file.flush()
            os.fsync(self._file.fileno())
            self._synced = True
            self.error = None
            return True
        except OSError as err:
            self.error = err
            return False

    def close(self):
        self.save()
        try:
            self._file.close()
        except OSError:
            pass

    def size(self):
        try:
            return os.path.getsize(self.path)
        except OSError:
            return -1


# ------------------------------------------------------------------
# The port
# ------------------------------------------------------------------

def open_port(port, baud):
    """Opens the port the way the page does.

    The page (js/live/serial-link.js) opens at 115200 with Web Serial's
    defaults (8 data bits, no parity, 1 stop bit, no flow control) and then
    turns DTR on, because the board's USB serial only sends while DTR is on.
    pyserial's defaults are the same, and it opens with DTR and RTS on. So
    this does not pulse either line or use any reset trick the page doesn't.
    """
    ser = serial.serial_for_url(
        port,
        do_not_open=True,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        xonxoff=False,
        rtscts=False,
        dsrdtr=False,
        timeout=READ_WAIT_S,
    )
    if port.lower().startswith('socket://'):
        # pyserial's socket port ends its open() by throwing away whatever
        # has arrived, and goes on throwing away for as long as bytes keep
        # coming. A sender that talks from the moment the connection is made
        # (the fake receiver in the tests) lost its first lines there, and
        # sometimes all of them. So that step is switched off for the open.
        # A COM port is different: Windows clears its buffer once inside
        # open(), before anything of this run can be in it.
        ser.reset_input_buffer = lambda: None
        try:
            ser.open()
        finally:
            del ser.reset_input_buffer
    else:
        ser.open()
    try:
        ser.dtr = True
    except (serial.SerialException, OSError, ValueError):
        pass    # not every port has the line
    # More room in the driver for the moments the disk is slow. Windows only.
    if hasattr(ser, 'set_buffer_size'):
        try:
            ser.set_buffer_size(rx_size=RX_BUFFER)
        except Exception:
            pass
    return ser


def list_serial_ports():
    """Every serial port on this computer, in name order."""
    try:
        return sorted(list_ports.comports())
    except Exception:
        return []


def describe_port(info):
    """One line for the list: the name, what Windows calls it, and its USB ids."""
    if info.vid is None:
        ids = 'not USB'
    else:
        ids = f'USB {info.vid:04X}:{(info.pid or 0):04X}'
        if info.serial_number:
            ids += f', serial {info.serial_number}'
    return f'{info.device}  {info.description}  ({ids})'


def why_not_open(err):
    """Sorts an open error: 'busy' (another program has it), 'missing', or 'other'."""
    text = str(err)
    low = text.lower()
    if 'PermissionError' in text or 'access is denied' in low or 'resource busy' in low:
        return 'busy'
    if 'FileNotFoundError' in text or 'cannot find the file' in low or 'no such file' in low:
        return 'missing'
    return 'other'


def ask_number(how_many, stopper=None):
    """Asks which port. Returns 1 to how_many, 0 to look again, or None when nobody can answer."""
    while True:
        try:
            if stopper is not None:
                stopper.asking = True
            answer = input(f'Which one is the receiver? Type its number (1 to {how_many}) and press Enter: ')
        except (EOFError, KeyboardInterrupt):
            return None
        finally:
            if stopper is not None:
                stopper.asking = False
        answer = answer.strip()
        if not answer:
            return 0
        if answer.isdigit() and 1 <= int(answer) <= how_many:
            return int(answer)
        print(f'That is not a number from 1 to {how_many}.', flush=True)


# ------------------------------------------------------------------
# Stopping
# ------------------------------------------------------------------

class Stopper:
    """Turns Ctrl+C, Ctrl+Break and a closed window into one flag the loops watch.

    The loops check the flag between reads and finish the file themselves,
    so a stop never lands in the middle of a write.
    """

    def __init__(self):
        self.stop = threading.Event()
        self.finished = threading.Event()    # set once the file is closed
        self.asking = False                  # True while input() waits for the port number
        self._keep = None

    def install(self):
        signal.signal(signal.SIGINT, self._on_signal)
        for name in ('SIGBREAK', 'SIGTERM'):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), self._on_signal)
        self._keep = _watch_window_close(self.stop, self.finished)

    def _on_signal(self, signum, frame):
        self.stop.set()
        # input() carries on after a quiet handler, so this breaks it off.
        if self.asking:
            raise KeyboardInterrupt


def _watch_window_close(stop, finished):
    """Windows only. When the window's X is clicked (or the user logs off),
    Windows calls this on a thread of its own and ends the program as soon as
    it returns. So it asks the loop to stop and waits for the file to close.
    Returns the handler, which the caller must keep or Python would free it.
    """
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

        def on_event(kind):
            if kind in (2, 5, 6):       # the window closed, log off, shut down
                stop.set()
                finished.wait(CLOSE_WAIT_S)
                return True
            return False                # Ctrl+C and Ctrl+Break go on to Python's own handler

        handler = handler_type(on_event)
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.SetConsoleCtrlHandler.argtypes = (handler_type, wintypes.BOOL)
        kernel32.SetConsoleCtrlHandler.restype = wintypes.BOOL
        kernel32.SetConsoleCtrlHandler(handler, True)
        return handler
    except Exception:
        return None     # no console to watch. Every line is on disk as it arrives anyway.


# ------------------------------------------------------------------
# The logger
# ------------------------------------------------------------------

class BackupLogger:
    """One run: choose the port, then read and save until told to stop.

    The pieces it needs from outside (the window, the port opener, the port
    list, the question) are handed in, so the tests can run it against a
    scripted port with no hardware.
    """

    def __init__(self, port=None, baud=BAUD, out=None, seconds=None, console=None,
                 stop=None, finished=None, opener=None, lister=None, ask=None,
                 retry_s=RETRY_S, partial_wait_s=PARTIAL_WAIT_S, status_every_s=STATUS_EVERY_S,
                 file_opener=open):
        self._port = port
        self._auto = port is None       # the logger chose the port, so it may follow it to a new name
        self._baud = baud
        self._out = out
        self._seconds = seconds
        self._console = console if console is not None else Console()
        self._stop = stop if stop is not None else threading.Event()
        self._finished = finished if finished is not None else threading.Event()
        self._open_port = opener if opener is not None else open_port
        self._list_ports = lister if lister is not None else list_serial_ports
        self._ask = ask if ask is not None else ask_number
        self._retry_s = retry_s
        self._partial_wait_s = partial_wait_s
        self._status_every_s = status_every_s
        self._file_opener = file_opener

        self._splitter = LineSplitter()
        self._log = None
        self._code = 0
        self._connected = False
        self._disk_bad = False
        self._last_data = None
        self._last_status = None
        self._watch_list = False        # the open port shows in the port list, so it can be seen to go away
        self._last_gone_check = 0.0
        self._t0 = None
        self.lines = 0          # lines taken from the port so far
        self.packets = 0        # how many of them were "PKT " lines
        self.path = None

    # -- the run ------------------------------------------------------

    def run(self):
        """Runs until stopped. Returns the exit code: 0 for a clean stop, 2 when it could not start."""
        say = self._console.say
        self._t0 = self._last_status = time.monotonic()
        started = stamp()
        path = self._out if self._out else default_log_path()
        try:
            self._log = LogFile(path, opener=self._file_opener)
        except OSError as err:
            say(f'The log file could not be made ({reason(err)}).')
            say(f'  {os.path.abspath(path)}')
            self._finished.set()
            return 2
        self.path = self._log.path
        kept = True
        try:
            self._work(started)
        finally:
            # The file first. Windows may end the program right after this.
            kept = self._end_file()
            self._finished.set()
        self._goodbye(kept)
        return self._code

    def _work(self, started):
        say = self._console.say
        say('Dogtooth backup logger')
        say('Every line from the receiver is saved to this file as it arrives:')
        say(f'  {self.path}')
        say('Keep this window open. Press Ctrl+C to stop.')
        say('Only one program can use the receiver\'s port at a time, so the Flight Console page has to be disconnected while this runs.')
        say('')

        if self._port is None:
            self._port = self._find_port()
            if self._port is None:
                return

        self._note('# Dogtooth flight log\n'
                   f'# started {started}\n'
                   f'# written by the backup logger on {self._port} at {self._baud} baud\n'
                   f'{HEADER_FORMAT}')

        first = True
        while not self._stopping():
            ser = self._connect()
            if ser is None:
                break
            if first:
                say(f'Connected to {self._port} at {self._baud:,} baud. Waiting for lines.')
            else:
                self._note(f'# connected {stamp()}')
                say(f'{self._port} is back. Still saving to the same file.')
            first = False
            self._connected = True
            self._last_data = time.monotonic()
            dropped = self._read(ser)
            # What is left of a line that was cut off goes in before the marker.
            rest = self._splitter.take_rest()
            if rest is not None:
                self._save([rest])
            self._note(f'# connection closed {stamp()}')
            self._connected = False
            try:
                ser.close()
            except Exception:
                pass
            if dropped and not self._stopping():
                say(f'{self._port} stopped answering. The cable may have come out. '
                    f'Everything so far is saved. Trying again every {self._retry_s:g} seconds.')
                self._pause(self._retry_s)

    def _stopping(self):
        if self._stop.is_set():
            return True
        if self._seconds is not None and time.monotonic() - self._t0 >= self._seconds:
            return True
        return False

    def _pause(self, seconds):
        """Waits, in short steps so a stop is noticed, and keeps the status lines coming."""
        end = time.monotonic() + seconds
        while not self._stopping():
            left = end - time.monotonic()
            if left <= 0:
                break
            self._stop.wait(min(left, READ_WAIT_S))
            self._tick()

    # -- choosing the port ----------------------------------------------

    def _find_port(self):
        """Picks the only USB serial port, asks when there are several, waits when there are none."""
        say = self._console.say
        said = None
        while not self._stopping():
            ports = self._list_ports()
            usb = [p for p in ports if p.vid is not None]
            if len(usb) == 1:
                self._show_ports(ports)
                say(f'Using {usb[0].device}. It is the only USB serial port.')
                return usb[0].device
            if len(usb) > 1:
                self._show_ports(ports)
                self._console.drain()
                choice = self._ask(len(ports))
                if choice is None:
                    if not self._stopping():
                        say('There are several USB serial ports and nobody to ask which one. '
                            'Start it again with --port and the port\'s name, like --port COM5.')
                        self._code = 2
                    return None
                if choice == 0:
                    continue        # Enter alone looks at the ports again
                return ports[choice - 1].device
            names = tuple(p.device for p in ports)
            if names != said:
                said = names
                if ports:
                    self._show_ports(ports)
                    say('None of these is a USB serial port. If the receiver is one of them, '
                        'start it again with --port and its name.')
                say(f'No USB serial port found. Plug in the receiver board. '
                    f'Checking again every {self._retry_s:g} seconds.')
            self._pause(self._retry_s)
        return None

    def _show_ports(self, ports):
        say = self._console.say
        say('Serial ports on this computer:')
        for number, info in enumerate(ports, 1):
            say(f'  {number}. {describe_port(info)}')

    # -- opening --------------------------------------------------------

    def _connect(self):
        """Opens the port, trying again until it works. None when it is time to stop."""
        say = self._console.say
        said = None
        while not self._stopping():
            try:
                ser = self._open_port(self._port, self._baud)
            except ValueError as err:
                # A bad port name or speed. Trying again won't change it.
                say(f'{self._port} can\'t be used ({reason(err)}).')
                self._code = 2
                return None
            except (serial.SerialException, OSError) as err:
                kind = why_not_open(err)
                if kind == 'busy':
                    text = (f'{self._port} is being used by another program. Only one program can use a '
                            'serial port at a time, and the Flight Console page in Chrome probably has it. '
                            'Press DISCONNECT on that page or close its tab. '
                            f'Trying again every {self._retry_s:g} seconds.')
                elif kind == 'missing':
                    text = (f'{self._port} is not there. Plug in the receiver board. '
                            f'Trying again every {self._retry_s:g} seconds.')
                else:
                    text = (f'{self._port} did not open ({reason(err)}). '
                            f'Trying again every {self._retry_s:g} seconds.')
                if text != said:
                    said = text
                    say(text)
                if kind == 'missing' and self._follow_port():
                    said = None
                    continue
            else:
                self._watch_list = self._is_listed()
                self._last_gone_check = time.monotonic()
                return ser
            self._pause(self._retry_s)
        return None

    def _follow_port(self):
        """After a replug in another USB socket Windows can give the board a
        new COM number. When the logger chose the port itself and exactly one
        USB serial port is there now, it moves to that one."""
        if not self._auto or is_url(self._port):
            return False
        usb = [p for p in self._list_ports() if p.vid is not None]
        if len(usb) != 1 or port_key(usb[0].device) == port_key(self._port):
            return False
        self._console.say(f'{self._port} is gone and {describe_port(usb[0])} is there now. Using it.')
        self._port = usb[0].device
        return True

    def _is_listed(self):
        """True when the open port shows in the port list, so a later look can tell that it went away."""
        if is_url(self._port):
            return False
        key = port_key(self._port)
        return any(port_key(p.device) == key for p in self._list_ports())

    # -- reading --------------------------------------------------------

    def _read(self, ser):
        """Reads and saves until the port drops or it is time to stop. True when the port dropped."""
        while not self._stopping():
            try:
                # Take everything that is waiting, or wait a moment for the first byte.
                waiting = ser.in_waiting
                data = ser.read(waiting if waiting > 0 else 1)
            except (serial.SerialException, OSError):
                return True
            now = time.monotonic()
            if data:
                self._last_data = now
                lines = self._splitter.feed(data, now)
                if lines:
                    self._save(lines)      # on the disk before the next read
            elif self._gone(now):
                return True
            if self._splitter.overdue(now, self._partial_wait_s):
                # Written as it stands. Its line ending may still come, and
                # then it does not count as a new, empty line.
                self._save([self._splitter.take_rest(more_coming=True)])
            self._tick()
        self._take_last(ser)
        return False

    def _take_last(self, ser):
        """At a stop, takes what has already reached the computer before the
        port is closed, so a line that came in whole is not cut in two by the
        stop. A line that is half here gets a moment for its ending. Only for
        a moment, in case the port never goes quiet."""
        end = time.monotonic() + STOP_TAKE_S
        while time.monotonic() < end:
            try:
                waiting = ser.in_waiting
                if waiting <= 0 and not self._splitter.waiting:
                    return
                data = ser.read(waiting if waiting > 0 else 1)
            except (serial.SerialException, OSError):
                return
            if data:
                lines = self._splitter.feed(data)
                if lines:
                    self._save(lines)

    def _gone(self, now):
        """Some drivers go quiet when the cable comes out and report no error.
        So while a port is silent, look it up in the port list now and then."""
        if not self._watch_list or now - self._last_data < GONE_CHECK_S:
            return False
        if now - self._last_gone_check < GONE_CHECK_S:
            return False
        self._last_gone_check = now
        return not self._is_listed()

    # -- saving ---------------------------------------------------------

    def _save(self, lines):
        """Writes finished lines, each with the time it arrived, then shows them."""
        when = stamp()
        ok = self._log.add(''.join(f'{when} > {line}\n' for line in lines))
        self.lines += len(lines)
        self.packets += sum(1 for line in lines if is_packet(line))
        self._disk_state(ok)
        for line in lines:
            self._console.say(shown(line))

    def _note(self, text):
        """A line of the logger's own. It starts with '# ' and has no time in front."""
        self._disk_state(self._log.add(text + '\n'))

    def _disk_state(self, ok):
        if not ok and not self._disk_bad:
            self._disk_bad = True
            self._console.say(f'The file can\'t be written right now ({reason(self._log.error)}). '
                              'The lines are held in memory and it keeps trying. Leave this window open.')
        elif ok and self._disk_bad:
            self._disk_bad = False
            self._console.say('The file is being written again. Nothing was lost.')

    def _tick(self):
        """Tries a failed write again, and prints the status line when it is due."""
        if self._disk_bad:
            self._disk_state(self._log.save())
        now = time.monotonic()
        if now - self._last_status >= self._status_every_s:
            self._last_status = now
            self._console.say(self._status(now))

    def _status(self, now):
        clock = datetime.datetime.now().strftime('%H:%M:%S')
        text = f'{clock}  '
        if not self._connected:
            text += f'Not connected to {self._port}. '
        elif now - self._last_data >= QUIET_AFTER_S:
            text += f'Nothing from {self._port} for {int(now - self._last_data)} seconds. '
        text += f'{self._totals()}. File: {os.path.basename(self.path)}'
        if self._disk_bad:
            text += f'. {count(self._log.held, "byte")} NOT on the disk yet'
        if self._console.skipped:
            text += (f'. The window fell behind, so {count(self._console.skipped, "line")} '
                     'did not show here. They are in the file')
        return text

    def _totals(self):
        return f'{count(self.lines, "line")} saved, {count(self.packets, "packet")}'

    # -- the end --------------------------------------------------------

    def _end_file(self):
        """Closes the file. An empty one (stopped before a port was chosen) is taken away. True when a file is kept."""
        self._log.close()
        if self._log.size() == 0:
            try:
                os.remove(self._log.path)
            except OSError:
                pass
            return False
        return True

    def _goodbye(self, kept):
        say = self._console.say
        say('')
        if self._log.held:
            say(f'The last {count(self._log.held, "byte")} could not be written to the file '
                f'({reason(self._log.error)}), so they are not in it.')
        if self._seconds is not None and not self._stop.is_set() and self._code == 0:
            say(f'Stopped after {self._seconds:g} seconds, as asked. {self._totals()}.')
        else:
            say(f'Stopped. {self._totals()}.')
        if kept:
            say(f'The file is {self.path}')
        else:
            say('No port was chosen, so no file was kept.')


# ------------------------------------------------------------------
# Command line
# ------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Saves every line from the receiver board\'s serial port to a text file. '
                    'The backup for the Flight Console launch page.')
    parser.add_argument('--port', help='the serial port, like COM5, or a pyserial URL like socket://127.0.0.1:8116. '
                                       'Left out, the only USB serial port is used.')
    parser.add_argument('--baud', type=int, default=BAUD, help=f'the speed (default {BAUD})')
    parser.add_argument('--out', help='the file to add to (default: a new file in flight-logs/)')
    parser.add_argument('--seconds', type=float, help='stop after this many seconds')
    parser.add_argument('--list', action='store_true', help='list the serial ports and stop')
    args = parser.parse_args(argv)

    # The window may not be able to show every character. That must not be an error.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass

    if serial is None:
        print('pyserial is not installed, and the logger needs it to read the port.')
        print('Install it with this command, then start the logger again:')
        print('  python -m pip install pyserial')
        return 2

    if args.baud == RESET_BAUD:
        # Opening the SAMD21's USB serial at 1200 baud and closing it again
        # restarts the board in its bootloader, and then it stops receiving.
        print(f'{RESET_BAUD} baud would restart the receiver board in its bootloader when the port closes, '
              'so the logger won\'t use it. The receiver talks at 115200 baud.')
        return 2

    if args.list:
        ports = list_serial_ports()
        if not ports:
            print('No serial port found.')
        for number, info in enumerate(ports, 1):
            print(f'  {number}. {describe_port(info)}')
        return 0

    console = Console()
    stopper = Stopper()
    stopper.install()
    logger = BackupLogger(port=args.port, baud=args.baud, out=args.out, seconds=args.seconds,
                          console=console, stop=stopper.stop, finished=stopper.finished,
                          ask=lambda how_many: ask_number(how_many, stopper))
    code = logger.run()
    if not console.drain(2.0):
        # The window is stuck and would hold the exit. The file is already closed and safe.
        os._exit(code)
    return code


if __name__ == '__main__':
    sys.exit(main())
