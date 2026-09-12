#!/usr/bin/env python3
"""Exercise the real node launcher and HTTP gameplay; optionally test restart.

Pass the same binary arguments as run_node.py. Use a fresh --data-dir.
"""
import argparse
import json
import signal
import statistics
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'build/smoke-node')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--ticks', type=int, default=35)
    parser.add_argument('--restart', action='store_true', help='Also probe node recovery (known failure on the pinned build)')
    args, launcher_args = parser.parse_known_args()
    args.data_dir = args.data_dir.resolve()
    if args.data_dir.exists() or args.ticks <= 0:
        parser.error('use a fresh --data-dir and a positive tick count')
    args.data_dir.mkdir(parents=True)
    base = f'http://127.0.0.1:{args.port}'
    command = [sys.executable, str(ROOT / 'run_node.py'),
               '--data-dir', str(args.data_dir), '--port', str(args.port), *launcher_args]

    def get(path):
        with urllib.request.urlopen(base + path, timeout=60) as response:
            return response.read()

    def post(body):
        request = urllib.request.Request(base + '/step', json.dumps(body).encode(),
                                         {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code >= 500:
                raise RuntimeError(exc.read().decode()) from exc
            raise

    def start():
        child = subprocess.Popen(command)
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline and child.poll() is None:
            try:
                assert json.loads(get('/info'))['mode'] == 'node'
                frame = get('/frame')
                assert len(frame) == 64804
                return child, frame
            except (OSError, ValueError):
                time.sleep(0.25)
        stop(child)
        raise RuntimeError('Live app failed to start; inspect node.log in the data directory')

    def stop(child):
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
            child.wait(timeout=50)

    child, initial = start()
    frame = initial
    timings = []
    try:
        assert b'<canvas' in get('/')
        for index in range(args.ticks):
            tick = struct.unpack_from('<I', frame)[0]
            keys = bytearray(32)
            key = 0xad if index < 20 else 0xae
            keys[key >> 3] |= 1 << (key & 7)
            began = time.perf_counter()
            frame = post({'tick': tick, 'keys': keys.hex()})
            timings.append((time.perf_counter() - began) * 1000)
            assert len(frame) == 64804 and struct.unpack_from('<I', frame)[0] == tick + 1
        assert initial[36:] != frame[36:]
        for body, status in [({'tick': tick, 'keys': '00' * 32}, 409),
                             ({'tick': tick + 1, 'keys': 'invalid'}, 400)]:
            try:
                post(body)
                raise AssertionError('invalid request accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == status
        assert get('/frame') == frame
        session = json.loads((args.data_dir / 'session.json').read_text())
        (args.data_dir / 'initial.bin').write_bytes(initial)
        (args.data_dir / 'gameplay.bin').write_bytes(frame)
        (args.data_dir / 'http-timings.json').write_text(json.dumps(timings) + '\n')
    finally:
        stop(child)
    if args.restart:
        print('Gameplay passed; restarting the persistent node', flush=True)
        child, resumed = start()
        try:
            assert resumed == frame
            tick = struct.unpack_from('<I', resumed)[0]
            final = post({'tick': tick, 'keys': '00' * 32})
            assert struct.unpack_from('<I', final)[0] == tick + 1
            after = json.loads((args.data_dir / 'session.json').read_text())
            assert after['transactions'][:-1] == session['transactions']
        finally:
            stop(child)
    transactions = [r['wallMs'] for r in session['transactions'] if r['method'] == 2]
    summary = dict(ticks=args.ticks, contract=session['contract'], frameBytes=len(frame),
        transactionMs=dict(median=statistics.median(transactions), min=min(transactions), max=max(transactions)),
        httpInputToFrameMs=dict(median=statistics.median(timings), min=min(timings), max=max(timings)),
        checks=['committed gameplay', 'changed pixels', 'stale input rejection',
                'malformed input rejection'] + (['persistent restart', 'continued play after restart'] if args.restart else []))
    (args.data_dir / 'initial.bin').write_bytes(initial)
    (args.data_dir / 'gameplay.bin').write_bytes(frame)
    (args.data_dir / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
