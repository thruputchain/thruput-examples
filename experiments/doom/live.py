#!/usr/bin/env python3
"""Deploy Doom to a local Groundhog node and serve its committed frames."""
import argparse
import hashlib
import json
import struct
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = 32768
UPLOAD = 2048


class LiveGame:
    def __init__(self, args):
        self.args = args
        self.address = args.contract
        self.wallet_args = ['--wallet', args.wallet] if args.wallet else []
        self.from_args = ['--from', args.wallet] if args.wallet else []
        self.signer = None
        self.signer_address = None
        self.signer_funded = False
        self.network_hash = None
        if args.signer:
            if not args.runtime_manifest:
                raise ValueError('--signer requires --runtime-manifest')
            self.network_hash = json.loads(args.runtime_manifest.read_text())['networkHash']
            self.signer = subprocess.Popen([str(args.signer)], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, text=True, bufsize=1)
            self.signer_address = json.loads(self.signer.stdout.readline())['accountAddress']
        self.last_tx = None
        self.last_ms = 0.0
        self.receipts = []
        self.artifact_sha = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
        self.wad_sha = hashlib.sha256(args.wad.read_bytes()).hexdigest()
        if self.address and args.output.exists():
            session = json.loads(args.output.read_text())
            if session['contract'] != self.address:
                raise ValueError('Session file belongs to a different contract')
            if (session['artifactSha256'] != self.artifact_sha
                    or session['wadSha256'] != self.wad_sha):
                raise ValueError('Resume requires the original artifact and WAD')
            self.receipts = session['transactions']
            self.signer_funded = (session.get('signerAddress') == self.signer_address
                                  and session.get('signerFunded', False))
            if self.receipts:
                self.last_tx = self.receipts[-1]['txHash']
                self.last_ms = self.receipts[-1]['wallMs']
        self.target = ['--profile', args.profile, '--rpc-url', args.rpc_url]
        if args.runtime_manifest:
            self.target += ['--runtime-manifest', str(args.runtime_manifest.resolve())]

    def cli(self, *argv):
        result = subprocess.run([str(self.args.groundhog), '--json', *argv, *self.target],
                                capture_output=True, text=True, timeout=120, cwd=ROOT)
        try:
            output = json.loads(result.stdout or result.stderr)
        except ValueError as exc:
            raise RuntimeError(result.stderr[-4000:] or result.stdout[-4000:]) from exc
        if result.returncode or not output.get('ok'):
            raise RuntimeError(json.dumps(output) + '\n' + result.stderr[-4000:])
        return output['data']

    def rpc(self, method, params):
        request = urllib.request.Request(self.args.rpc_url,
            json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'groundhog_' + method,
                        'params': params}).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        if 'error' in result:
            raise RuntimeError(json.dumps(result['error']))
        return result['result']

    def storage(self, domain, index):
        key = b'groundhog-doom-v' + struct.pack('<II', domain, index) + bytes(8)
        result = self.rpc('getStorageAt', [self.address, '0x' + key.hex()])
        item = result['item']
        if item is None:
            return result['blockHeight'], None
        if item['kind'] != 'bytestring':
            raise RuntimeError('Doom storage item has an unexpected type')
        return result['blockHeight'], bytes.fromhex(item['bytes'].removeprefix('0x'))

    def call(self, method, calldata=b'', gas=50_000_000):
        started = time.perf_counter()
        # Use the Rust signing library and codec. Poll directly to avoid the CLI's
        # normal 100 ms receipt polling interval in a sequential game loop.
        if self.signer:
            tip = self.rpc('chainTip', [])
            request = dict(address=self.address, entrypoint='0x' + struct.pack('>Q', method).hex(),
                calldata='0x' + calldata.hex(), networkHash=self.network_hash,
                gasLimit=gas, expiryHeight=int(tip['height']) + 1000, nonce=time.time_ns())
            self.signer.stdin.write(json.dumps(request) + '\n')
            self.signer.stdin.flush()
            response = self.signer.stdout.readline()
            if not response:
                raise RuntimeError('Pubkey signer stopped')
            signed = json.loads(response)
            if 'error' in signed:
                raise RuntimeError(signed['error'])
        else:
            signed = self.cli('call', self.address, '0x' + struct.pack('>Q', method).hex(),
                              '0x' + calldata.hex(), *self.wallet_args,
                              '--gas-limit', str(gas), '--dry-run')
        tx = self.rpc('sendRawTransaction', [signed['signedTx']])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            receipt = self.rpc('getTransactionReceipt', [tx])
            if receipt is not None:
                break
            time.sleep(0.002)
        else:
            raise RuntimeError(f'Timed out waiting for {tx}; inspect the receipt before retrying')
        elapsed = (time.perf_counter() - started) * 1000
        record = {'method': method, 'txHash': tx, 'height': receipt['height'],
                  'status': receipt['status'], 'wallMs': elapsed, 'gasBudget': gas, 'auth': 'pubkey' if self.signer else 'dev-wallet'}
        self.receipts.append(record)
        self.last_tx, self.last_ms = tx, elapsed
        self.save()
        if receipt['status']['result'] != 'ok':
            try:
                detail = self.rpc('dev_getTransactionDetail', [tx])
                self.args.output.with_suffix('.failure.json').write_text(json.dumps(detail, indent=2))
            except (RuntimeError, OSError) as exc:
                print("Transaction detail unavailable:", exc, flush=True)
            raise RuntimeError('Contract transaction failed: ' + json.dumps(receipt))
        return receipt

    def save(self):
        path = self.args.output
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps({'rpcUrl': self.args.rpc_url, 'contract': self.address,
            'signerAddress': self.signer_address, 'signerFunded': self.signer_funded,
            'artifactSha256': self.artifact_sha,
            'wadSha256': self.wad_sha,
            'transactions': self.receipts}, indent=2) + '\n')
        temp.replace(path)

    def initialize(self):
        if not self.address:
            deployed = self.cli('deploy', '--artifact', str(self.args.artifact.resolve()),
                                *self.wallet_args, '--force')
            self.address = deployed['address']
            self.save()
            print(f'Deployed {self.address}', flush=True)
            self.cli('transfer', self.address, self.args.funding, *self.from_args, '--force')
        if self.signer and not self.signer_funded:
            # The native root wallet also needs storage tokens for replay entries.
            self.cli('transfer', self.signer_address, '100', *self.from_args, '--force')
            self.signer_funded = True
            self.save()
        _, meta = self.storage(0, 0)
        if meta is not None:
            return
        wad = self.args.wad.read_bytes()
        if self.signer:
            _, completed = self.storage(0, 1)
            count, size = struct.unpack('<II', completed) if completed else (0, len(wad))
            if size != len(wad) or count > (len(wad) + PAGE - 1) // PAGE:
                raise RuntimeError('Existing upload does not match this WAD')
            if self.storage(0, 2)[1] is not None:
                raise RuntimeError('Resume a fragment upload without --signer')
            for index in range(count):
                if self.storage(1, index)[1] != wad[index * PAGE:(index + 1) * PAGE]:
                    raise RuntimeError('Existing uploaded WAD page differs')
            for index in range(count, (len(wad) + PAGE - 1) // PAGE):
                self.call(0, struct.pack('<II', index, len(wad)) + wad[index * PAGE:(index + 1) * PAGE])
                if index % 16 == 0:
                    print(f'Uploaded WAD page {index + 1}/{(len(wad) + PAGE - 1) // PAGE}', flush=True)
            self.call(1, gas=200_000_000)
            print(f'Initialized E1M1: transaction {self.last_tx}', flush=True)
            return
        _, progress = self.storage(0, 2)
        offset, size = struct.unpack('<II', progress) if progress else (0, len(wad))
        if size != len(wad) or offset > len(wad):
            raise RuntimeError('Existing upload does not match this WAD')
        for page_start in range(0, offset, PAGE):
            if self.storage(1, page_start // PAGE)[1] != wad[page_start:min(page_start + PAGE, offset)]:
                raise RuntimeError('Existing uploaded WAD page differs')
        for start in range(offset, len(wad), UPLOAD):
            self.call(5, struct.pack('<II', start, len(wad)) + wad[start:start + UPLOAD])
            if start % (32 * UPLOAD) == 0 or start + UPLOAD >= len(wad):
                print(f'Uploaded WAD {min(start + UPLOAD, len(wad))}/{len(wad)} bytes', flush=True)
        self.call(1, gas=200_000_000)
        print(f'Initialized E1M1: transaction {self.last_tx}', flush=True)

    def frame(self, minimum_tick=0):
        # Each read reports its committed height. Never combine pages from
        # different snapshots, including when another client advances the game.
        deadline = time.monotonic() + 1
        failure = RuntimeError('No consistent committed frame was available')
        while time.monotonic() < deadline:
            try:
                height, meta = self.storage(0, 0)
                h0, first = self.storage(3, 0)
                h1, second = self.storage(3, 1)
                if height == h0 == h1:
                    if meta is None or len(meta) != 80 or first is None or second is None:
                        raise RuntimeError('Game is not initialized')
                    pixels = first + second
                    if len(pixels) != 64768:
                        raise RuntimeError('Invalid committed frame size')
                    tick = struct.unpack_from('<I', meta, 4)[0]
                    if tick >= minimum_tick:
                        return struct.pack('<IQQQd', tick, int(height), 0, 0, self.last_ms) + pixels
            except RuntimeError as exc:
                # A concurrent commit can invalidate a gateway read snapshot.
                # Retry reads only; never resubmit a successful game transaction.
                failure = exc
            time.sleep(0.005)
        raise failure

    def step(self, tick, keys):
        self.call(2, struct.pack('<I', tick) + keys)
        return self.frame(tick + 1)


def serve(game, port):
    lock = threading.Lock()

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
            try:
                if self.path == '/':
                    self.send((ROOT / 'viewer.html').read_bytes(), 'text/html; charset=utf-8')
                elif self.path == '/info':
                    self.send(json.dumps({'mode': 'node', 'contract': game.address,
                        'about': 'Original Doom, Episode 1. Every tick is a signed transaction '
                                 'executed by the local Groundhog node. The browser displays '
                                 'pixels read from committed contract storage. Target: 35 ticks/s.',
                        'footer': 'Time includes signing, RPC submission and receipt polling. '
                                  'It is not isolated VM time. Actual gas used is not exposed '
                                  'by the receipt API.'}).encode(), 'application/json')
                elif self.path == '/frame':
                    with lock:
                        self.send(game.frame(), 'application/octet-stream')
                else:
                    self.send(b'not found', 'text/plain', 404)
            except (RuntimeError, OSError) as exc:
                self.send(str(exc).encode(), 'text/plain', 500)

        def do_POST(self):
            if self.path != '/step':
                self.send(b'not found', 'text/plain', 404)
                return
            if self.headers.get('Content-Type') != 'application/json':
                self.send(b'expected JSON', 'text/plain', 415)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 512:
                    raise ValueError('invalid request length')
                body = json.loads(self.rfile.read(length))
                tick, raw_keys = body['tick'], body['keys']
                if type(tick) is not int or not 0 <= tick < 10000000:
                    raise ValueError('invalid tick')
                if not isinstance(raw_keys, str) or len(raw_keys) != 64:
                    raise ValueError('invalid keys')
                keys = bytes.fromhex(raw_keys)
                if len(keys) != 32:
                    raise ValueError('invalid key bitmap')
                with lock:
                    current = struct.unpack_from('<I', game.frame())[0]
                    if current != tick:
                        self.send(b'stale tick; reload frame', 'text/plain', 409)
                        return
                    self.send(game.step(tick, keys), 'application/octet-stream')
            except (ValueError, KeyError, TypeError) as exc:
                self.send(str(exc).encode(), 'text/plain', 400)
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
                self.send(str(exc).encode(), 'text/plain', 500)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Play at http://127.0.0.1:{port} (live local Groundhog node)', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--groundhog', default='groundhog')
    parser.add_argument('--signer', type=Path, help='Persistent signer using the native pubkey-account wallet')
    parser.add_argument('--rpc-url', default='http://127.0.0.1:9545')
    parser.add_argument('--runtime-manifest', type=Path)
    parser.add_argument('--artifact', type=Path, default=ROOT / 'build/doom.rv32a')
    parser.add_argument('--wad', type=Path, default=ROOT / 'vendor/PureDOOM/doom1.wad')
    parser.add_argument('--wallet', help='Saved wallet; omit to use the local dev account')
    parser.add_argument('--profile', default='local')
    parser.add_argument('--funding', default='10000', help='HOG sent to a newly deployed contract')
    parser.add_argument('--contract', help='Resume an already deployed and funded contract')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/live-session.json')
    args = parser.parse_args()
    game = LiveGame(args)
    try:
        game.initialize()
        serve(game, args.port)
    finally:
        if game.signer:
            game.signer.stdin.close()
            try:
                game.signer.wait(timeout=5)
            except subprocess.TimeoutExpired:
                game.signer.kill()
                game.signer.wait()


if __name__ == '__main__':
    main()
