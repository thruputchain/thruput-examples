/* Internal demo ABI. Engine source is fetched separately; see README.md. */
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef __SIZE_TYPE__ usize;

void *memcpy(void *d, const void *s, usize n) {
    u8 *out = d; const u8 *in = s;
    for (usize i = 0; i < n; ++i) out[i] = in[i];
    return d;
}
void *memset(void *d, int c, usize n) {
    u8 *out = d; for (usize i = 0; i < n; ++i) out[i] = (u8)c; return d;
}
static int equal(const void *a, const void *b, usize n) {
    const u8 *x = a, *y = b;
    for (usize i = 0; i < n; ++i) if (x[i] != y[i]) return 0;
    return 1;
}

#define DOOM_IMPLEMENTATION
#include "PureDOOM.h"

#include "abi.h"
#define PAGE GH_DOOM_PAGE_BYTES
#define HEAP_BYTES (8u * 1024u * 1024u)
#define MAX_PAGES 512u
#define MAX_WAD_BYTES (8u * 1024u * 1024u)
#define FRAME_BYTES (320u * 200u + 768u)

static u8 arena[HEAP_BYTES] __attribute__((section(".doom_heap"), aligned(GH_DOOM_PAGE_BYTES)));
static u32 heap_used, virtual_tick;
static u8 held_keys[256];
static struct { u32 pos, open; } file_handles[16];
extern u8 __state_start[], __state_limit[], __initial_end[];

/* These are per-invocation scratch, outside the persisted engine region. */
static u8 old_hashes[MAX_PAGES][32] __attribute__((section(".scratch")));
static u8 io[PAGE + 16] __attribute__((section(".scratch")));
static u8 wad_cache[PAGE] __attribute__((section(".scratch")));
static u32 wad_cached_page __attribute__((section(".scratch")));
static u32 wad_length __attribute__((section(".scratch")));

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
#define PTR(x) ((u32)(usize)(x))
__attribute__((noreturn)) static void fail(const char *msg) {
    sc(4, PTR(msg), (u32)doom_strlen(msg), 0, 0, 0, 0);
    sc(8, 0, 0, 0, 0, 0, 0); __builtin_trap();
}
static void check(u32 code) { if (code) fail("Doom syscall failed"); }
__attribute__((noreturn)) static void finish(const void *p, u32 n) {
    sc(6, PTR(p), n, 0, 0, 0, 0); __builtin_trap();
}
static void key(u8 out[32], u32 domain, u32 index) {
    memset(out, 0, 32); memcpy(out, "groundhog-doom-v1", 16);
    memcpy(out + 16, &domain, 4); memcpy(out + 20, &index, 4);
}
static u32 get(u32 domain, u32 index, void *out, u32 cap, u32 *len) {
    u8 k[32]; key(k, domain, index);
    return sc(14, PTR(k), PTR(out), cap, PTR(len), 0, 0);
}
static void set(u32 domain, u32 index, const void *p, u32 len) {
    u8 k[32]; key(k, domain, index);
    check(sc(15, PTR(k), PTR(p), len, 0, 0, 0));
}
static void digest(const void *p, u32 len, u8 out[32]) {
    check(sc(0, PTR(p), len, PTR(out), 0, 0, 0));
}
static u32 read_u32(const u8 *p) {
    return p[0] | (u32)p[1] << 8 | (u32)p[2] << 16 | (u32)p[3] << 24;
}
static u32 calldata(void) {
    u32 len = 0, tokens = 0;
    check(sc(2, PTR(&len), PTR(&tokens), 0, 0, 0, 0));
    if (tokens || len > sizeof(io)) fail("bad calldata length or auth tokens");
    u32 written = 0, auth_written = 0;
    check(sc(3, PTR(io), sizeof(io), PTR(&written), 0, 0, PTR(&auth_written)));
    if (written != len || auth_written) fail("bad calldata");
    return len;
}

static void *alloc_doom(int size) {
    if (size < 0 || heap_used > HEAP_BYTES || (u32)size > HEAP_BYTES - heap_used) fail("Doom heap exhausted");
    u32 n = ((u32)size + 15) & ~15u;
    if (n > HEAP_BYTES - heap_used) fail("Doom heap exhausted");
    void *p = arena + heap_used; heap_used += n; return p;
}
/* Zone allocator does most frees. Outer allocations are bounded by this arena;
 * restart the demo to reclaim them after many level changes. */
static void free_doom(void *p) { (void)p; }
static void print_doom(const char *s) { check(sc(4, PTR(s), (u32)doom_strlen(s), 0, 0, 0, 0)); }
static void exit_doom(int code) { (void)code; fail("Doom exited"); }
static char *env_doom(const char *name) {
    /* Virtual paths only: the file callback admits the one uploaded WAD. */
    if (!doom_strcmp(name, "HOME") || !doom_strcmp(name, "DOOMWADDIR")) return ".";
    return 0;
}
static void time_doom(int *sec, int *usec) {
    *sec = 1 + (int)(virtual_tick / 35);
    *usec = (int)((virtual_tick % 35) * 1000000u / 35u);
}
static void *open_doom(const char *name, const char *mode) {
    int n = doom_strlen(name);
    if (mode[0] != 'r' || n < 9 || !equal(name + n - 9, "doom1.wad", 9)) return 0;
    for (u32 i = 0; i < 16; ++i) if (!file_handles[i].open) {
        file_handles[i].open = 1; file_handles[i].pos = 0;
        return &file_handles[i];
    }
    fail("too many WAD handles");
}
static u32 handle_index(void *p) {
    usize offset = (usize)p - (usize)file_handles;
    if (offset >= sizeof(file_handles) || offset % sizeof(file_handles[0])) fail("bad file handle");
    u32 i = offset / sizeof(file_handles[0]);
    if (!file_handles[i].open) fail("closed WAD handle"); return i;
}
static void close_doom(void *p) { file_handles[handle_index(p)].open = 0; }
static int read_doom(void *p, void *buf, int count) {
    u32 i = handle_index(p), pos = file_handles[i].pos;
    if (count < 0) return -1;
    u32 total = (u32)count;
    if (total > wad_length - pos) total = wad_length - pos;
    u32 left = total;
    while (left) {
        u32 page = pos / PAGE, offset = pos % PAGE;
        if (wad_cached_page != page) {
            u32 len = 0;
            check(get(1, page, wad_cache, PAGE, &len));
            u32 expected = wad_length - page * PAGE;
            if (expected > PAGE) expected = PAGE;
            if (len != expected) fail("incomplete WAD");
            wad_cached_page = page;
        }
        u32 n = PAGE - offset; if (n > left) n = left;
        memcpy(buf, wad_cache + offset, n);
        buf = (u8 *)buf + n; pos += n; left -= n;
    }
    file_handles[i].pos = pos; return (int)total;
}
static int write_doom(void *p, const void *buf, int count) {
    (void)p; (void)buf; (void)count; return -1;
}
static int seek_doom(void *p, int offset, doom_seek_t origin) {
    u32 i = handle_index(p);
    long long base = origin == DOOM_SEEK_SET ? 0 : origin == DOOM_SEEK_CUR ? file_handles[i].pos : wad_length;
    long long dest = base + offset;
    if (dest < 0 || dest > wad_length) return -1;
    file_handles[i].pos = (u32)dest; return 0;
}
static int tell_doom(void *p) { return (int)file_handles[handle_index(p)].pos; }
static int eof_doom(void *p) { return file_handles[handle_index(p)].pos == wad_length; }

/* Metadata is intentionally independent of the restorable memory region. */
struct Meta { u32 version, tick, state_bytes, wad_bytes; u8 present[MAX_PAGES / 8]; };
static int meta(struct Meta *m) {
    u32 n = 0, err = get(0, 0, m, sizeof(*m), &n);
    if (err == 8) { memset(m, 0, sizeof(*m)); return 0; }
    check(err);
    if (n != sizeof(*m) || m->version != 1) fail("bad snapshot version");
    return 1;
}
static void restore(const struct Meta *m) {
    if (!m->state_bytes || m->state_bytes > (u32)(__state_limit - __state_start)
        || m->state_bytes % PAGE || m->state_bytes / PAGE > MAX_PAGES) fail("bad snapshot size");
    for (u32 off = 0; off < m->state_bytes; off += PAGE) {
        u32 n = 0;
        u32 page = off / PAGE;
        if (m->present[page / 8] & (1u << (page % 8))) {
            check(get(2, page, __state_start + off, PAGE, &n));
            if (n != PAGE) fail("truncated snapshot page");
            digest(__state_start + off, PAGE, old_hashes[page]);
        } else if (__state_start + off < __initial_end) {
            /* BSS/heap already zero in a fresh VM; clear only initial data. */
            memset(__state_start + off, 0, PAGE);
        }
    }
    if (virtual_tick != m->tick) fail("snapshot tick mismatch");
}
static void persist(struct Meta *m) {
    u32 bytes = ((u32)(arena + heap_used - __state_start) + PAGE - 1) & ~(PAGE - 1);
    if (bytes / PAGE > MAX_PAGES) fail("snapshot too large");
    u8 zero_hash[32]; memset(io, 0, PAGE); digest(io, PAGE, zero_hash);
    for (u32 off = 0; off < bytes; off += PAGE) {
        u32 page = off / PAGE, mask = 1u << (page % 8);
        u8 hash[32]; digest(__state_start + off, PAGE, hash);
        if (equal(hash, zero_hash, 32)) {
            m->present[page / 8] &= (u8)~mask;
        } else {
            if (!(m->present[page / 8] & mask) || !equal(hash, old_hashes[page], 32))
                set(2, page, __state_start + off, PAGE);
            m->present[page / 8] |= mask;
        }
    }
    m->state_bytes = bytes;
}
static void publish_frame(void) {
    /* Store the original 8-bit pixels and current RGB palette in two pages. */
    for (u32 off = 0; off < FRAME_BYTES; off += PAGE) {
        u32 n = FRAME_BYTES - off; if (n > PAGE) n = PAGE;
        for (u32 j = 0; j < n; ++j) {
            u32 k = off + j;
            io[j] = k < 64000 ? screens[0][k] : screen_palette[k - 64000];
        }
        set(3, off / PAGE, io, n);
    }
}

/* IDs are explicitly chosen u64s, supported by Groundhog's raw entrypoint ABI.
 * 0 upload, 1 initialize E1M1, 2 step, 3 frame page, 4 status. */
void contract_main(u32 method, u32 method_hi) {
    if (method_hi) fail("unknown method");
    u32 len = calldata();
    struct Meta m;
    int initialized = meta(&m);
    wad_cached_page = ~0u;
    if (method == 0) {
        /* Append-only assets. Supply index:u32, total_bytes:u32, page bytes. */
        if (initialized || len < 9) fail("WAD is sealed or empty");
        u32 index = read_u32(io), total = read_u32(io + 4), n = 0;
        u32 uploaded[2] = {0, 0};
        u32 err = get(0, 1, uploaded, sizeof(uploaded), &n);
        if (err != 8) { check(err); if (n != sizeof(uploaded)) fail("bad upload metadata"); }
        if (!total || total > MAX_WAD_BYTES || index != uploaded[0]
            || (index && total != uploaded[1]) || index > (total - 1) / PAGE) fail("bad WAD upload");
        u32 wanted = total - index * PAGE; if (wanted > PAGE) wanted = PAGE;
        if (len != 8 + wanted) fail("wrong WAD page size");
        set(1, index, io + 8, wanted);
        uploaded[0]++; uploaded[1] = total; set(0, 1, uploaded, sizeof(uploaded));
        finish(uploaded, sizeof(uploaded));
    }
    if (method == 4) { if (len || !initialized) fail("no game"); finish(&m, sizeof(m)); }
    if (method == 3) {
        if (!initialized || len != 8 || read_u32(io) != m.tick || read_u32(io + 4) >= 64) fail("stale frame or bad page");
        u32 chunk = read_u32(io + 4), page = chunk / (PAGE / 1024), offset = chunk % (PAGE / 1024) * 1024, n = 0;
        check(get(3, page, io, PAGE, &n));
        if (n <= offset) fail("bad frame length");
        n -= offset; if (n > 1024) n = 1024; finish(io + offset, n);
    }
    if (method == 1) {
        if (initialized || len) fail("already initialized or unexpected input");
        u32 upload[2], n = 0;
        check(get(0, 1, upload, sizeof(upload), &n));
        if (n != sizeof(upload) || !upload[1] || upload[0] != (upload[1] + PAGE - 1) / PAGE) fail("upload incomplete");
        wad_length = upload[1];
        doom_set_print(print_doom); doom_set_malloc(alloc_doom, free_doom);
        doom_set_file_io(open_doom, close_doom, read_doom, write_doom, seek_doom, tell_doom, eof_doom);
        doom_set_gettime(time_doom); doom_set_getenv(env_doom); doom_set_exit(exit_doom);
        static char *args[] = {"doom", "-warp", "1", "1", "-skill", "2", "-nosound", "-nomusic"};
        doom_init(8, args, DOOM_FLAG_HIDE_SOUND_OPTIONS | DOOM_FLAG_HIDE_MUSIC_OPTIONS);
        /* One exact game tic. No wall-clock loop or cosmetic screen-wipe wait. */
        wipegamestate = GS_LEVEL;
        D_DoomLoop();
        virtual_tick = 1;
        m.version = 1; m.tick = virtual_tick; m.wad_bytes = wad_length;
        persist(&m); publish_frame(); set(0, 0, &m, sizeof(m));
        finish(&m, sizeof(m));
    }
    if (method == 2) {
        /* expected_tick:u32 + 256-key bitmap (32 bytes), held for one tic. */
        if (!initialized || len != 36 || read_u32(io) != m.tick || m.tick >= 10000000u) fail("stale tick or invalid input");
        u8 keys[32]; memcpy(keys, io + 4, 32);
        restore(&m); wad_length = m.wad_bytes;
        for (u32 k = 0; k < 256; ++k) {
            u8 held = (keys[k / 8] >> (k % 8)) & 1;
            if (held != held_keys[k]) {
                if (held) doom_key_down((doom_key_t)k); else doom_key_up((doom_key_t)k);
                held_keys[k] = held;
            }
        }
        wipegamestate = gamestate;
        D_DoomLoop(); virtual_tick++;
        m.tick = virtual_tick; persist(&m);
        publish_frame(); set(0, 0, &m, sizeof(m)); finish(&m, sizeof(m));
    }
    fail("unknown Doom method");
}
