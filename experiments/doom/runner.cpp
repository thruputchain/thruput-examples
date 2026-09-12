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
      require(a.a2 <= 1024 && a.a3 == 0 && a.a5 == 0, "return limit or unexpected revert/tokens");
      auto b = bytes(a.a1, a.a2); returned.assign(b.begin(), b.end());
      did_return = true; host_gas += charge; return HostResult::halt(0, charge);
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
      require(a.a3 <= GH_DOOM_PAGE_BYTES && a.a4 == 0, "configured bytestring limit or flags");
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

static void send_frame(const Demo &demo, const Result &r) {
  static constexpr char hex[] = "0123456789abcdef";
  std::cout << "FRAME " << demo.tick() << ' ' << r.gas << ' ' << r.read_bytes << ' '
            << r.written_bytes << ' ' << r.ms << ' ';
  for (uint8_t b : demo.frame()) std::cout << hex[b >> 4] << hex[b & 15];
  std::cout << '\n' << std::flush;
}
static int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  throw std::runtime_error("bad input hex");
}
static void serve(Demo &demo, const Result &init) {
  send_frame(demo, init);
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      std::istringstream in(line); std::string op, bitmap, trailing; uint32_t tick;
      require(bool(in >> op >> tick >> bitmap) && !(in >> trailing) && op == "STEP" && bitmap.size() == 64, "bad command");
      Bytes input; append_u32(input, tick);
      for (size_t i = 0; i < bitmap.size(); i += 2) input.push_back(nibble(bitmap[i])*16 + nibble(bitmap[i+1]));
      auto result = demo.call(2, std::move(input)); require(result.ok, "contract rejected step");
      send_frame(demo, result);
    } catch (const std::exception &e) { std::cout << "ERROR " << e.what() << '\n' << std::flush; }
  }
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
  for (uint32_t off = 0; off < wad.size(); off += GH_DOOM_PAGE_BYTES) {
    Bytes upload; append_u32(upload, off/GH_DOOM_PAGE_BYTES); append_u32(upload, wad.size());
    upload.insert(upload.end(), wad.begin()+off, wad.begin()+std::min<size_t>(off+GH_DOOM_PAGE_BYTES, wad.size()));
    auto result = demo.call(0, std::move(upload)); require(result.ok, "upload failed");
  }
  auto init = demo.call(1); require(init.ok, "initialization failed"); row(csv, "initialize", demo.tick(), init);
  if (argc > 4 && std::string(argv[4]) == "--serve") { serve(demo, init); return 0; }
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
  std::cout << "PASS: fresh-VM persistence, deterministic replay, stale-tick/reinitialize rejection, "
            << "out-of-gas rollback/retry, 64 frame chunks, gameplay through tick " << demo.tick() << '\n';
  return 0;
} catch (const std::exception &e) { std::cerr << "ERROR: " << e.what() << '\n'; return 1; }
