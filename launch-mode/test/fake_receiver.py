"""fake_receiver.py: a stand-in for the receiver board, so the backup logger
(launch-mode/backup_logger.py) can be tested with no hardware.

It is a small TCP server on this computer only (127.0.0.1). Whoever
connects gets the lines of a real capture from the receiver
(flight-console/test/radio-board-rx-capture.log), sent at the pace of the
lines' own clocks: a "# DEKEL_RX" status line each second and a "PKT" line
a tenth of a second after it. The logger reads it through pyserial's
socket:// port:
  python launch-mode/test/fake_receiver.py --port 8116
  python launch-mode/backup_logger.py --port socket://127.0.0.1:8116

One client at a time, like a serial port. A new client starts the capture
from the top. When the capture ends the connection is closed.

It can also misbehave on purpose:
  --speed 10         ten times faster than the clocks. 0 sends with no waiting.
  --chunks           sends in odd-sized pieces that are cut in the middle of
                     lines and can end one line and begin the next, the way
                     USB delivers them.
  --drop-after N     after N lines it sends the first half of the next line,
                     closes the connection, stays away for --away seconds,
                     and then carries on with the line after the cut one when
                     the client comes back. The second half of the cut line
                     is never sent, like a cable pulled in the middle of a line.
  --reset            makes that drop a hard one (a TCP reset). Bytes still on
                     their way can be lost, so the journal is then only an
                     upper limit on what arrived.
  --stall-at N       stops for --stall-s seconds in the middle of line N, then
                     sends the rest of it.
  --bad-bytes        adds a line of bytes that are not valid UTF-8, and a line
                     of valid UTF-8 that is not plain ASCII.
  --lf               ends lines with LF only. The default is CR LF, which is
                     what a board's println sends.
  --journal FILE     writes down exactly what was sent, as JSON lines, so a
                     test can tell what the logger should have saved.
  --once             stops after the first client is done. Without it the
                     server keeps going until Ctrl+C.

Line numbers (N) count from 0 and include the lines --bad-bytes adds.

Used by: launch-mode/test/backup_logger_test.py, and by hand to try
backup-logger.bat with no board.
"""

import argparse
import json
import os
import random
import re
import socket
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CAPTURE = os.path.join(ROOT, 'flight-console', 'test', 'radio-board-rx-capture.log')
HOST = '127.0.0.1'      # this computer only
PKT_AFTER_STATUS_S = 0.1

# The two lines --bad-bytes adds. The first is not valid UTF-8 anywhere it
# matters: stray lead bytes, stray continuation bytes and a cut-off character.
BAD_LINE = b'\xff\xfe\x80 line noise \xc3\x28 \xe2\x82'
ODD_LINE = '# note 21.5 °C, 3.3 V ±1 %, 40 µs, ✓'.encode('utf-8')
BAD_AT = 5      # they go in before these lines of the capture
ODD_AT = 9


# ------------------------------------------------------------------
# What to send, and when
# ------------------------------------------------------------------

def load_capture(path):
    """The capture's lines as bytes, without their line endings."""
    with open(path, 'rb') as f:
        lines = f.read().split(b'\n')
    if lines and lines[-1] == b'':
        lines.pop()
    return [line[:-1] if line.endswith(b'\r') else line for line in lines]


def line_times(lines):
    """When each line goes out, in seconds after the first, by the lines' own clocks.

    A status line carries the receiver's clock (rx_up_s) and how long ago the
    last packet came (last_good_s_ago). So a status line goes out at its
    rx_up_s, and the packet before it at that time less last_good_s_ago. A
    line with no clock to go by follows the line before it.
    """
    status = {}
    for i, line in enumerate(lines):
        up = re.search(rb'\brx_up_s=([0-9.]+)', line)
        if line.startswith(b'# ') and up:
            ago = re.search(rb'\blast_good_s_ago=([0-9.]+)', line)
            status[i] = (float(up.group(1)), float(ago.group(1)) if ago else None)

    times = [None] * len(lines)
    for i, (up, _) in status.items():
        times[i] = up
    later = sorted(status)
    for i, line in enumerate(lines):
        if times[i] is not None or not line.startswith(b'PKT '):
            continue
        after = next((j for j in later if j > i), None)
        if after is not None and status[after][1] is not None:
            times[i] = status[after][0] - status[after][1]

    # Fill the gaps and keep the times from going backwards.
    out = []
    last = None
    for i, t in enumerate(times):
        if t is None:
            t = 0.0 if last is None else last + (PKT_AFTER_STATUS_S if lines[i].startswith(b'PKT ') else 0.0)
        if last is not None and t < last:
            t = last
        out.append(t)
        last = t
    first = out[0] if out else 0.0
    return [t - first for t in out]


def build_script(args):
    """The list of (when, line) to play."""
    lines = load_capture(args.capture)
    times = line_times(lines)
    script = []
    for i, line in enumerate(lines):
        if args.bad_bytes and i == BAD_AT:
            script.append((times[i], BAD_LINE))
        if args.bad_bytes and i == ODD_AT:
            script.append((times[i], ODD_LINE))
        script.append((times[i], line))
    return script


# ------------------------------------------------------------------
# Sending
# ------------------------------------------------------------------

class Journal:
    """Writes down what really went out, one JSON object per line."""

    def __init__(self, path):
        self._file = open(path, 'w', encoding='utf-8') if path else None

    def write(self, **event):
        if self._file:
            self._file.write(json.dumps(event) + '\n')
            self._file.flush()


class ClientLeft(Exception):
    pass


class Player:
    def __init__(self, args, script, journal):
        self.args = args
        self.script = script
        self.journal = journal
        self.rng = random.Random(args.seed)
        self.ending = b'\n' if args.lf else b'\r\n'
        self.dropped = False        # the one planned drop has happened
        self.conn_number = 0

    def play(self, conn, start_at):
        """Sends lines from start_at on. Returns ('done' | 'dropped' | 'left', the next line's number)."""
        args = self.args
        self.conn_number += 1
        self.journal.write(e='connect', conn=self.conn_number, first_line=start_at)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        # The clock is set so that the first line to send is due now.
        zero = time.monotonic() - self._due(start_at)
        carry = b''     # the end of a line, held back to go out with the start of the next
        i = start_at
        try:
            while i < len(self.script):
                self._wait_until(zero + self._due(i))
                payload = self.script[i][1] + self.ending

                if args.drop_after is not None and i == args.drop_after and not self.dropped:
                    cut = max(1, len(self.script[i][1]) // 2)
                    self._send(conn, carry + payload[:cut])
                    self.dropped = True
                    self.journal.write(e='drop', conn=self.conn_number, line=i, sent_of_line=cut, reset=bool(args.reset))
                    self._close(conn, hard=args.reset)
                    return 'dropped', i + 1

                if args.stall_at is not None and i == args.stall_at:
                    cut = max(1, len(self.script[i][1]) // 2)
                    self._send(conn, carry + payload[:cut])
                    carry = b''
                    self.journal.write(e='stall', conn=self.conn_number, line=i, sent_of_line=cut, seconds=args.stall_s)
                    time.sleep(args.stall_s)
                    zero += args.stall_s
                    payload = payload[cut:]

                data = carry + payload
                carry = b''
                if args.chunks:
                    # Hold back the tail of this line when the next one is due
                    # straight away, so one piece ends a line and begins the next.
                    soon = i + 1 < len(self.script) and self._due(i + 1) - self._due(i) < 0.05
                    if soon and len(data) > 1 and self.rng.random() < 0.6:
                        keep = self.rng.randint(1, min(len(data) - 1, 30))
                        data, carry = data[:-keep], data[-keep:]
                    while data:
                        size = self.rng.randint(1, 61)
                        self._send(conn, data[:size])
                        data = data[size:]
                        if data and args.speed > 0:
                            time.sleep(self.rng.uniform(0.001, 0.008))
                else:
                    self._send(conn, data)
                i += 1
            if carry:
                self._send(conn, carry)
        except ClientLeft:
            self.journal.write(e='client-left', conn=self.conn_number, line=i)
            try:
                conn.close()
            except OSError:
                pass
            return 'left', i
        self.journal.write(e='done', conn=self.conn_number, lines=len(self.script))
        self._close(conn, hard=False)
        return 'done', len(self.script)

    def _due(self, i):
        if self.args.speed <= 0:
            return 0.0
        return self.script[i][0] / self.args.speed

    @staticmethod
    def _wait_until(when):
        left = when - time.monotonic()
        if left > 0:
            time.sleep(left)

    def _send(self, conn, data):
        if not data:
            return
        try:
            conn.sendall(data)
        except OSError as err:
            raise ClientLeft() from err
        self.journal.write(e='send', conn=self.conn_number, hex=data.hex())

    @staticmethod
    def _close(conn, hard):
        """A soft close lets everything sent arrive first. A hard one is a TCP reset."""
        try:
            if hard:
                linger = struct.pack('HH', 1, 0) if os.name == 'nt' else struct.pack('ii', 1, 0)
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
            else:
                conn.shutdown(socket.SHUT_WR)
                conn.settimeout(2.0)
                while conn.recv(4096):
                    pass
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass


def listen(port):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind((HOST, port))
    server.listen(1)
    return server


def say(text):
    print(f'fake receiver: {text}', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Plays a capture of the receiver board over TCP, for testing the backup logger.')
    parser.add_argument('--port', type=int, default=8116, help='the TCP port on 127.0.0.1 (default 8116)')
    parser.add_argument('--capture', default=CAPTURE, help='the capture file to play')
    parser.add_argument('--speed', type=float, default=1.0, help='1 is the pace of the lines\' own clocks, 10 is ten times faster, 0 does not wait at all')
    parser.add_argument('--chunks', action='store_true', help='send in odd-sized pieces cut in the middle of lines')
    parser.add_argument('--seed', type=int, default=1, help='the seed for the piece sizes')
    parser.add_argument('--drop-after', type=int, help='drop the connection in the middle of this line (counted from 0)')
    parser.add_argument('--away', type=float, default=3.0, help='seconds to stay away after the drop (default 3)')
    parser.add_argument('--reset', action='store_true', help='make the drop a TCP reset')
    parser.add_argument('--stall-at', type=int, help='stop for a while in the middle of this line (counted from 0)')
    parser.add_argument('--stall-s', type=float, default=3.0, help='how long the stall lasts (default 3)')
    parser.add_argument('--bad-bytes', action='store_true', help='add a line that is not valid UTF-8 and a line that is not plain ASCII')
    parser.add_argument('--lf', action='store_true', help='end lines with LF only, not CR LF')
    parser.add_argument('--journal', help='a file to write down what was sent, as JSON lines')
    parser.add_argument('--once', action='store_true', help='stop after the first client is done')
    args = parser.parse_args(argv)

    script = build_script(args)
    journal = Journal(args.journal)
    player = Player(args, script, journal)
    server = listen(args.port)
    say(f'listening on {HOST}:{args.port} with {len(script)} lines to play')
    resume_at = None
    try:
        while True:
            conn, _ = server.accept()
            start_at = resume_at if resume_at is not None else 0
            resume_at = None
            say(f'a client connected, sending from line {start_at}')
            outcome, next_line = player.play(conn, start_at)
            if outcome == 'dropped':
                say(f'dropped the connection in the middle of line {next_line - 1}, away for {args.away:g} seconds')
                server.close()
                time.sleep(args.away)
                server = listen(args.port)
                resume_at = next_line
                say('back and listening')
                continue
            if outcome == 'left':
                say(f'the client left at line {next_line}')
            else:
                say(f'played all {len(script)} lines')
            if args.once:
                break
    except KeyboardInterrupt:
        say('stopped')
    finally:
        server.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
