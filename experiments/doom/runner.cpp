// Executes the actual contract in hogd's unchanged production RV32 interpreter.
// Storage and syscall services are a local test double, not a running node.
#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include "hogd/hog_exec/runtime/rv32/threaded_machine.h"
#include "hogd/hog_exec/runtime/rv32/encoding.h"
#include "abi.h"

extern "C" unsigned char *SHA256(const unsigned char *, size_t, unsigned char *);
using namespace hogd::rv32;
using Bytes = std::vector<uint8_t>;
using Key = std::array<uint8_t, 32>;
using Store = std::map<Key, Bytes>;

static void require(bool ok, const char *why) { if (!ok) throw std::runtime_error(why); }
static Bytes read_file(const std::string &path) {
  std::ifstream f(path, std::ios::binary); require(bool(f), "cannot open file");
  return Bytes(std::istreambuf_iterator<char>(f), {});
}
static void write_file(const std::string &path, const Bytes &data) {
  std::ofstream f(path, std::ios::binary); f.write((const char *)data.data(), data.size());
  require(bool(f), "cannot write file");
}
static void append_u32(Bytes &out, uint32_t n) {
  for (int i = 0; i < 4; ++i) out.push_back(uint8_t(n >> (8 * i)));
}
static Key key(uint32_t domain, uint32_t index) {
  Key k{}; memcpy(k.data(), "groundhog-doom-v1", 16);
  store_u32_le(k, 16, domain); store_u32_le(k, 20, index); return k;
}

struct DemoHost : Host {
  const Store &base;
  Store writes;
  Bytes input, returned;
  uint64_t host_gas = 0, gets = 0, sets = 0, read_bytes = 0, written_bytes = 0, hashes = 0;
  bool failed = false, did_return = false;
  explicit DemoHost(const Store &s, Bytes data) : base(s), input(std::move(data)) {}
  HostResult ecall(MachineView v, const EcallArgs &a) noexcept override try {
    uint64_t charge = 50; // current v4 base; deliberately excludes DB RPC charges
    auto bytes = [&](uint32_t ptr, uint32_t size) {
      require(memory_range_in_bounds(v.memory().size(), ptr, size), "host pointer out of bounds");
      return v.memory().subspan(ptr, size);
    };
    auto put = [&](uint32_t ptr, std::span<const uint8_t> data) {
      require(v.write_memory(ptr, data), "host output out of bounds");
    };
    auto put_u32 = [&](uint32_t ptr, uint32_t n) {
      std::array<uint8_t, 4> b{}; store_u32_le(b, 0, n); put(ptr, b);
    };
    auto result = [&](uint32_t code = 0) { host_gas += charge; return HostResult::continue_with(code, charge); };
    switch (a.a0) {
    case 0: {
      auto data = bytes(a.a1, a.a2); Key hash{};
      SHA256(data.data(), data.size(), hash.data()); put(a.a3, hash);
      charge += 22 * ((a.a2 + uint64_t{9} + 63) / 64); ++hashes; return result();
    }
    case 2: put_u32(a.a1, input.size()); put_u32(a.a2, 0); return result();
    case 3:
      require(a.a2 >= input.size() && a.a5 == 0, "bad calldata outputs");
      put(a.a1, input); put_u32(a.a3, input.size()); put_u32(a.a6, 0); return result();
    case 4: {
      auto text = bytes(a.a1, a.a2);
      std::cerr.write((const char *)text.data(), text.size()); return result();
    }
    case 6: {
      require(a.a2 <= 1024 && a.a3 <= 1 && a.a5 == 0, "return limit or invalid revert/tokens");
      auto b = bytes(a.a1, a.a2); returned.assign(b.begin(), b.end());
      did_return = !a.a3; failed = a.a3; host_gas += charge; return HostResult::halt(a.a3, charge);
    }
    case 8: failed = true; host_gas += charge; return HostResult::halt(1, charge);
    case 14: {
      Key k{}; auto raw = bytes(a.a1, 32); std::copy(raw.begin(), raw.end(), k.begin());
      const Bytes *value = nullptr;
      if (auto it = writes.find(k); it != writes.end()) value = &it->second;
      else if (auto it = base.find(k); it != base.end()) value = &it->second;
      ++gets; charge += 150;
      if (!value) return result(8);
      if (value->size() > a.a3) return result(7);
      put(a.a2, *value); put_u32(a.a4, value->size()); read_bytes += value->size();
      charge += 7 * ((value->size() + 511) / 512); return result();
    }
    case 15: {
      require(a.a3 <= GH_DOOM_MAX_STORAGE_BYTES && a.a4 == 0, "configured bytestring limit or flags");
      Key k{}; auto raw = bytes(a.a1, 32); std::copy(raw.begin(), raw.end(), k.begin());
      auto data = bytes(a.a2, a.a3); writes[k] = Bytes(data.begin(), data.end());
      ++sets; written_bytes += data.size(); charge += 150 + 13 * ((data.size() + 511) / 512);
      return result();
    }
    default: throw std::runtime_error("unimplemented syscall " + std::to_string(a.a0));
    }
  } catch (const std::exception &e) {
    std::cerr << "host error: " << e.what() << '\n'; failed = true;
    return HostResult::halt(1);
  }
};

struct Result {
  bool ok;
  uint64_t gas, host_gas, reads, writes, read_bytes, written_bytes;
  double ms;
  Bytes returned;
};
struct Demo {
  ThreadedMachinePreInstantiation pre;
  Store storage;
  explicit Demo(ThreadedMachinePreInstantiation p) : pre(std::move(p)) {}
  Result call(uint64_t method, Bytes input = {}, uint64_t gas = 2000000000) {
    auto start = std::chrono::steady_clock::now();
    ThreadedMachine vm(pre, gas); // fresh VM every transaction, no live-memory carryover
    vm.seed_method_id(method);
    DemoHost host(storage, std::move(input)); vm.run(host);
    bool ok = !host.failed && host.did_return && vm.trap() == Trap::kNone && vm.halted();
    if (ok) for (auto &[k, data] : host.writes) storage[k] = std::move(data);
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    if (!ok) std::cerr << "\ncall failed method=" << method << " pc=" << vm.pc() << " trap=" << int(vm.trap()) << " gas=" << gas-vm.gas_remaining() << '\n';
    return {ok, gas - vm.gas_remaining(), host.host_gas, host.gets, host.sets,
            host.read_bytes, host.written_bytes, ms, std::move(host.returned)};
  }
  uint32_t tick() const { return load_u32_le(storage.at(key(0, 0)), 4); }
  Bytes frame() const {
    Bytes out;
    for (uint32_t i = 0; i < GH_DOOM_FRAME_PAGES; ++i) {
      const auto &p = storage.at(key(3, i)); out.insert(out.end(), p.begin(), p.end());
    }
    require(out.size() == 64768, "frame size"); return out;
  }
};
static void check_snapshot_hashes(const Demo &demo) {
  const auto &metadata = demo.storage.at(key(0, 0));
  require(load_u32_le(metadata, 0) == GH_DOOM_SNAPSHOT_VERSION, "snapshot version");
  const auto pages = load_u32_le(metadata, 8) / GH_DOOM_SNAPSHOT_PAGE_BYTES;
  const auto &hashes = demo.storage.at(key(0, 3));
  require(hashes.size() == pages * 32, "snapshot hash table length");
  const Bytes zero(GH_DOOM_SNAPSHOT_PAGE_BYTES, 0);
  for (uint32_t i = 0; i < pages; ++i) {
    const auto &data = metadata[16 + i / 8] & (1u << (i % 8))
        ? demo.storage.at(key(2, i)) : zero;
    Key expected{}; SHA256(data.data(), data.size(), expected.data());
    require(std::equal(expected.begin(), expected.end(), hashes.begin() + i * 32),
            "persisted snapshot hash does not match its page");
  }
}
static Bytes step_input(uint32_t tick, int held = -1) {
  Bytes b; append_u32(b, tick); b.resize(36);
  if (held >= 0) b[4 + held / 8] |= 1 << (held % 8); return b;
}
static void row(std::ostream &f, const std::string &phase, uint32_t tick, const Result &r) {
  f << phase << ',' << tick << ',' << r.gas << ',' << r.host_gas << ',' << r.reads << ',' << r.writes << ','
    << r.read_bytes << ',' << r.written_bytes << ',' << r.ms << '\n';
}
static void ppm(const std::string &path, const Bytes &frame) {
  std::string h = "P6\n320 200\n255\n"; Bytes rgb(h.begin(), h.end());
  for (size_t i = 0; i < 64000; ++i) {
    size_t p = 64000 + frame[i] * 3;
    rgb.insert(rgb.end(), frame.begin() + p, frame.begin() + p + 3);
  }
  write_file(path, rgb);
}


int main(int argc, char **argv) try {
  require(argc >= 4, "usage: runner doom.rv32a doom1.wad output-dir [ticks]");
  const auto artifact = read_file(argv[1]), wad = read_file(argv[2]);
  require(artifact.size() >= 128 && equal(artifact.begin(), artifact.begin()+8, "GHRV32A1"), "bad artifact");
  auto size = load_u32_le(artifact, 52), initial = load_u32_le(artifact, 56);
  require(artifact.size() == 128ull + size + initial, "artifact size");
  require(load_u32_le(artifact, 8) == 5 && load_u32_le(artifact, 12) == 128 &&
          load_u64_le(artifact, 16) == 0x55c53a685f0eb33dULL &&
          load_u32_le(artifact, 24) == 0 && load_u32_le(artifact, 28) == 3 &&
          load_u32_le(artifact, 32) == 1 && load_u32_le(artifact, 36) == 4 &&
          load_u64_le(artifact, 40) == 0x9019deb606f5759bULL, "artifact ABI");
  for (int section = 0; section < 2; ++section) {
    Key hash{}; SHA256(artifact.data()+128+(section ? size : 0), section ? initial : size, hash.data());
    require(std::equal(hash.begin(), hash.end(), artifact.begin()+64+32*section), "artifact hash");
  }
  auto bytes = std::span<const uint8_t>(artifact);
  auto pre = ThreadedMachinePreInstantiation::create(bytes.subspan(128, size), bytes.subspan(128+size, initial),
      load_u32_le(artifact, 60), load_u32_le(artifact, 48), false);
  if (!pre) throw std::runtime_error("hogd rejected program: " + std::to_string(int(pre.error())));
  Demo demo(std::move(*pre));
  std::string dir = argv[3]; std::filesystem::create_directories(dir);
  std::ofstream csv(dir + "/metrics.csv");
  csv << "phase,tick,gas_excluding_db_rpc,host_gas_excluding_db_rpc,reads,writes,read_bytes,written_bytes,wall_ms\n";
  for (uint32_t off = 0; off < wad.size(); off += GH_DOOM_UPLOAD_BYTES) {
    Bytes upload; append_u32(upload, off); append_u32(upload, wad.size());
    upload.insert(upload.end(), wad.begin()+off, wad.begin()+std::min<size_t>(off+GH_DOOM_UPLOAD_BYTES, wad.size()));
    auto result = demo.call(5, std::move(upload)); require(result.ok, "upload failed");
  }
  auto init = demo.call(1); require(init.ok, "initialization failed"); row(csv, "initialize", demo.tick(), init);
  check_snapshot_hashes(demo);
  if (argc == 9 && std::string(argv[4]) == "--level-transition") {
    // ELF symbol addresses supplied by test_port.py. Change only the local
    // test-double snapshot to trigger the engine's normal level-exit path.
    const uint32_t state_start = std::stoul(argv[5]);
    auto offset = [&](const char *address) { return std::stoul(address) - state_start; };
    auto read_word = [&](uint32_t off) {
      return load_u32_le(demo.storage.at(key(2, off / GH_DOOM_SNAPSHOT_PAGE_BYTES)),
                         off % GH_DOOM_SNAPSHOT_PAGE_BYTES);
    };
    const uint32_t action_offset = offset(argv[6]), map_offset = offset(argv[7]);
    // In the pinned RV32 layout, player_t starts with mo; mobj_t starts
    // with a 12-byte thinker_t followed by fixed-point x and y.
    auto position = [&]() {
      const auto mo = read_word(offset(argv[8])) - state_start;
      return std::array<int64_t, 2>{int32_t(read_word(mo + 12)), int32_t(read_word(mo + 16))};
    };
    const auto checkpoint = demo.storage;
    const auto origin = position();
    require(demo.call(2, step_input(demo.tick(), 0xad)).ok, "forward step failed");
    const auto forward = position();
    demo.storage = checkpoint;
    require(demo.call(2, step_input(demo.tick(), 0xaf)).ok, "backward step failed");
    const auto backward = position();
    const auto fx = forward[0] - origin[0], fy = forward[1] - origin[1];
    const auto bx = backward[0] - origin[0], by = backward[1] - origin[1];
    require(fx * bx + fy * by < 0, "down arrow did not move opposite to up arrow");
    const auto forward_distance = fx * fx + fy * fy, backward_distance = bx * bx + by * by;
    require(backward_distance < forward_distance * 2 && forward_distance < backward_distance * 2,
            "backward movement speed differs from forward movement");
    demo.storage = checkpoint;
    const auto initial_frame = demo.frame();
    auto &page = demo.storage.at(key(2, action_offset / GH_DOOM_SNAPSHOT_PAGE_BYTES));
    store_u32_le(page, action_offset % GH_DOOM_SNAPSHOT_PAGE_BYTES, 6); // ga_completed
    auto &hashes = demo.storage.at(key(0, 3));
    SHA256(page.data(), page.size(), hashes.data() + action_offset / GH_DOOM_SNAPSHOT_PAGE_BYTES * 32);
    for (int i = 0; i < 600 && read_word(map_offset) == 1; ++i) {
      // Press/release fire to advance the intermission screens.
      require(demo.call(2, step_input(demo.tick(), i % 2 ? 0x9d : -1)).ok,
              "level transition tick failed");
    }
    require(read_word(map_offset) == 2, "did not reach E1M2");
    const auto frame = demo.frame();
    // Top three status-bar rows contain the fixed bar background, no widgets.
    require(std::equal(initial_frame.begin() + 168 * 320, initial_frame.begin() + 171 * 320,
                       frame.begin() + 168 * 320), "E1M2 HUD retained intermission pixels");
    ppm(dir + "/level-two.ppm", frame);
    check_snapshot_hashes(demo);
    std::cout << "PASS: forward/backward direction and speed, E1M1 exit, intermission, E1M2 status-bar background\n";
    return 0;
  }
  ppm(dir + "/initial.ppm", demo.frame());
  std::cout << "Initialized tick " << demo.tick() << " in " << init.ms << " ms; gas " << init.gas << '\n';
  auto checkpoint = demo.storage;
  auto input = step_input(demo.tick(), 0xad);
  auto first = demo.call(2, input); require(first.ok, "first tick failed"); auto expected = demo.storage;
  auto moved_frame = demo.frame();
  demo.storage = checkpoint;
  require(demo.call(2, step_input(demo.tick())).ok && demo.frame() != moved_frame, "movement did not affect rendering");
  demo.storage = checkpoint;
  auto second = demo.call(2, input); require(second.ok && demo.storage == expected && first.gas == second.gas, "nondeterministic restore/replay");
  auto saved = demo.storage;
  require(!demo.call(2, input).ok && demo.storage == saved, "stale tick modified state");
  require(!demo.call(1).ok && demo.storage == saved, "reinitialization modified state");
  require(!demo.call(0, Bytes(9)).ok && demo.storage == saved, "sealed WAD was modified");
  require(!demo.call(2, Bytes(35)).ok && demo.storage == saved, "malformed step modified state");
  require(!demo.call(999).ok && demo.storage == saved, "unknown method modified state");
  auto next = step_input(demo.tick(), 0xad);
  auto successful = demo.call(2, next); require(successful.ok, "budget reference step failed");
  demo.storage = saved;
  auto oog = demo.call(2, next, successful.gas-1);
  require(!oog.ok && oog.writes > 0 && demo.storage == saved, "out-of-gas leaked writes or did not exercise partial writes");
  require(demo.call(2, next).ok, "retry after out-of-gas failed");
  Bytes assembled;
  for (uint32_t i = 0; i < 64; ++i) {
    Bytes request; append_u32(request, demo.tick()); append_u32(request, i);
    auto part = demo.call(3, request); require(part.ok && part.returned.size() <= 1024, "frame chunk failed");
    assembled.insert(assembled.end(), part.returned.begin(), part.returned.end());
  }
  require(assembled == demo.frame(), "frame readback mismatch");
  int ticks = argc > 4 ? std::stoi(argv[4]) : 70;
  for (int i = 0; i < ticks; ++i) {
    int held = i < ticks/3 ? 0xad : i < ticks*2/3 ? 0xae : 0x9d;
    auto r = demo.call(2, step_input(demo.tick(), held)); require(r.ok, "gameplay tick failed");
    row(csv, "step", demo.tick(), r);
    if (i % 7 == 0) ppm(dir + "/frame-" + std::to_string(demo.tick()) + ".ppm", demo.frame());
  }
  ppm(dir + "/final.ppm", demo.frame()); write_file(dir + "/frame.bin", demo.frame());
  require(demo.frame() != Bytes(64768), "empty framebuffer");
  check_snapshot_hashes(demo);
  std::cout << "PASS: fresh-VM persistence, deterministic replay, stale-tick/reinitialize rejection, "
            << "out-of-gas rollback/retry, 64 frame chunks, gameplay through tick " << demo.tick() << '\n';
  return 0;
} catch (const std::exception &e) { std::cerr << "ERROR: " << e.what() << '\n'; return 1; }
