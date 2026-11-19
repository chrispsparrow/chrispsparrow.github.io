"""backup_logger_test.py: checks the backup logger (launch-mode/backup_logger.py)
with no board plugged in. It prints PASS or FAIL for each check.

Run it:
  python launch-mode/test/backup_logger_test.py            every check, about a minute
  python launch-mode/test/backup_logger_test.py --quick    only the checks that need no second program
  python launch-mode/test/backup_logger_test.py --sample   only writes flight-logs/backup-sample-from-test.log,
                                                           a real-time run of the whole capture with one
                                                           dropped connection (a little over two minutes)

Two kinds of checks:
  1. Inside this program. The logger's own loop runs against a scripted
     port that hands over several bytes at a time, the way a real COM port
     does, and fails on cue (in use, unplugged, a full disk, a stuck window).
  2. The real thing. backup_logger.py runs as its own program and reads
     launch-mode/test/fake_receiver.py over TCP (pyserial's socket:// port),
     and the file it wrote is compared with the fake receiver's journal of
     what it really sent.

It uses TCP ports 8116 and 8117 on 127.0.0.1 and a scratch folder in the
temp directory. The one check that uses the logger's default file name
writes to flight-logs/ and deletes that file again.

The exit code is 0 when every check passed.
"""

import argparse
import datetime
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCH_MODE = os.path.dirname(HERE)
ROOT = os.path.dirname(LAUNCH_MODE)
LOGGER = os.path.join(LAUNCH_MODE, 'backup_logger.py')
FAKE = os.path.join(HERE, 'fake_receiver.py')
CAPTURE = os.path.join(ROOT, 'flight-console', 'test', 'radio-board-rx-capture.log')
LOGS_DIR = os.path.join(ROOT, 'flight-logs')
SAMPLE = os.path.join(LOGS_DIR, 'backup-sample-from-test.log')
TCP_A = 8116
TCP_B = 8117
WINDOWS = os.name == 'nt'

sys.path.insert(0, LAUNCH_MODE)
sys.dont_write_bytecode = True  # no __pycache__ folder left in launch-mode/ to be committed by mistake
import backup_logger as bl      # noqa: E402
import serial                   # noqa: E402

STAMP = r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}'
STAMP_RE = re.compile(f'^{STAMP}$')
DATA_RE = re.compile(f'^({STAMP}) > (.*)$', re.DOTALL)
CLOSED_RE = re.compile(f'^# connection closed ({STAMP})$')
CONNECTED_RE = re.compile(f'^# connected ({STAMP})$')
FORMAT_LINE = "# each line: the time it arrived on this computer, then ' > ', then the receiver's line"

results = []
children = []       # every program this test started, so none is left running


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    line = f'{"PASS" if ok else "FAIL"}  {name}'
    if detail and not ok:
        line += f'\n      {detail}'
    print(line, flush=True)
    return bool(ok)


def section(title):
    print(f'\n{title}', flush=True)


# ------------------------------------------------------------------
# Reading a log file back
# ------------------------------------------------------------------

def read_log(path):
    """The file as (header lines, body items, problems).

    A body item is ('data', time, text), ('closed', time), ('connected', time)
    or ('other', line). The file must be valid UTF-8 and end with a line feed.
    """
    problems = []
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as err:
        return [], [], [f'not valid UTF-8: {err}']
    if raw and not raw.endswith(b'\n'):
        problems.append('the file does not end with a line feed')
    lines = text.split('\n')
    lines.pop()
    header, body = lines[:4], []
    for line in lines[4:]:
        m = DATA_RE.match(line)
        if m:
            body.append(('data', m.group(1), m.group(2)))
            continue
        m = CLOSED_RE.match(line)
        if m:
            body.append(('closed', m.group(1)))
            continue
        m = CONNECTED_RE.match(line)
        if m:
            body.append(('connected', m.group(1)))
            continue
        body.append(('other', line))
        problems.append(f'a line that is neither data nor a marker: {line[:80]!r}')
    return header, body, problems


def header_problems(header, port, baud=115200):
    want = ['# Dogtooth flight log', None, f'# written by the backup logger on {port} at {baud} baud', FORMAT_LINE]
    if len(header) < 4:
        return [f'the header has {len(header)} lines, not 4']
    out = []
    for i, line in enumerate(want):
        if line is not None and header[i] != line:
            out.append(f'header line {i + 1} is {header[i]!r}')
    m = re.match(f'^# started ({STAMP})$', header[1])
    if not m:
        out.append(f'header line 2 is {header[1]!r}')
    return out


def shape(body):
    """The body without its times, for comparing with what was expected."""
    return [(item[0], item[2]) if item[0] == 'data' else (item[0],) for item in body]


def times_problems(body, begin, end):
    """Every time must parse, sit inside the test's own start and end, and never go backwards."""
    out = []
    last = None
    for item in body:
        if item[0] == 'other':
            continue
        when = datetime.datetime.fromisoformat(item[1])
        if when.utcoffset() != begin.utcoffset():
            out.append(f'{item[1]} has another UTC offset than this computer ({begin.isoformat()})')
            break
        if not (begin - datetime.timedelta(seconds=1) <= when <= end + datetime.timedelta(seconds=1)):
            out.append(f'{item[1]} is outside the run ({begin.isoformat()} to {end.isoformat()})')
            break
        if last is not None and when < last:
            out.append(f'{item[1]} is earlier than the line before it')
            break
        last = when
    return out


def first_difference(got, want):
    for i in range(max(len(got), len(want))):
        a = got[i] if i < len(got) else '(nothing)'
        b = want[i] if i < len(want) else '(nothing)'
        if a != b:
            return f'item {i}: the file has {a!r}, expected {b!r} (the file has {len(got)} items, expected {len(want)})'
    return ''


# ------------------------------------------------------------------
# What the fake receiver really sent
# ------------------------------------------------------------------

def text_of(raw):
    if raw.endswith(b'\r'):
        raw = raw[:-1]
    return raw.decode('utf-8', errors='replace')


def read_journal(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def expected_from_journal(events, partial_wait_s=2.0):
    """The body the logger should have written for this journal, as shape() gives it.

    Bytes are lines once their line feed is sent. A piece with no line feed
    becomes a line of its own when the connection ends, or when the fake
    receiver stalled for longer than the logger waits for a line ending.
    Returns (items, bytes per connection).
    """
    items = []
    per_conn = {}
    buffer = bytearray()
    open_conn = None

    def lines_out(flush_rest):
        parts = bytes(buffer).split(b'\n')
        rest = parts.pop()
        buffer.clear()
        for part in parts:
            items.append(('data', text_of(part)))
        if rest:
            if flush_rest:
                items.append(('data', text_of(rest)))
            else:
                buffer.extend(rest)

    for ev in events:
        kind = ev['e']
        if kind == 'connect':
            if open_conn is not None:
                lines_out(True)
                items.append(('closed',))
            if ev['conn'] > 1:
                items.append(('connected',))
            open_conn = ev['conn']
            per_conn[open_conn] = bytearray()
        elif kind == 'send':
            data = bytes.fromhex(ev['hex'])
            buffer.extend(data)
            per_conn[ev['conn']].extend(data)
        elif kind == 'stall':
            lines_out(ev['seconds'] > partial_wait_s)
        elif kind in ('drop', 'done', 'client-left'):
            lines_out(True)
            items.append(('closed',))
            open_conn = None
    return items, per_conn


# ------------------------------------------------------------------
# Starting and stopping the two programs
# ------------------------------------------------------------------

class Reader(threading.Thread):
    """Collects a program's output lines as they come."""

    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream = stream
        self.lines = []
        self.start()

    def run(self):
        for raw in self.stream:
            self.lines.append(raw.decode('utf-8', errors='replace').rstrip('\r\n'))

    def wait_for(self, text, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if any(text in line for line in list(self.lines)):
                return True
            time.sleep(0.02)
        return False


def start_fake(tcp, journal, *options):
    proc = subprocess.Popen([sys.executable, FAKE, '--port', str(tcp), '--journal', journal, '--once', *options],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    children.append(proc)
    proc.reader = Reader(proc.stdout)
    if not proc.reader.wait_for('listening', 15):
        raise RuntimeError(f'the fake receiver did not start: {proc.reader.lines}')
    return proc


def start_logger(arguments, stdout, new_group=True, **more):
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if (WINDOWS and new_group) else 0
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    proc = subprocess.Popen([sys.executable, LOGGER, *arguments], stdout=stdout, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, creationflags=flags | more.pop('flags', 0), env=env, **more)
    children.append(proc)
    return proc


def ask_to_stop(proc):
    """The same as Ctrl+Break in the logger's window. It can only be sent to
    a program started in its own group, which start_logger does."""
    try:
        proc.send_signal(signal.CTRL_BREAK_EVENT if WINDOWS else signal.SIGINT)
        return True
    except OSError:
        return False


def wait_exit(proc, timeout):
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def wait_for_tail(path, pattern, timeout):
    """Waits until the file's last line matches."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with open(path, 'rb') as f:
                tail = f.read().decode('utf-8', errors='replace').rstrip('\n').split('\n')[-1]
            if pattern.match(tail):
                return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


def now_local():
    return datetime.datetime.now().astimezone()


def run_pair(tmp, name, fake_options, tcp=TCP_A, backstop=60, fake_timeout=40):
    """Runs the fake receiver to its end with the logger reading it, then stops
    the logger the clean way. Returns what happened."""
    out = os.path.join(tmp, f'{name}.log')
    journal = os.path.join(tmp, f'{name}.journal')
    screen = os.path.join(tmp, f'{name}.screen.txt')
    port = f'socket://127.0.0.1:{tcp}'
    begin = now_local()
    fake = start_fake(tcp, journal, *fake_options)
    with open(screen, 'wb') as screen_file:
        logger = start_logger(['--port', port, '--out', out, '--seconds', str(backstop)], screen_file)
        fake_code = wait_exit(fake, fake_timeout)
        saw_end = wait_for_tail(out, CLOSED_RE, 10)
        sent = ask_to_stop(logger)
        code = wait_exit(logger, 10 if sent else backstop + 10)
    end = now_local()
    with open(screen, encoding='utf-8', errors='replace') as f:
        screen_text = f.read()
    return types.SimpleNamespace(out=out, port=port, begin=begin, end=end, code=code, fake_code=fake_code,
                                 saw_end=saw_end, stop_sent=sent, events=read_journal(journal), screen=screen_text)


def check_run(label, run, want=None):
    """The checks every run shares. Returns (header, body)."""
    header, body, problems = read_log(run.out)
    check(f'{label}: the logger stopped cleanly with exit code 0', run.code == 0,
          f'exit code {run.code}, fake receiver {run.fake_code}, stop sent {run.stop_sent}\n{run.screen[-600:]}')
    problems += header_problems(header, run.port)
    check(f'{label}: the file is UTF-8, ends with a line feed, has the four header lines, and every other line is data or a marker',
          not problems, '; '.join(problems[:3]))
    bad_time = times_problems(body, run.begin, run.end)
    check(f'{label}: every line has a valid time prefix, in order, inside the run', not bad_time, '; '.join(bad_time))
    if want is not None:
        got = shape(body)
        check(f'{label}: the file matches what the fake receiver sent, line for line ({len(want)} items)',
              got == want, first_difference(got, want))
    return header, body


def capture_lines():
    with open(CAPTURE, 'rb') as f:
        lines = f.read().decode('utf-8').split('\n')
    if lines[-1] == '':
        lines.pop()
    return lines


# ------------------------------------------------------------------
# 1. Inside this program
# ------------------------------------------------------------------

class ListConsole:
    """Stands in for the window and keeps what was said."""

    def __init__(self):
        self.said = []
        self.skipped = 0

    def say(self, text=''):
        self.said.append(text)

    def drain(self, timeout=0):
        return True

    def has(self, *pieces):
        return any(all(p in line for p in pieces) for line in self.said)


class ScriptedPort:
    """Acts like an open COM port. Each step is some bytes that are "waiting"
    together (so read() hands them over in one piece, as Windows does), a
    number of seconds of silence, an error to raise, or a function to call
    (a read that calls it gets nothing)."""

    def __init__(self, steps, at_end=None):
        self.steps = list(steps)
        self.at_end = at_end
        self.closed = False
        self.pieces = []

    @property
    def in_waiting(self):
        if self.steps:
            head = self.steps[0]
            if isinstance(head, BaseException):
                self.steps.pop(0)
                raise head
            if isinstance(head, (bytes, bytearray)):
                return len(head)
        return 0

    def read(self, size=1):
        if not self.steps:
            if self.at_end:
                self.at_end()
            time.sleep(0.002)
            return b''
        head = self.steps[0]
        if isinstance(head, BaseException):
            self.steps.pop(0)
            raise head
        if isinstance(head, (int, float)):
            self.steps.pop(0)
            time.sleep(head)
            return b''
        if callable(head):
            self.steps.pop(0)
            head()
            return b''
        data, rest = head[:size], head[size:]
        if rest:
            self.steps[0] = rest
        else:
            self.steps.pop(0)
        self.pieces.append(len(data))
        return bytes(data)

    def close(self):
        self.closed = True


def opener_from(outcomes, opened=None):
    """An open function that gives the next outcome each time: a port, or an error to raise."""
    queue = list(outcomes)

    def opener(port, baud):
        if opened is not None:
            opened.append(port)
        if not queue:
            raise serial.SerialException(f"could not open port '{port}': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")
        nxt = queue.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        return nxt
    return opener


def port_info(device, description, vid=None, pid=None, serial_number=None):
    return types.SimpleNamespace(device=device, description=description, vid=vid, pid=pid, serial_number=serial_number)


def run_inside(tmp, name, outcomes, port='COM5', lister=None, ask=None, **settings):
    """Runs the logger's real loop in this program. Returns (exit code, logger, console, file path)."""
    out = os.path.join(tmp, f'{name}.log')
    console = settings.pop('console', None) or ListConsole()
    stop = settings.pop('stop', None) or threading.Event()
    opened = []
    for outcome in outcomes:
        if isinstance(outcome, ScriptedPort) and outcome.at_end == 'stop':
            outcome.at_end = stop.set
    options = dict(retry_s=0.02, partial_wait_s=0.05, status_every_s=1000)
    options.update(settings)
    logger = bl.BackupLogger(port=port, out=out, console=console, stop=stop,
                             opener=opener_from(outcomes, opened),
                             lister=lister or (lambda: []), ask=ask, **options)
    worker = {}
    thread = threading.Thread(target=lambda: worker.setdefault('code', logger.run()), daemon=True)
    thread.start()
    thread.join(30)
    if thread.is_alive():
        stop.set()
        thread.join(5)
        worker.setdefault('code', 'the logger did not finish in 30 seconds')
    logger.opened = opened
    return worker.get('code'), logger, console, out


def random_pieces(data, rng, biggest):
    pieces = []
    at = 0
    while at < len(data):
        size = rng.randint(1, biggest)
        pieces.append(data[at:at + size])
        at += size
    return pieces


def inside_checks(tmp):
    section('1. Inside this program: the pieces, and the real loop against a scripted port')
    want_lines = capture_lines()

    # -- the time prefix
    fixed = datetime.datetime(2026, 11, 21, 14, 3, 22, 123999,
                              tzinfo=datetime.timezone(datetime.timedelta(hours=-5)))
    check('the time prefix reads like 2026-11-21T14:03:22.123-05:00',
          bl.stamp(fixed) == '2026-11-21T14:03:22.123-05:00' and STAMP_RE.match(bl.stamp()) is not None,
          f'{bl.stamp(fixed)} and {bl.stamp()}')
    east = datetime.datetime(2026, 6, 1, 9, 0, 0, 5000, tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
    check('a time east of Greenwich and a whole second keep the same shape',
          bl.stamp(east) == '2026-06-01T09:00:00.005+05:30', bl.stamp(east))

    # -- lines out of bytes
    stream = b''.join(line.encode('utf-8') + b'\r\n' for line in want_lines)
    worst = ''
    for seed in range(300):
        rng = random.Random(seed)
        splitter = bl.LineSplitter()
        got = []
        for piece in random_pieces(stream, rng, rng.choice([1, 2, 3, 7, 64, 300, 5000])):
            got += splitter.feed(piece)
        if got != want_lines or splitter.waiting:
            worst = f'seed {seed}: {first_difference(got, want_lines)}'
            break
    check('the capture cut into random pieces 300 different ways always gives the same 253 lines', not worst, worst)

    splitter = bl.LineSplitter()
    got = splitter.feed(b'  spaces kept  \r\n\r\nlone\rCR kept\nLF only\ntab\there\r\npart')
    check('only the line ending is taken off: spaces, an empty line, a CR in the middle and a tab are kept',
          got == ['  spaces kept  ', '', 'lone\rCR kept', 'LF only', 'tab\there'] and splitter.waiting, repr(got))
    check('an unfinished line can be taken as it stands', splitter.take_rest() == 'part' and splitter.take_rest() is None)

    splitter = bl.LineSplitter()
    got = splitter.feed(b'\xff\xfe\x80 noise \xc3\x28 \xe2\x82\n' + '21.5 \u00b0C \u2713\n'.encode('utf-8'))
    check('bytes that are not UTF-8 become the replacement mark, and real UTF-8 is unchanged',
          got == ['\ufffd\ufffd\ufffd noise \ufffd( \ufffd', '21.5 \u00b0C \u2713'], repr(got))

    splitter = bl.LineSplitter()
    cut_in_two = 0
    for piece in random_pieces('21.5 \u00b0C \u2713 \U0001F680 done\r\n'.encode('utf-8') * 40, random.Random(7), 3):
        for line in splitter.feed(piece):
            cut_in_two += line != '21.5 \u00b0C \u2713 \U0001F680 done'
    check('a character whose bytes arrive in different pieces is still one character', cut_in_two == 0)

    splitter = bl.LineSplitter()
    noise = ('\u00b5' * 5000).encode('utf-8')       # 10,000 bytes with no line ending
    got = splitter.feed(noise) + [splitter.take_rest()]
    check('noise with no line ending is cut into lines of at most 4096 bytes, never through a character',
          ''.join(got) == '\u00b5' * 5000 and all(len(part.encode('utf-8')) <= 4096 for part in got) and len(got) == 3,
          f'{[len(p) for p in got]}')

    # -- the one speed that would reset the board
    opened = []
    real_open = bl.open_port
    bl.open_port = lambda *a: opened.append(a)
    try:
        code = bl.main(['--port', 'COM5', '--baud', '1200', '--seconds', '1'])
    finally:
        bl.open_port = real_open
    check('--baud 1200 (the speed that restarts the board in its bootloader) is refused before any port is opened',
          code == 2 and not opened, f'code {code}, opened {opened}')

    # -- the real loop, several bytes at a time
    rng = random.Random(11)
    port = ScriptedPort(random_pieces(stream, rng, 400), at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-pieces', [port])
    header, body, problems = read_log(out)
    want = [('data', line) for line in want_lines] + [('closed',)]
    check('the loop reads pieces of up to 400 bytes (several lines at once, cut anywhere) and saves the same 253 lines',
          code == 0 and not problems and shape(body) == want and max(port.pieces) > 200,
          f'code {code}, {problems[:2]}, {first_difference(shape(body), want)}')
    check('the loop counts lines and packets', logger.lines == 253 and logger.packets == 126, f'{logger.lines} lines, {logger.packets} packets')
    check('the header names the port and the speed', not header_problems(header, 'COM5'), '; '.join(header_problems(header, 'COM5')))
    check('the port is closed at the end', port.closed)

    # -- a port another program holds
    busy = serial.SerialException("could not open port 'COM5': PermissionError(13, 'Access is denied.', None, 5)")
    port = ScriptedPort([b'PKT node=1 seq=1\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-busy', [busy, busy, busy, port])
    told = [line for line in console.said if 'Only one program can use a serial port at a time' in line]
    check('a port that another program holds: the message says only one program can use it, names the Flight Console page and DISCONNECT',
          len(told) == 1 and 'Flight Console page in Chrome' in told[0] and 'DISCONNECT' in told[0] and 'close its tab' in told[0],
          repr(console.said))
    header, body, problems = read_log(out)
    check('it keeps trying and reads the port once it is free (4 tries, then the line is saved)',
          code == 0 and len(logger.opened) == 4 and shape(body) == [('data', 'PKT node=1 seq=1'), ('closed',)],
          f'code {code}, tries {len(logger.opened)}, {shape(body)}')
    check('"Access is denied", "FileNotFoundError" and other errors are told apart',
          bl.why_not_open(busy) == 'busy'
          and bl.why_not_open(serial.SerialException("could not open port 'COM9': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")) == 'missing'
          and bl.why_not_open(serial.SerialException('Could not open port socket://127.0.0.1:1: [WinError 10061] refused')) == 'other')

    # -- the cable comes out in the middle of a line, then comes back
    unplug = serial.SerialException("ClearCommError failed (PermissionError(13, 'Access is denied.', None, 5))")
    gone = serial.SerialException("could not open port 'COM5': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")
    first = ScriptedPort([b'# DEKEL_RX one\r\nPKT node=1 seq=1\r\nPKT node=1 se', unplug])
    second = ScriptedPort([b'# DEKEL_RX two\r\nPKT node=1 seq=3\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-drop', [first, gone, gone, second])
    header, body, problems = read_log(out)
    want = [('data', '# DEKEL_RX one'), ('data', 'PKT node=1 seq=1'), ('data', 'PKT node=1 se'), ('closed',),
            ('connected',), ('data', '# DEKEL_RX two'), ('data', 'PKT node=1 seq=3'), ('closed',)]
    check('an unplugged port: the cut-off line is saved, then "# connection closed", then "# connected" and the new lines, all in one file',
          code == 0 and not problems and shape(body) == want, f'code {code}, {problems[:2]}, {first_difference(shape(body), want)}')
    check('the window says the port stopped answering, that it is not there, and that it is back',
          console.has('stopped answering') and console.has('is not there') and console.has('is back'), repr(console.said))
    check('the first port was closed before trying again', first.closed)

    # -- a line with no ending
    port = ScriptedPort([b'PKT half', 0.2, b' and the rest\r\nPKT whole\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-partial', [port], partial_wait_s=0.05)
    header, body, problems = read_log(out)
    want = [('data', 'PKT half'), ('data', ' and the rest'), ('data', 'PKT whole'), ('closed',)]
    check('a line with no ending is written once it has sat longer than the wait, and the rest follows as its own line',
          shape(body) == want, first_difference(shape(body), want))
    port = ScriptedPort([b'PKT half', 0.01, b' and the rest\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-partial-short', [port], partial_wait_s=5)
    header, body, problems = read_log(out)
    check('a short pause in the middle of a line does not split it',
          shape(body) == [('data', 'PKT half and the rest'), ('closed',)], repr(shape(body)))
    port = ScriptedPort([b'PKT half', 0.2, b'\r\n', b'\r\nPKT next\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-partial-ending', [port], partial_wait_s=0.05)
    header, body, problems = read_log(out)
    want = [('data', 'PKT half'), ('data', ''), ('data', 'PKT next'), ('closed',)]
    check('a line ending that comes after its line was written is not saved as an extra empty line (a real empty line after it still is)',
          shape(body) == want, first_difference(shape(body), want))
    trickle = [step for byte in b'noise with no ending' for step in (bytes([byte]), 0.02)]
    port = ScriptedPort(trickle + [0.1], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-trickle', [port], partial_wait_s=0.15)
    header, body, problems = read_log(out)
    texts = [item[2] for item in body if item[0] == 'data']
    check('bytes that trickle in with no line ending are written once the first of them has waited, not held until the ending',
          len(texts) >= 2 and ''.join(texts) == 'noise with no ending' and shape(body)[-1] == ('closed',), repr(texts))
    port = ScriptedPort([b'no ending at all'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-partial-stop', [port], partial_wait_s=60)
    header, body, problems = read_log(out)
    check('stopping the logger writes an unfinished line before it closes the file',
          shape(body) == [('data', 'no ending at all'), ('closed',)], repr(shape(body)))

    stop = threading.Event()
    port = ScriptedPort([b'PKT one\r\n', stop.set, b'PKT two\r\nPKT thr', b'ee\r\nPKT fo', 0.1, b'ur\r\n'])
    code, logger, console, out = run_inside(tmp, 'inside-stop-takes-last', [port], stop=stop, partial_wait_s=60)
    header, body, problems = read_log(out)
    want = [('data', 'PKT one'), ('data', 'PKT two'), ('data', 'PKT three'), ('data', 'PKT four'), ('closed',)]
    check('a stop first takes the lines that already arrived, and gives a half-arrived line a moment for its ending',
          code == 0 and shape(body) == want and port.closed, first_difference(shape(body), want))

    # -- the disk refuses for a while
    class FlakyFile:
        """A file that fails its first writes, then takes only part of one."""

        def __init__(self, real):
            self.real = real
            self.calls = 0

        def write(self, data):
            self.calls += 1
            if 3 <= self.calls <= 6:
                raise OSError(28, 'No space left on device')
            if self.calls == 7:
                return self.real.write(bytes(data[:len(data) // 2]))
            return self.real.write(data)

        def __getattr__(self, name):
            return getattr(self.real, name)

    flaky = {}

    def flaky_open(path, mode, buffering):
        flaky['file'] = FlakyFile(open(path, mode, buffering=buffering))
        return flaky['file']

    lines = [f'PKT node=1 seq={n}' for n in range(12)]
    port = ScriptedPort([(line + '\r\n').encode() for line in lines] + [0.05, 0.05], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-disk', [port], file_opener=flaky_open)
    header, body, problems = read_log(out)
    want = [('data', line) for line in lines] + [('closed',)]
    check('a disk that refuses four writes and then takes half of one: every line ends up in the file once, in order',
          code == 0 and not problems and shape(body) == want, f'{problems[:2]} {first_difference(shape(body), want)}')
    check('the window says the file can\'t be written, and later that nothing was lost',
          console.has('can\'t be written right now', 'No space left') and console.has('Nothing was lost'), repr(console.said))

    # -- a stuck window
    class Stuck:
        """A window that takes a little and then never returns from a write."""

        def __init__(self):
            self.release = threading.Event()
            self.wrote = 0

        def write(self, text):
            self.wrote += 1
            if self.wrote > 3:
                self.release.wait()

        def flush(self):
            pass

    stuck = Stuck()
    console = bl.Console(stream=stuck, size=10)
    port = ScriptedPort(random_pieces(stream, random.Random(3), 90), at_end='stop')
    began = time.monotonic()
    code, logger, _, out = run_inside(tmp, 'inside-stuck', [port], console=console)
    took = time.monotonic() - began
    header, body, problems = read_log(out)
    want = [('data', line) for line in want_lines] + [('closed',)]
    check('a window that stops taking text does not stop the saving: all 253 lines are in the file',
          code == 0 and shape(body) == want and console.skipped > 200 and took < 10,
          f'code {code}, skipped {console.skipped}, {took:.1f} s, {first_difference(shape(body), want)}')
    check('a stuck window is reported as stuck, so the program can still exit', console.drain(0.2) is False)
    stuck.release.set()

    # -- an --out file that already has something in it
    out = os.path.join(tmp, 'inside-append.log')
    with open(out, 'wb') as f:
        f.write(b'# an older flight\nold line with no ending')
    port = ScriptedPort([b'PKT new\r\n'], at_end='stop')
    logger = bl.BackupLogger(port='COM5', out=out, console=ListConsole(), stop=None, opener=opener_from([port]),
                             lister=lambda: [], retry_s=0.02, status_every_s=1000)
    port.at_end = logger._stop.set
    logger.run()
    with open(out, 'rb') as f:
        raw = f.read()
    check('a file that already holds something is added to, never overwritten, and a cut-off last line gets its line feed first',
          raw.startswith(b'# an older flight\nold line with no ending\n# Dogtooth flight log\n') and b' > PKT new\n' in raw, repr(raw[:120]))

    # -- choosing the port
    usb = port_info('COM5', 'USB Serial Device (COM5)', 0x239A, 0x800B, 'ABC123')
    other_usb = port_info('COM7', 'USB-SERIAL CH340 (COM7)', 0x1A86, 0x7523)
    bluetooth = port_info('COM3', 'Standard Serial over Bluetooth link (COM3)')
    check('a port is listed with its name, description and USB ids',
          bl.describe_port(usb) == 'COM5  USB Serial Device (COM5)  (USB 239A:800B, serial ABC123)'
          and bl.describe_port(bluetooth) == 'COM3  Standard Serial over Bluetooth link (COM3)  (not USB)',
          bl.describe_port(usb) + ' | ' + bl.describe_port(bluetooth))

    looks = {'n': 0}

    def appears_later():
        looks['n'] += 1
        return [bluetooth] if looks['n'] < 4 else [bluetooth, usb]

    port = ScriptedPort([b'PKT a\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-wait', [port], port=None, lister=appears_later)
    header, body, problems = read_log(out)
    check('no USB port yet: it says so, waits, and uses the receiver when it is plugged in (a Bluetooth port is not picked)',
          code == 0 and logger.opened == ['COM5'] and console.has('No USB serial port found')
          and console.has('Using COM5. It is the only USB serial port.') and not header_problems(header, 'COM5')
          and shape(body) == [('data', 'PKT a'), ('closed',)],
          f'opened {logger.opened}, {console.said}')

    asked = []

    def answer(how_many):
        asked.append(how_many)
        return 3

    port = ScriptedPort([b'PKT a\r\n'], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-ask', [port], port=None,
                                            lister=lambda: [bluetooth, usb, other_usb], ask=answer)
    check('several USB ports: it lists them with numbers, asks, and uses the one chosen',
          code == 0 and asked == [3] and logger.opened == ['COM7'] and console.has('  3. COM7  USB-SERIAL CH340 (COM7)  (USB 1A86:7523)'),
          f'asked {asked}, opened {logger.opened}, {console.said}')

    code, logger, console, out = run_inside(tmp, 'inside-noask', [], port=None,
                                            lister=lambda: [usb, other_usb], ask=lambda how_many: None)
    check('several USB ports and nobody to ask: it says to use --port, exits with code 2 and leaves no empty file',
          code == 2 and console.has('--port COM5') and not os.path.exists(out), f'code {code}, {console.said}')

    # -- the board comes back under another COM number
    listing = {'ports': [usb]}
    moved = port_info('COM6', 'USB Serial Device (COM6)', 0x239A, 0x800B, 'ABC123')
    first = ScriptedPort([b'PKT before\r\n', unplug])
    second = ScriptedPort([b'PKT after\r\n'], at_end='stop')

    def open_moving(port, baud):
        if port == 'COM5':
            if first.steps:
                return first
            listing['ports'] = [moved]
            raise gone
        return second

    out = os.path.join(tmp, 'inside-moved.log')
    console = ListConsole()
    logger = bl.BackupLogger(port=None, out=out, console=console, opener=open_moving, lister=lambda: listing['ports'],
                             retry_s=0.02, status_every_s=1000)
    second.at_end = logger._stop.set
    code = logger.run()
    header, body, problems = read_log(out)
    want = [('data', 'PKT before'), ('closed',), ('connected',), ('data', 'PKT after'), ('closed',)]
    check('a board the logger picked by itself that comes back as COM6 is followed there',
          code == 0 and shape(body) == want and console.has('COM5 is gone', 'COM6'), f'{shape(body)} {console.said}')

    # -- a port that goes quiet without an error
    listing = {'ports': [usb]}
    silent = ScriptedPort([b'PKT before\r\n'], at_end=lambda: listing.update(ports=[]))
    second = ScriptedPort([b'PKT after\r\n'], at_end='stop')
    keep = bl.GONE_CHECK_S
    bl.GONE_CHECK_S = 0.05
    try:
        code, logger, console, out = run_inside(tmp, 'inside-silent', [silent, gone, second], lister=lambda: listing['ports'])
    finally:
        bl.GONE_CHECK_S = keep
    header, body, problems = read_log(out)
    check('a port that goes silent and is no longer in the port list is treated as unplugged',
          shape(body) == want, first_difference(shape(body), want))

    # -- status line
    port = ScriptedPort([b'PKT a\r\n# DEKEL_RX b\r\n', 0.15, 0.15], at_end='stop')
    code, logger, console, out = run_inside(tmp, 'inside-status', [port], status_every_s=0.1)
    status = [line for line in console.said if re.match(r'^\d\d:\d\d:\d\d  2 lines saved, 1 packet\. File: inside-status\.log$', line)]
    check('the status line gives the lines saved, the packets seen and the file name', len(status) >= 1, repr(console.said))


# ------------------------------------------------------------------
# 2. The real thing over TCP
# ------------------------------------------------------------------

def real_checks(tmp):
    section('2. The logger as its own program, reading the fake receiver over TCP')
    capture = capture_lines()

    # -- plain
    run = run_pair(tmp, 'plain', ['--speed', '0'])
    want, _ = expected_from_journal(run.events)
    header, body = check_run('plain run', run, want)
    plain_texts = [item[2] for item in body if item[0] == 'data']
    check('plain run: all 253 lines of the capture arrive once, in order, with their exact text',
          plain_texts == capture, first_difference(plain_texts, capture))
    with open(run.out, 'rb') as f:
        raw = f.read()
    check('plain run: lines end with LF only, and the CR the board sends is not kept', b'\r' not in raw)
    check('plain run: the window showed each line and the totals',
          capture[0] in run.screen and capture[-1] in run.screen and '253 lines saved, 126 packets' in run.screen,
          run.screen[-400:])

    # -- odd-sized pieces
    run = run_pair(tmp, 'chunks', ['--speed', '0', '--chunks', '--seed', '5'])
    want, _ = expected_from_journal(run.events)
    header, body = check_run('odd-sized pieces', run, want)
    sends = [len(ev['hex']) // 2 for ev in run.events if ev['e'] == 'send']
    texts = [item[2] for item in body if item[0] == 'data']
    check(f'odd-sized pieces: {len(sends)} pieces of 1 to {max(sends)} bytes give the very same lines as the plain run',
          texts == plain_texts and len(sends) > 1000, first_difference(texts, plain_texts))

    run = run_pair(tmp, 'chunks-lf', ['--speed', '40', '--chunks', '--seed', '9', '--lf'])
    want, _ = expected_from_journal(run.events)
    header, body = check_run('odd-sized pieces with pauses between them and LF line endings', run, want)
    texts = [item[2] for item in body if item[0] == 'data']
    check('odd-sized pieces with pauses and LF endings: the same lines again', texts == plain_texts,
          first_difference(texts, plain_texts))

    # -- a dropped connection
    run = run_pair(tmp, 'drop', ['--speed', '0', '--chunks', '--drop-after', '101', '--away', '1'])
    want, per_conn = expected_from_journal(run.events)
    header, body = check_run('dropped connection', run, want)
    kinds = [item[0] for item in body]
    at = kinds.index('closed') if 'closed' in kinds else -1
    drop = next((ev for ev in run.events if ev['e'] == 'drop'), {})
    cut_text = capture[101][:drop.get('sent_of_line', 0)]
    around_ok = (at > 0 and kinds[at:at + 2] == ['closed', 'connected']
                 and body[at - 2][2] == capture[100] and body[at - 1][2] == cut_text
                 and body[at + 2][2] == capture[102])
    check('dropped connection: the two marker lines sit between the cut-off line and the first line after the drop',
          around_ok and kinds.count('connected') == 1 and kinds.count('closed') == 2,
          f'{kinds[max(0, at - 2):at + 3]} {body[at - 1] if at > 0 else ""}')
    texts = [item[2] for item in body if item[0] == 'data']
    want_texts = capture[:101] + [cut_text] + capture[102:]
    check(f'dropped connection: nothing lost or repeated. Lines 0 to 100, the {len(cut_text)} characters of line 101 that were sent, then lines 102 to 252',
          texts == want_texts, first_difference(texts, want_texts))
    check('dropped connection: the window said so, and said when it was back',
          'stopped answering' in run.screen and 'is back. Still saving to the same file.' in run.screen, run.screen[-500:])

    # -- a hard drop (TCP reset): bytes on their way may be lost, so this is
    # looser. At --speed 0 the reset throws away everything still unread in
    # the socket, so it runs at a pace the logger keeps up with.
    run = run_pair(tmp, 'reset', ['--speed', '10', '--drop-after', '60', '--away', '1', '--reset'], tcp=TCP_B)
    want, per_conn = expected_from_journal(run.events)
    header, body = check_run('hard drop', run)
    kinds = [item[0] for item in body]
    at = kinds.index('closed') if 'closed' in kinds else 0
    before = '\n'.join(item[2] for item in body[:at])
    sent_before = '\n'.join(text_of(part) for part in bytes(per_conn.get(1, b'')).split(b'\n'))
    after = [item[2] for item in body[at + 2:] if item[0] == 'data']
    check('hard drop: what was saved before it is the start of what was sent, with nothing changed or repeated',
          at > 0 and sent_before.startswith(before), f'{len(before)} characters saved, {len(sent_before)} sent')
    check('hard drop: the two markers are there and every line after the drop is saved',
          kinds[at:at + 2] == ['closed', 'connected'] and after == capture[61:], first_difference(after, capture[61:]))
    lost = len(sent_before) - len(before)
    check(f'hard drop: the reset cost only what was on its way ({lost} of the {len(sent_before)} characters sent before it, '
          f'at most the cut line and the one before it)',
          at > 0 and lost <= len(capture[59]) + len(capture[60]) + 2, f'{lost} characters lost')

    # -- bytes that are not UTF-8
    run = run_pair(tmp, 'bad-bytes', ['--speed', '0', '--bad-bytes', '--chunks'])
    want, _ = expected_from_journal(run.events)
    header, body = check_run('bad bytes', run, want)
    texts = [item[2] for item in body if item[0] == 'data']
    noise = '\ufffd\ufffd\ufffd line noise \ufffd( \ufffd'
    odd = '# note 21.5 \u00b0C, 3.3 V \u00b11 %, 40 \u00b5s, \u2713'
    check('bad bytes: the logger did not crash, the noise line is saved with replacement marks, and the lines around it are untouched',
          run.code == 0 and texts[5] == noise and texts[:5] == capture[:5] and texts[6:10] == capture[5:9],
          repr(texts[4:7]))
    check('bad bytes: a line of real UTF-8 that is not plain ASCII is saved unchanged, and all 255 lines are there',
          texts[10] == odd and len(texts) == 255 and texts[11:] == capture[9:], repr(texts[10]))

    # -- a line that sits unfinished
    run = run_pair(tmp, 'stall', ['--speed', '0', '--stall-at', '7', '--stall-s', '3.5'], tcp=TCP_B)
    want, _ = expected_from_journal(run.events)
    header, body = check_run('unfinished line', run, want)
    stall = next((ev for ev in run.events if ev['e'] == 'stall'), {})
    cut = stall.get('sent_of_line', 0)
    first_half = body[7] if len(body) > 8 else ('', '', '')
    second_half = body[8] if len(body) > 8 else ('', '', '')
    gap = 0.0
    if first_half[0] == 'data' and second_half[0] == 'data':
        gap = (datetime.datetime.fromisoformat(second_half[1]) - datetime.datetime.fromisoformat(first_half[1])).total_seconds()
    check('unfinished line: half a line that sits for 3.5 seconds is written by itself, and the rest follows when it comes',
          first_half[2] == capture[7][:cut] and second_half[2] == capture[7][cut:] and 0 < cut < len(capture[7]),
          f'{first_half} {second_half}')
    check(f'unfinished line: it was written about 2 seconds after it stopped ({3.5 - gap:.2f} s)', 1.2 <= gap <= 1.8, f'gap {gap}')

    # -- real time, the default file name, and --seconds
    before = set(os.listdir(LOGS_DIR)) if os.path.isdir(LOGS_DIR) else set()
    journal = os.path.join(tmp, 'pace.journal')
    screen = os.path.join(tmp, 'pace.screen.txt')
    fake = start_fake(TCP_A, journal, '--speed', '1')
    begin = now_local()
    with open(screen, 'wb') as screen_file:
        logger = start_logger(['--port', f'socket://127.0.0.1:{TCP_A}', '--seconds', '6.5'], screen_file, cwd=tempfile.gettempdir())
        code = wait_exit(logger, 20)
    end = now_local()
    wait_exit(fake, 10)
    made = sorted(set(os.listdir(LOGS_DIR)) - before) if os.path.isdir(LOGS_DIR) else []
    ours = [name for name in made if re.match(r'^backup-\d{4}-\d{2}-\d{2}-\d{6}\.log$', name)]
    check('default file: started from another folder with no --out, it made one file named flight-logs/backup-YYYY-MM-DD-HHMMSS.log in the website folder',
          len(ours) == 1, f'new files: {made}')
    if len(ours) == 1:
        path = os.path.join(LOGS_DIR, ours[0])
        header, body, problems = read_log(path)
        problems += header_problems(header, f'socket://127.0.0.1:{TCP_A}')
        started = re.match(f'^# started ({STAMP})$', header[1]) if len(header) > 1 else None
        name_time = datetime.datetime.strptime(ours[0], 'backup-%Y-%m-%d-%H%M%S.log')
        name_ok = started and abs((datetime.datetime.fromisoformat(started.group(1)).replace(tzinfo=None) - name_time).total_seconds()) < 2
        check('default file: the header is right and the name carries the time it started', not problems and name_ok, f'{problems} {header[:2]}')
        with open(screen, encoding='utf-8', errors='replace') as f:
            screen_text = f.read()
        check('--seconds 6.5: it stopped by itself with exit code 0, said so, and wrote "# connection closed" as the last line',
              code == 0 and 'Stopped after 6.5 seconds, as asked.' in screen_text and body and body[-1][0] == 'closed'
              and path in screen_text, f'code {code}, last {body[-1:]}, {screen_text[-300:]}')
        data = [item for item in body if item[0] == 'data']
        texts = [item[2] for item in data]
        check(f'real time: in about 6 seconds it saved the first {len(texts)} lines, in order',
              10 <= len(texts) <= 14 and texts == capture[:len(texts)], f'{len(texts)} lines')
        when = [datetime.datetime.fromisoformat(item[1]) for item in data]
        pkt_after = [(when[i] - when[i - 1]).total_seconds() for i in range(1, len(data)) if texts[i].startswith('PKT ')]
        period = [(when[i] - when[i - 2]).total_seconds() for i in range(2, len(data))]
        check('real time: the time prefixes follow the arrivals (a packet 0.1 s after its status line, each pair 1 s after the last)',
              pkt_after and all(0.05 <= d <= 0.2 for d in pkt_after) and all(0.9 <= d <= 1.1 for d in period),
              f'{[round(d, 3) for d in pkt_after]} {[round(d, 3) for d in period]}')
        check('real time: the times fall inside the run', not times_problems(body, begin, end), '; '.join(times_problems(body, begin, end)))
        os.remove(path)
        check('default file: the test removed the file it made in flight-logs/', not os.path.exists(path))

    # -- killed hard in the middle
    if WINDOWS:
        out = os.path.join(tmp, 'kill.log')
        journal = os.path.join(tmp, 'kill.journal')
        fake = start_fake(TCP_B, journal, '--speed', '20', '--chunks')
        logger = start_logger(['--port', f'socket://127.0.0.1:{TCP_B}', '--out', out, '--seconds', '60'], subprocess.PIPE)
        echo = Reader(logger.stdout)
        end_wait = time.monotonic() + 20
        while time.monotonic() < end_wait and sum(1 for line in list(echo.lines) if line.startswith('PKT ')) < 40:
            time.sleep(0.01)
        killed = subprocess.run(['taskkill', '/F', '/PID', str(logger.pid)], capture_output=True, text=True)
        code = wait_exit(logger, 10)
        echo.join(5)
        wait_exit(fake, 15)
        header, body, problems = read_log(out)
        problems += header_problems(header, f'socket://127.0.0.1:{TCP_B}')
        texts = [item[2] for item in body if item[0] == 'data']
        shown = [line for line in echo.lines if line.startswith('PKT ') or line.startswith('# DEKEL_RX')]
        check(f'hard kill: taskkill /F ended the logger in the middle (exit code {code})',
              killed.returncode == 0 and code not in (0, None), killed.stdout + killed.stderr)
        check(f'hard kill: the file is whole on disk. {len(texts)} complete lines, each with its time, ending with a line feed, no markers',
              not problems and len(texts) == len(body) and 60 <= len(texts) < 253 and texts == capture[:len(texts)],
              f'{problems[:2]} {len(texts)} data lines of {len(body)} items')
        check(f'hard kill: every line the window had shown ({len(shown)}) was already in the file',
              len(shown) >= 60 and shown == texts[:len(shown)], f'{len(shown)} shown, {len(texts)} in the file')
    else:
        print('SKIP  hard kill: taskkill is Windows only')

    # -- Ctrl+Break while lines are arriving
    out = os.path.join(tmp, 'break.log')
    journal = os.path.join(tmp, 'break.journal')
    screen = os.path.join(tmp, 'break.screen.txt')
    fake = start_fake(TCP_A, journal, '--speed', '10')
    with open(screen, 'wb') as screen_file:
        logger = start_logger(['--port', f'socket://127.0.0.1:{TCP_A}', '--out', out, '--seconds', '30'], screen_file)
        end_wait = time.monotonic() + 15
        while time.monotonic() < end_wait and not (os.path.exists(out) and os.path.getsize(out) > 6000):
            time.sleep(0.02)
        began = time.monotonic()
        sent = ask_to_stop(logger)
        code = wait_exit(logger, 10)
        took = time.monotonic() - began
    wait_exit(fake, 15)
    header, body, problems = read_log(out)
    texts = [item[2] for item in body if item[0] == 'data']
    whole = texts[:-1] == capture[:len(texts) - 1] and texts and capture[len(texts) - 1].startswith(texts[-1])
    check(f'Ctrl+Break while lines arrive: it stopped in {took:.1f} s with exit code 0',
          sent and code == 0 and took < 3, f'sent {sent}, code {code}')
    check('Ctrl+Break: the file ends with "# connection closed", and every line before it is whole and in order (the last may be one cut off by the stop)',
          not problems and body and body[-1][0] == 'closed' and [item[0] for item in body].count('closed') == 1 and whole,
          f'{problems[:2]} {body[-2:]}')

    # -- a window nobody reads (the same as a console paused by a click)
    out = os.path.join(tmp, 'unread.log')
    journal = os.path.join(tmp, 'unread.journal')
    fake = start_fake(TCP_B, journal, '--speed', '0')
    logger = start_logger(['--port', f'socket://127.0.0.1:{TCP_B}', '--out', out, '--seconds', '5'], subprocess.PIPE)
    code = wait_exit(logger, 25)
    wait_exit(fake, 10)
    printed = logger.stdout.read() if code is not None else b''
    header, body, problems = read_log(out)
    texts = [item[2] for item in body if item[0] == 'data']
    check('output nobody reads: the file still has all 253 lines and the logger still exits with code 0',
          code == 0 and texts == capture and not problems, f'code {code}, {len(texts)} lines, {problems[:2]}')
    stuck = len(printed) < sum(len(line) + 1 for line in capture)
    print(f'      (the pipe took {len(printed):,} bytes of output before it filled'
          f'{", so the window really was stuck" if stuck else ". It never filled, so this run did not prove the stuck case"})')


# ------------------------------------------------------------------
# The sample file
# ------------------------------------------------------------------

def make_sample(tmp):
    section('The sample: a real-time run with one dropped connection (a little over two minutes)')
    os.makedirs(LOGS_DIR, exist_ok=True)
    if os.path.exists(SAMPLE):
        os.remove(SAMPLE)       # the logger adds to a file that is there, and the sample must be one run
    journal = os.path.join(tmp, 'sample.journal')
    screen = os.path.join(tmp, 'sample.screen.txt')
    port = f'socket://127.0.0.1:{TCP_A}'
    begin = now_local()
    fake = start_fake(TCP_A, journal, '--speed', '1', '--chunks', '--drop-after', '120', '--away', '3')
    with open(screen, 'wb') as screen_file:
        logger = start_logger(['--port', port, '--out', SAMPLE, '--seconds', '300'], screen_file)
        fake_code = wait_exit(fake, 200)
        saw_end = wait_for_tail(SAMPLE, CLOSED_RE, 10)
        sent = ask_to_stop(logger)
        code = wait_exit(logger, 10 if sent else 310)
    end = now_local()
    with open(screen, encoding='utf-8', errors='replace') as f:
        screen_text = f.read()
    run = types.SimpleNamespace(out=SAMPLE, port=port, begin=begin, end=end, code=code, fake_code=fake_code,
                                saw_end=saw_end, stop_sent=sent, events=read_journal(journal), screen=screen_text)
    want, _ = expected_from_journal(run.events)
    header, body = check_run('sample', run, want)
    data = [item for item in body if item[0] == 'data']
    packets = [item for item in data if item[2].startswith('PKT ')]
    whole_packets = [item for item in packets if ' missed=' in item[2]]
    print(f'\n      {SAMPLE}')
    print(f'      {len(body) + len(header)} lines: 4 header lines, {len(data)} data lines '
          f'({len(packets)} start with "PKT ", {len(whole_packets)} of those are whole), '
          f'{sum(1 for item in body if item[0] == "closed")} "# connection closed", '
          f'{sum(1 for item in body if item[0] == "connected")} "# connected"')
    if data:
        print(f'      first data line at {data[0][1]}, last at {data[-1][1]}')


# ------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Checks the backup logger with no board.')
    parser.add_argument('--quick', action='store_true', help='only the checks that run inside this program')
    parser.add_argument('--sample', action='store_true', help='only write flight-logs/backup-sample-from-test.log')
    parser.add_argument('--keep', action='store_true', help='keep the scratch folder and say where it is')
    args = parser.parse_args()

    tmp = tempfile.mkdtemp(prefix='backup-logger-test-')
    try:
        if args.sample:
            make_sample(tmp)
        else:
            inside_checks(tmp)
            if not args.quick:
                real_checks(tmp)
    finally:
        for proc in children:
            if proc.poll() is None:
                proc.kill()
        if args.keep:
            print(f'\nThe scratch folder is {tmp}')
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    failed = [name for name, ok in results if not ok]
    print(f'\n{len(results) - len(failed)} of {len(results)} checks passed.')
    if failed:
        print('FAILED:')
        for name in failed:
            print(f'  {name}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
