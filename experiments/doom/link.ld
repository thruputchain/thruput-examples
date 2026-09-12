/* Separate Groundhog CODE/DATA spaces. Never snapshot the active stack. */
ENTRY(_start)
MEMORY {
  CODE (rx) : ORIGIN = 0, LENGTH = 4M
  DATA (rw) : ORIGIN = 0, LENGTH = 10M
}
/* The full layout, including the bounded 8 MiB arena, ends below 10 MiB. */
__memory_size = 10M;
__stack_top = 1M;
__global_pointer$ = __stack_top + 0x800;
SECTIONS {
  .text 0 : ALIGN(4) { KEEP(*(.text._start)) *(.text .text.*) } > CODE
  .rodata __stack_top : ALIGN(16) { *(.srodata*) *(.rodata*) } > DATA
  .data : ALIGN(32768) { __state_start = .; *(.sdata*) *(.data*) __initial_end = .; } > DATA
  .bss (NOLOAD) : ALIGN(16) { *(.sbss*) *(.bss*) *(COMMON) } > DATA
  .doom_heap (NOLOAD) : ALIGN(32768) { *(.doom_heap) __state_limit = .; } > DATA
  .scratch (NOLOAD) : ALIGN(4096) { *(.scratch) } > DATA
  /DISCARD/ : { *(.comment) *(.eh_frame*) *(.riscv.attributes) }
}
ASSERT(. <= __memory_size, "Doom exceeds guest memory")
