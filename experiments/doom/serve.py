#!/usr/bin/env python3
"""Local playable demo: every STEP executes the RV32 contract in a fresh VM."""
import argparse
import json
import struct
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'build')
    parser.add_argument('--wad', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    log = (args.build_dir / 'server.log').open('w')
    proc = subprocess.Popen([str(args.build_dir / 'runner'), str(args.build_dir / 'doom.rv32a'),
                             str(args.wad.resolve()), str(args.build_dir / 'interactive'), '--serve'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    lock = threading.Lock()

    def read_frame():
        line = proc.stdout.readline()
        if not line.startswith('FRAME '):
            raise RuntimeError(line.strip() or 'runner stopped; see server.log')
        _, tick, gas, reads, writes, ms, pixels = line.split()
        frame = bytes.fromhex(pixels)
        if len(frame) != 64768:
            raise RuntimeError('invalid framebuffer size')
        return (struct.pack('<IQQQd', int(tick), int(gas), int(reads), int(writes), float(ms)) + frame)

    try:
        current = read_frame()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *unused):
                pass

            def send(self, data, mime, status=200):
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == '/':
                    self.send((ROOT / 'viewer.html').read_bytes(), 'text/html; charset=utf-8')
                elif self.path == '/info':
                    self.send(b'{"mode":"vm"}', 'application/json')
                elif self.path == '/frame':
                    with lock:
                        self.send(current, 'application/octet-stream')
                else:
                    self.send(b'not found', 'text/plain', 404)

            def do_POST(self):
                nonlocal current
                if self.path != '/step':
                    self.send(b'not found', 'text/plain', 404)
                    return
                # JSON content type prevents ordinary cross-origin form posts.
                if self.headers.get('Content-Type') != 'application/json':
                    self.send(b'expected JSON', 'text/plain', 415)
                    return
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 512:
                        raise ValueError('invalid request length')
                    body = json.loads(self.rfile.read(size))
                    tick, keys = body['tick'], body['keys']
                    if type(tick) is not int or not 0 <= tick < 10000000 or not isinstance(keys, str) or len(keys) != 64:
                        raise ValueError('invalid tick/keys')
                    if any(c not in '0123456789abcdefABCDEF' for c in keys):
                        raise ValueError('invalid key bitmap')
                    with lock:
                        if tick != struct.unpack_from('<I', current)[0]:
                            self.send(b'stale tick; reload frame', 'text/plain', 409)
                            return
                        proc.stdin.write(f'STEP {tick} {keys.lower()}\n')
                        proc.stdin.flush()
                        current = read_frame()
                        self.send(current, 'application/octet-stream')
                except (ValueError, KeyError, TypeError) as exc:
                    self.send(str(exc).encode(), 'text/plain', 400)
                except RuntimeError as exc:
                    self.send(str(exc).encode(), 'text/plain', 500)

        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
        print(f'Play at http://127.0.0.1:{args.port} (local RV32 demo, not a node)', flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log.close()


if __name__ == '__main__':
    main()
