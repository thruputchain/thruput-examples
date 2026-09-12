typedef unsigned int u32;
typedef unsigned char u8;
void *memset(void *p, int c, __SIZE_TYPE__ n) {
    u8 *b=p; for (__SIZE_TYPE__ i=0; i<n; ++i) b[i]=(u8)c; return p;
}
static u32 sc(u32 n, u32 x1, u32 x2, u32 x3, u32 x4, u32 x5, u32 x6) {
    register u32 a0 __asm__("a0") = n;
    register u32 a1 __asm__("a1") = x1, a2 __asm__("a2") = x2;
    register u32 a3 __asm__("a3") = x3, a4 __asm__("a4") = x4;
    register u32 a5 __asm__("a5") = x5, a6 __asm__("a6") = x6;
    register u32 a7 __asm__("a7") = 0;
    __asm__ volatile("ecall" : "+r"(a0), "+r"(a1), "+r"(a2), "+r"(a3),
        "+r"(a4), "+r"(a5), "+r"(a6), "+r"(a7) : : "memory");
    return a0;
}
#define PTR(x) ((u32)(x))
__attribute__((noreturn)) static void finish(const void *p, u32 n, u32 err) {
    sc(6, PTR(p), n, err, 0, 0, 0); __builtin_trap();
}
void contract_main(u32 method, u32 method_hi) {
    u32 len=0, tokens=0, written=0, auth_written=0;
    if (method_hi || sc(2, PTR(&len), PTR(&tokens), 0, 0, 0, 0) || len || tokens)
        finish(0, 0, 1);
    if (sc(3, 0, 0, PTR(&written), 0, 0, PTR(&auth_written)) || written || auth_written)
        finish(0, 0, 1);
    // Construct the same metadata key without a rodata dependency.
    u32 key[8] = {0x756f7267,0x6f68646e,0x6f642d67,0x762d6d6f,0,0,0,0};
    u32 meta[20] = {1};
    if (method == 0) {
        if (sc(15, PTR(key), PTR(meta), sizeof(meta), 0, 0, 0)) finish(0, 0, 1);
    } else if (method == 4) {
        if (sc(14, PTR(key), PTR(meta), sizeof(meta), PTR(&len), 0, 0)
            || len != sizeof(meta) || meta[0] != 1) finish(0, 0, 1);
    } else finish(0, 0, 1);
    finish(meta, sizeof(meta), 0);
}
