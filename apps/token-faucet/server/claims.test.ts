import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { toBase58 } from "@thruputchain/client";
import { ClaimStore, publicClaim } from "./store";
import { DEFAULT_POLICY } from "./config";
import { Claims } from "./claims";
import type { ClaimChain } from "./chain";
import type { PublicConfig } from "../shared/config";

const address = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const config: PublicConfig = {
  networkId: address(1),
  anchorHeight: "1",
  anchorHash: address(2),
  faucetAddress: address(3),
  tokens: [],
  cooldownSeconds: 86400,
  swapUrl: "http://localhost:5174",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function store(policy = DEFAULT_POLICY) {
  const value = new ClaimStore(":memory:", config, policy);
  cleanup.push(() => value.close());
  return value;
}
describe("claim quotas", () => {
  it("counts delayed confirmations against the current payout window", () => {
    const db = store({ ...DEFAULT_POLICY, dailyClaims: 1 });
    const id = randomUUID();
    db.reserve(id, address(4), "ip1", 1000);
    db.saveSigned(id, address(8), "0x1234");
    const now = 3 * 86400000;
    db.finish(id, "confirmed", now);
    expect(() => db.reserve(randomUUID(), address(5), "ip2", now + 1)).toThrow(
      "daily",
    );
  });
  it("keeps one pending payout per address, including across cooldown windows", () => {
    const db = store();
    const first = db.reserve(randomUUID(), address(4), "ip", 1000).claim;
    expect(
      db.reserve(randomUUID(), address(4), "other-ip", 1000 + 3 * 86400000)
        .claim.id,
    ).toBe(first.id);
    expect(db.countPending()).toBe(1);
    expect(() => db.reserve(first.id, address(5), "ip")).toThrow(
      "another recipient",
    );
  });
  it("applies IP limits across addresses and global caps across IPs", () => {
    const db = store({ ...DEFAULT_POLICY, ipClaims: 1, dailyClaims: 2 });
    db.reserve(randomUUID(), address(4), "ip1");
    expect(() => db.reserve(randomUUID(), address(5), "ip1")).toThrow("hourly");
    db.reserve(randomUUID(), address(5), "ip2");
    expect(() => db.reserve(randomUUID(), address(6), "ip3")).toThrow("daily");
  });
  it("retains unresolved reservations in global caps after a day", () => {
    const db = store({ ...DEFAULT_POLICY, dailyClaims: 1 });
    db.reserve(randomUUID(), address(4), "ip1", 1000);
    expect(() =>
      db.reserve(randomUUID(), address(5), "ip2", 3 * 86400000),
    ).toThrow("daily");
  });
  it("starts a new cooldown on terminal outcome and retains failed-claim quotas", () => {
    const db = store();
    const claim = db.reserve(randomUUID(), address(4), "ip", 1000).claim;
    db.finish(claim.id, "failed", 2000);
    expect(() => db.reserve(randomUUID(), address(4), "ip", 2001)).toThrow(
      "cooldown",
    );
    expect(db.get(claim.id)?.retryAt).toBe(2000 + DEFAULT_POLICY.cooldownMs);
  });
  it("limits request rates and expires the window", () => {
    const db = store({ ...DEFAULT_POLICY, requestsPerMinute: 2 });
    db.rateLimit("ip", 1000);
    db.rateLimit("ip", 1001);
    expect(() => db.rateLimit("ip", 1002)).toThrow("Too many");
    expect(() => db.rateLimit("ip", 61000)).not.toThrow();
  });
});
describe("durable payout evidence", () => {
  it("returns a pending claim even when inventory is unavailable", async () => {
    const db = store();
    const id = randomUUID();
    db.reserve(id, address(4), "ip");
    db.saveSigned(id, address(8), "0x1234");
    const claims = new Claims(config, db, {
      check: async () => {},
      inventory: async () => ({ balances: [], packs: 0 }),
      prepare: async () => {
        throw new Error("Must not prepare a replacement");
      },
      observe: async () => "pending",
    });
    expect(claims.publicConfig().available).toBe(false);
    expect(claims.claim(randomUUID(), address(4), "other-ip").id).toBe(id);
  });
  it("survives restart and rejects a changed deployment", () => {
    const directory = mkdtempSync(join(tmpdir(), "token-faucet-"));
    cleanup.push(() => rmSync(directory, { recursive: true }));
    const path = join(directory, "claims.sqlite");
    const first = new ClaimStore(path, config, DEFAULT_POLICY);
    const claim = first.reserve(randomUUID(), address(4), "ip").claim;
    first.saveSigned(claim.id, address(8), "0x1234");
    first.close();
    const second = new ClaimStore(path, config, DEFAULT_POLICY);
    second.recoverUnsigned();
    expect(second.get(claim.id)?.signed).toBe("0x1234");
    expect(second.get(claim.id)?.status).toBe("pending");
    expect(publicClaim(second.get(claim.id)!)).not.toHaveProperty("signed");
    second.close();
    expect(
      () =>
        new ClaimStore(
          path,
          { ...config, anchorHash: address(9) },
          DEFAULT_POLICY,
        ),
    ).toThrow("another deployment");
  });
  it("persists before broadcast and never replaces an uncertain payout", async () => {
    const db = store();
    const id = randomUUID();
    const broadcast = vi.fn(async () => {
      expect(db.get(id)?.signed).toBe("0x1234");
      throw new Error("connection lost");
    });
    const chain: ClaimChain = {
      check: vi.fn(async () => {}),
      inventory: vi.fn(async () => ({ balances: [], packs: 100 })),
      prepare: vi.fn(async () => ({
        hash: address(8),
        signed: "0x1234",
        broadcast,
      })),
      observe: vi.fn(async () => "pending" as const),
    };
    const claims = new Claims(config, db, chain);
    await claims.start();
    await claims.tick();
    claims.claim(id, address(4), "ip");
    await claims.tick();
    await claims.tick();
    expect(db.get(id)?.status).toBe("pending");
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await claims.stop();
    const restarted = new Claims(config, db, chain);
    await restarted.start();
    await restarted.tick();
    await restarted.stop();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(claims.claim(randomUUID(), address(4), "ip2").id).toBe(id);
  });
  it("does not broadcast if evidence cannot be saved", async () => {
    const db = store();
    const broadcast = vi.fn(async () => {});
    vi.spyOn(db, "saveSigned").mockImplementation(() => {
      throw new Error("disk full");
    });
    const chain: ClaimChain = {
      check: async () => {},
      inventory: async () => ({ balances: [], packs: 100 }),
      prepare: async () => ({ hash: address(8), signed: "0x1234", broadcast }),
      observe: async () => "pending",
    };
    const claims = new Claims(config, db, chain);
    await claims.start();
    await claims.tick();
    const id = randomUUID();
    claims.claim(id, address(4), "ip");
    await claims.tick();
    await claims.stop();
    expect(broadcast).not.toHaveBeenCalled();
    expect(db.get(id)?.status).toBe("failed");
  });
});
