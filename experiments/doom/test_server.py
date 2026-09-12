#!/usr/bin/env python3
"""Smoke-test the playable HTTP bridge against real RV32 contract execution."""
import argparse
import http.client
import json
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'build')
    parser.add_argument('--wad', type=Path, required=True)
    args = parser.parse_args()
    proc = subprocess.Popen([sys.executable, str(ROOT / 'serve.py'), '--build-dir', str(args.build_dir),
                             '--wad', str(args.wad), '--port', '8877'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    def request(method, path, body=None, mime='application/json'):
        conn = http.client.HTTPConnection('127.0.0.1', 8877, timeout=10)
        conn.request(method, path, body, {'Content-Type': mime})
        res = conn.getresponse()
        data = res.read()
        status = res.status
        conn.close()
        return status, data

    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode())
            try:
                status, first = request('GET', '/frame')
                break
            except ConnectionRefusedError:
                time.sleep(.05)
        else:
            raise RuntimeError('server did not become ready')
        assert status == 200 and len(first) == 64804
        tick = struct.unpack_from('<I', first)[0]
        status, html = request('GET', '/')
        assert status == 200 and b'<canvas' in html
        keys = bytearray(32)
        keys[0xad // 8] |= 1 << (0xad % 8)
        body = json.dumps({'tick': tick, 'keys': keys.hex()})
        status, moved = request('POST', '/step', body)
        assert status == 200 and len(moved) == 64804
        assert struct.unpack_from('<I', moved)[0] == tick + 1 and moved[36:] != first[36:]
        assert request('POST', '/step', body)[0] == 409
        assert request('POST', '/step', '{')[0] == 400
        assert request('POST', '/step', json.dumps({'tick': tick + 1, 'keys': ' ' * 64}))[0] == 400
        assert request('POST', '/step', body, 'text/plain')[0] == 415
        assert request('GET', '/frame')[1] == moved
        print('PASS: HTTP frame, rendered movement, stale-tick rejection, invalid inputs, unchanged state after rejects')
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


if __name__ == '__main__':
    main()
