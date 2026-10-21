import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import type { RegistryPool } from "@/registry/client";
import { enrichRegistryPools, registryPoolsToEntries } from "@/registry/pools";
import type { PoolSnapshot } from "@/swap/snapshot";

const address = (value: number) =>
  contractAddress(new Uint8Array(32).fill(value));
const id = (value: number) => toBase58(new Uint8Array(32).fill(value));
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
};

describe("registry pool enrichment", () => {
  it("runs at most four live pool reads and isolates per-entry failures", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const readPool = vi.fn(
      async (_config: GlobalConfig, pool: RegistryPool) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;
        if (pool.pairCount === "5") throw new Error("view failed");
        return live(pool);
      },
    );
    const entries = registryPoolsToEntries(
      Array.from({ length: 6 }, (_, index) => pool(index + 1)),
    );
    const resultPromise = enrichRegistryPools(
      config,
      entries,
      { simulateInvocation: vi.fn() },
      undefined,
      readPool,
    );
    await vi.waitFor(() => expect(readPool).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(readPool).toHaveBeenCalledTimes(6));
    pending.splice(0).forEach((resolve) => resolve());
    const result = await resultPromise;
    expect(maximumActive).toBe(4);
    expect(result[4]).toMatchObject({
      live: null,
      loading: false,
      readError: true,
    });
    expect(result[5]).toMatchObject({ loading: false, readError: false });
  });

  it("treats registry-to-factory child identity mismatches as an entry failure", async () => {
    const entry = registryPoolsToEntries([pool(1)]);
    const result = await enrichRegistryPools(
      config,
      entry,
      { simulateInvocation: vi.fn() },
      undefined,
      async (_config, record) => ({
        ...live(record),
        config: { ...live(record).config, handlerAddress: address(99) },
      }),
    );
    expect(result[0]).toMatchObject({ live: null, readError: true });
  });

  it("propagates cancellation rather than converting it to a read failure", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stale", "AbortError"));
    await expect(
      enrichRegistryPools(
        config,
        registryPoolsToEntries([pool(1)]),
        { simulateInvocation: vi.fn() },
        controller.signal,
        async () => live(pool(1)),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the enrichment signal to the pool reader", async () => {
    const signal = new AbortController().signal;
    const readPool = vi.fn(async () => live(pool(1)));
    await enrichRegistryPools(
      config,
      registryPoolsToEntries([pool(1)]),
      { simulateInvocation: vi.fn() },
      signal,
      readPool,
    );
    expect(readPool).toHaveBeenCalledWith(config, expect.any(Object), signal);
  });
});

function pool(index: number): RegistryPool {
  return {
    networkId: config.networkId,
    factoryAddress: id(3),
    token0Address: id(index * 10),
    token1Address: id(index * 10 + 1),
    liquidityTokenAddress: id(index * 10 + 2),
    handlerAddress: id(index * 10 + 3),
    driverAddress: id(index * 10 + 4),
    pairCount: String(index),
    transactionHash: id(index * 10 + 5),
    eventSequence: String(index - 1),
    createdBlock: String(index),
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function live(pool: RegistryPool) {
  return {
    config: {
      ...config,
      liquidityTokenAddress: address(Number(pool.pairCount) * 10 + 2),
      handlerAddress: address(Number(pool.pairCount) * 10 + 3),
      driverAddress: address(Number(pool.pairCount) * 10 + 4),
      tokenAAddress: address(Number(pool.pairCount) * 10),
      tokenBAddress: address(Number(pool.pairCount) * 10 + 1),
      tokenASymbol: "A",
      tokenBSymbol: "B",
      tokenADecimals: 6,
      tokenBDecimals: 6,
    } satisfies AppConfig,
    snapshot: {} as PoolSnapshot,
  };
}
