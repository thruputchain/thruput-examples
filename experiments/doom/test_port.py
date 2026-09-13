#!/usr/bin/env python3
"""Exercise a real level transition in the standalone contract VM."""
import subprocess
from pathlib import Path

from elftools.elf.elffile import ELFFile

ROOT = Path(__file__).resolve().parent

with (ROOT / 'build/doom.elf').open('rb') as source:
    symbols = {symbol.name: symbol['st_value']
               for symbol in ELFFile(source).get_section_by_name('.symtab').iter_symbols()}

subprocess.run([
    str(ROOT / 'build/runner'), str(ROOT / 'build/doom.rv32a'),
    str(ROOT / 'vendor/PureDOOM/doom1.wad'), str(ROOT / 'build/port-regression'),
    '--level-transition',
    *[str(symbols[name]) for name in ('__state_start', 'gameaction', 'gamemap', 'players')],
], check=True)
