#!/usr/bin/env python3
"""Start a configurable local node, deploy Doom, and serve the browser app."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--groundhog', type=Path, required=True)
    parser.add_argument('--hog-devnode', type=Path, required=True)
    parser.add_argument('--contracts', type=Path, required=True)
    parser.add_argument('--signer', type=Path)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'build/local-node')
    parser.add_argument('--rpc-port', type=int, default=9545)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--worker-threads', type=int, default=2,
                        help='Local hogd worker count; two reduces migration in this serial demo')
    args = parser.parse_args()
    if args.worker_threads < 1:
        parser.error('--worker-threads must be positive')
    args.data_dir = args.data_dir.resolve()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, XDG_CONFIG_HOME=str(args.data_dir / 'config'),
               XDG_CACHE_HOME=str(args.data_dir / 'cache'),
               DEFAULT_THREADPOOL_SIZE=str(args.worker_threads))
    log = (args.data_dir / 'node.log').open('a')
    startup_path = args.data_dir / 'startup.json'
    output = startup_path.open('w')
    node = subprocess.Popen([str(args.groundhog.resolve()), '--json', 'node',
        '--hog-devnode-binary', str(args.hog_devnode.resolve()),
        '--contract-artifacts-dir', str(args.contracts.resolve()),
        '--data-dir', str(args.data_dir / 'chain'), '--port', str(args.rpc_port),
        '--dev-account-count', '1', '--dev-account-hog', '100000',
        '--ramdb-bytes', '512M', '--block-driver', 'instant',
        '--network-config', 'max_rv32_code_bytes=1M',
        '--network-config', 'max_rv32_memory_bytes=16M',
        '--network-config', 'max_contract_size_bytes=1M',
        '--network-config', 'max_bytestring_len=64000'],
        env=env, stdout=output, stderr=log, start_new_session=True)
    app = None
    try:
        deadline = time.monotonic() + 60
        startup = None
        while time.monotonic() < deadline and node.poll() is None:
            try:
                startup = json.loads(startup_path.read_text())
                break
            except ValueError:
                time.sleep(0.1)
        if not startup or not startup.get('ok'):
            raise RuntimeError('Node startup failed; see ' + str(args.data_dir / 'node.log'))
        session_path = args.data_dir / 'session.json'
        command = [sys.executable, str(ROOT / 'live.py'),
            '--groundhog', str(args.groundhog.resolve()), '--rpc-url', startup['data']['rpc_url'],
            '--runtime-manifest', startup['data']['runtime_manifest']['path'],
            '--port', str(args.port), '--output', str(session_path)]
        if args.signer:
            command += ['--signer', str(args.signer.resolve())]
        if session_path.exists():
            session = json.loads(session_path.read_text())
            command += ['--contract', session['contract']]
        app = subprocess.Popen(command, env=env)
        while app.poll() is None:
            if node.poll() is not None:
                raise RuntimeError('Node stopped; see ' + str(args.data_dir / 'node.log'))
            time.sleep(0.25)
        if app.returncode:
            raise RuntimeError(f'Doom app exited with status {app.returncode}')
    except KeyboardInterrupt:
        pass
    finally:
        if app and app.poll() is None:
            app.terminate()
            try:
                app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()
        if node.poll() is None:
            os.killpg(node.pid, signal.SIGTERM)
            try:
                node.wait(timeout=40)
            except subprocess.TimeoutExpired:
                os.killpg(node.pid, signal.SIGKILL)
                node.wait()
        output.close()
        log.close()


if __name__ == '__main__':
    main()
