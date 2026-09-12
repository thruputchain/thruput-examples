.section .text._start,"ax",@progbits
.global _start
_start:
  .option push
  .option norelax
  la sp, __stack_top
  la gp, __global_pointer$
  .option pop
  call contract_main
  ebreak
