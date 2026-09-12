#!/usr/bin/env python3
"""Package this freestanding C ELF as Groundhog artifact v5 (no SDK required)."""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from elftools.elf.elffile import ELFFile


def package(source: Path, target: Path):
    with source.open('rb') as stream:
        elf = ELFFile(stream)
        if elf.elfclass != 32 or not elf.little_endian or elf['e_machine'] != 'EM_RISCV' or elf['e_entry'] != 0:
            raise ValueError('expected RV32 little-endian ELF with entry at PC 0')
        if elf['e_flags'] & 7:
            raise ValueError('compressed instructions or hardware float ABI are not supported')
        text = elf.get_section_by_name('.text')
        if text['sh_addr'] != 0 or text['sh_size'] % 4:
            raise ValueError('code must start at zero and have whole RV32 instructions')
        code = text.data()
        initialized = []
        for section in elf.iter_sections():
            if section['sh_type'] in ('SHT_REL', 'SHT_RELA') and section['sh_size']:
                raise ValueError('unresolved relocation section')
            if not section['sh_flags'] & 2 or section is text or section.name == '.text':
                continue
            if section['sh_flags'] & 4:
                raise ValueError('unexpected executable section: ' + section.name)
            if section.name not in ('.rodata', '.data', '.bss', '.doom_heap', '.scratch'):
                raise ValueError('unexpected allocated section: ' + section.name)
            if section['sh_type'] != 'SHT_NOBITS' and section['sh_size']:
                initialized.append(section)
        start = min(s['sh_addr'] for s in initialized)
        end = max(s['sh_addr'] + s['sh_size'] for s in initialized)
        memory = bytearray(end - start)
        for section in initialized:
            offset = section['sh_addr'] - start
            memory[offset:offset + section['sh_size']] = section.data()
        symbols = {s.name: s['st_value'] for s in elf.get_section_by_name('.symtab').iter_symbols()}
        memory_bytes = symbols['__memory_size']
        if start < 8 or end > memory_bytes or len(code) > 4 * 1024**2 or memory_bytes > 16 * 1024**2:
            raise ValueError('artifact exceeds Groundhog VM ceilings')
        header = struct.pack('<8sIIQIIIIQIIII', b'GHRV32A1', 5, 128, 0x55c53a685f0eb33d,
                             0, 3, 1, 4, 0x9019deb606f5759b,
                             memory_bytes, len(code), len(memory), start)
        header += hashlib.sha256(code).digest() + hashlib.sha256(memory).digest()
        assert len(header) == 128
        artifact = header + code + memory
        target.write_bytes(artifact)
        report = dict(artifact_bytes=len(artifact), code_bytes=len(code), initial_memory_bytes=len(memory),
                      initial_memory_start=start, memory_bytes=memory_bytes,
                      artifact_sha256=hashlib.sha256(artifact).hexdigest(),
                      gas_version=4, gas_digest='9019deb606f5759b')
        target.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('elf', type=Path)
    parser.add_argument('artifact', type=Path)
    args = parser.parse_args()
    package(args.elf, args.artifact)
