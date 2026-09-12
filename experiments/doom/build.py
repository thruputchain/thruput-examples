#!/usr/bin/env python3
"""Build the freestanding RV32 contract and the standalone hogd VM harness."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def checkout(repo, revision, dest):
    if not dest.exists():
        run(['git', 'clone', '--filter=blob:none', '--no-checkout', repo, dest])
        run(['git', '-C', dest, 'checkout', '--detach', revision])
    return dest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--hogd-dir', type=Path, help='existing hogd checkout; only pinned VM files are used')
    p.add_argument('--puredoom-dir', type=Path, help='existing pinned PureDOOM checkout')
    p.add_argument('--zig', default=os.environ.get('ZIG') or shutil.which('zig'))
    p.add_argument('--build-dir', type=Path, default=ROOT / 'build')
    args = p.parse_args()
    sources = json.loads((ROOT / 'sources.json').read_text())
    deps = ROOT / '.deps'
    deps.mkdir(exist_ok=True)
    hogd = (args.hogd_dir or checkout(sources['hogd_repository'], sources['hogd_revision'], deps / 'hogd')).resolve()
    doom = (args.puredoom_dir or checkout(sources['puredoom_repository'], sources['puredoom_revision'], deps / 'PureDOOM')).resolve()
    for path, expected in sources['hogd_files'].items():
        blob = (hogd / path).read_bytes()
        actual = hashlib.sha1(f'blob {len(blob)}\0'.encode() + blob).hexdigest()
        if actual != expected:
            raise RuntimeError(f'{path} differs from pinned hogd {sources["hogd_revision"]}; use a separate checkout at that revision')
    revision = subprocess.check_output(['git', '-C', doom, 'rev-parse', 'HEAD'], text=True).strip()
    if revision != sources['puredoom_revision']:
        raise RuntimeError('PureDOOM must be checked out at the revision in sources.json')
    run(['git', '-C', doom, 'diff', '--exit-code', 'HEAD', '--', 'PureDOOM.h'])
    zig = args.zig
    if not zig:
        try:
            import ziglang
            zig = str(Path(ziglang.__file__).parent / 'zig')
        except ImportError:
            raise RuntimeError('Install requirements.txt or supply --zig /path/to/zig') from None
    version = subprocess.check_output([zig, 'version'], text=True).strip()
    if version != '0.16.0':
        raise RuntimeError(f'Expected Zig 0.16.0, got {version}')
    zig = Path(zig).resolve()
    build = args.build_dir.resolve()
    build.mkdir(parents=True, exist_ok=True)
    zig_env = subprocess.check_output([zig, 'env'], text=True)
    match = re.search(r'\.lib_dir = ("(?:[^"\\]|\\.)*")', zig_env)
    if not match:
        raise RuntimeError('Cannot locate Zig compiler runtime from zig env')
    compiler_rt = Path(json.loads(match.group(1))).resolve() / 'compiler_rt.zig'
    run([zig, 'build-lib', compiler_rt, '-target', 'riscv32-freestanding', '-mcpu=generic_rv32+m',
         '-O', 'ReleaseFast', f'-femit-bin={build / "librv32rt.a"}'])
    flags = ['-target', 'riscv32-freestanding', '-mcpu=generic_rv32+m', '-O2', '-std=gnu11',
             '-fwrapv', '-fno-strict-aliasing', '-fno-builtin', '-fno-stack-protector',
             '-ffunction-sections', '-fdata-sections', '-fno-pic', '-mno-relax', '-nostdlib', '-w']
    run([zig, 'cc', *flags, '-I' + str(doom), '-Wl,-T,' + str(ROOT / 'link.ld'), '-Wl,--gc-sections',
         ROOT / 'start.S', ROOT / 'contract.c', build / 'librv32rt.a', '-o', build / 'doom.elf'])
    run([sys.executable, ROOT / 'package.py', build / 'doom.elf', build / 'doom.rv32a'])
    # This demo harness targets Linux with OpenSSL's libcrypto installed.
    library_dirs = [Path('/usr/lib/x86_64-linux-gnu'), Path('/usr/lib/aarch64-linux-gnu')]
    run([zig, 'c++', '-std=c++23', '-O3', '-DNDEBUG', '-Wno-nullability-completeness',
         '-I' + str(hogd), ROOT / 'runner.cpp', hogd / 'hogd/hog_exec/runtime/rv32/program.cc',
         *['-L' + str(d) for d in library_dirs if d.is_dir()], '-lcrypto', '-o', build / 'runner'])
    provenance = dict(sources, zig_version=version, puredoom_header_sha256=hashlib.sha256((doom / 'PureDOOM.h').read_bytes()).hexdigest())
    (build / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Built {build / "doom.rv32a"} and {build / "runner"}')


if __name__ == '__main__':
    main()
