#!/usr/bin/env python3
"""Compare Doom status transactions with small RV32 controls and direct reads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import statistics
import struct
import subprocess
import sys
import time

from elftools.elf.elffile import ELFFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import live


def build_controls(args):
    elf = args.work_dir / 'status.elf'
    subprocess.run([str(args.zig), 'cc', '-target', 'riscv32-freestanding',
        '-mcpu=generic_rv32+m', '-O2', '-std=gnu11', '-fno-builtin',
        '-fno-stack-protector', '-ffunction-sections', '-fdata-sections',
        '-fno-pic', '-mno-relax', '-nostdlib', '-Wl,-T,' + str(ROOT / 'link.ld'),
        '-Wl,--gc-sections', str(ROOT / 'start.S'),
        str(ROOT / 'profiling/status.c'), '-o', str(elf)], check=True)
    with elf.open('rb') as stream:
        parsed = ELFFile(stream)
        code = parsed.get_section_by_name('.text').data()
        assert all(s.name == '.text' or not s['sh_flags'] & 2 or not s['sh_size']
                   for s in parsed.iter_sections()), 'control must not depend on initialized data'
    original = args.artifact.read_bytes()
    assert original[:8] == b'GHRV32A1' and struct.unpack_from('<I', original, 8)[0] == 5
    initial = original[128 + struct.unpack_from('<I', original, 52)[0]:]
    initial_start = struct.unpack_from('<I', original, 60)[0]
    declared_memory = struct.unpack_from('<I', original, 48)[0]
    variants = [('tiny_same_image', declared_memory, initial, initial_start),
                ('tiny_16m', 16 * 1024**2, b'', 0),
                ('tiny_2m', 2 * 1024**2, b'', 0)]
    paths = {'doom': args.artifact}
    for name, memory, data, start in variants:
        header = bytearray(original[:128])
        struct.pack_into('<IIII', header, 48, memory, len(code), len(data), start)
        header[64:96] = hashlib.sha256(code).digest()
        header[96:128] = hashlib.sha256(data).digest()
        paths[name] = args.work_dir / (name + '.rv32a')
        paths[name].write_bytes(bytes(header) + code + data)
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['groundhog', 'hog-devnode', 'contract-artifacts-dir', 'signer', 'zig', 'work-dir']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--artifact', type=Path, default=ROOT / 'build/doom.rv32a')
    parser.add_argument('--wad', type=Path, default=ROOT / 'vendor/PureDOOM/doom1.wad')
    parser.add_argument('--samples', type=int, default=30)
    parser.add_argument('--port', type=int, default=9545)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    for name, value in vars(args).items():
        if isinstance(value, Path):
            setattr(args, name, value.resolve())
    args.work_dir.mkdir(parents=True, exist_ok=False)
    paths = build_controls(args)
    env = dict(os.environ, XDG_CONFIG_HOME=str(args.work_dir / 'config'),
               XDG_CACHE_HOME=str(args.work_dir / 'cache'))
    os.environ.update(env)
    games, rows, reads = [], [], []
    startup_path = args.work_dir / 'startup.json'
    with (args.work_dir / 'node.log').open('w') as log, startup_path.open('w') as out:
        command = [str(args.groundhog), '--json', 'node', '--port', str(args.port),
            '--hog-devnode-binary', str(args.hog_devnode),
            '--contract-artifacts-dir', str(args.contract_artifacts_dir),
            '--data-dir', str(args.work_dir / 'chain'), '--dev-account-count', '1',
            '--dev-account-hog', '100000', '--ramdb-bytes', '512M', '--block-driver', 'instant']
        for override in ['max_rv32_code_bytes=1M', 'max_rv32_memory_bytes=16M',
                         'max_contract_size_bytes=1M', 'max_bytestring_len=32K']:
            command += ['--network-config', override]
        node = subprocess.Popen(command, stdout=out, stderr=log, env=env, start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and node.poll() is None:
                try:
                    startup = json.loads(startup_path.read_text())
                    break
                except ValueError:
                    time.sleep(.05)
            else:
                raise RuntimeError('node startup failed; inspect node.log')
            manifest = Path(startup['data']['runtime_manifest']['path'])
            for label, artifact in paths.items():
                config = argparse.Namespace(groundhog=args.groundhog,
                    rpc_url=f'http://127.0.0.1:{args.port}', runtime_manifest=manifest,
                    signer=args.signer, profile='local', wallet=None, contract=None,
                    artifact=artifact, wad=args.wad, funding='10000',
                    output=args.work_dir / (label + '-session.json'))
                game = live.LiveGame(config)
                games.append((label, game))
                if label == 'doom':
                    game.initialize()
                else:
                    game.address = game.cli('deploy', '--artifact', str(artifact), '--force')['address']
                    game.cli('transfer', game.address, '100', '--force')
                    game.cli('transfer', game.signer_address, '100', '--force')
                    game.signer_funded = True
                    game.call(0)
                for attempt in range(100):
                    try:
                        assert len(game.storage(0, 0)[1]) == 80
                        break
                    except RuntimeError:
                        if attempt == 99:
                            raise
                        time.sleep(.005)
                for _ in range(3):
                    game.call(4)
            for _ in range(args.samples):
                for label, game in games:
                    wall = time.time_ns()
                    receipt = game.call(4)
                    rows.append(dict(label=label, wallStartNs=wall, totalMs=game.last_ms,
                                     height=int(receipt['height']), hash=game.last_tx))
            time.sleep(.05)
            doom = games[0][1]
            for _ in range(args.samples):
                start = time.perf_counter_ns()
                height, data = doom.storage(0, 0)
                elapsed = (time.perf_counter_ns() - start) / 1e6
                assert len(data) == 80
                reads.append(dict(ms=elapsed, height=height, bytes=len(data)))
            summary = {label: statistics.median(r['totalMs'] for r in rows if r['label'] == label)
                       for label in paths}
            summary['directStorageRead'] = statistics.median(r['ms'] for r in reads)
            result = dict(summaryMedianMs=summary, transactions=rows, storageReads=reads,
                          artifactSha256={k: hashlib.sha256(p.read_bytes()).hexdigest() for k, p in paths.items()})
            (args.work_dir / 'timings.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(summary, indent=2), flush=True)
        finally:
            for _, game in games:
                if game.signer:
                    game.signer.stdin.close()
                    game.signer.wait(timeout=5)
            if node.poll() is None:
                os.killpg(node.pid, signal.SIGTERM)
            node.wait(timeout=40)


if __name__ == '__main__':
    main()
