import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import {
  getPoolRegistryStatus,
  getRegistryPools,
  RegistryClientError,
  requestPoolRegistrySync,
  type RegistryPool,
} from "@/registry/client";

const id = (value: number) => toBase58(new Uint8Array(32).fill(value));
const config: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0xab)),
  accountAddress: contractAddress(new Uint8Array(32).fill(1)),
  routerAddress: contractAddress(new Uint8Array(32).fill(2)),
  factoryAddress: contractAddress(new Uint8Array(32).fill(3)),
  nativeHogAddress: contractAddress(new Uint8Array(32).fill(4)),
};

describe("pool registry client", () => {
  it("builds a normalized same-origin pool query and propagates its abort signal", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(page()));

    await getRegistryPools(
      config,
      {
        q: "  Ａ  ",
        token: id(10),
        sort: "oldest",
        limit: 20,
        offset: 0,
        asOfBlock: "12",
      },
      signal,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      `/api/pools?sort=oldest&limit=20&offset=0&q=A&token=${encodeURIComponent(id(10))}&asOfBlock=12`,
      { method: "GET", signal },
    );
  });

  it("gets status and posts an empty same-origin sync request", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn()
      .mockImplementation(async () => jsonResponse(status()));
    await getPoolRegistryStatus(config, signal, fetcher);
    await requestPoolRegistrySync(config, signal, fetcher);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/registry/status",
      { method: "GET", signal },
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/registry/sync",
      { method: "POST", signal },
    ]);
    expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty("body");
  });

  it.each([
    ["HTTP failure", new Response("{}", { status: 503 }), /503/],
    [
      "wrong content type",
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      /invalid response/,
    ],
    [
      "invalid JSON",
      new Response("{", { headers: { "content-type": "application/json" } }),
      /invalid JSON/,
    ],
    [
      "declared oversized body",
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
        },
      }),
      /too large/,
    ],
  ])("rejects %s", async (_name, response, message) => {
    await expect(
      getPoolRegistryStatus(
        config,
        undefined,
        vi.fn().mockResolvedValue(response),
      ),
    ).rejects.toThrow(message as RegExp);
  });

  it("bounds streamed responses even without content-length", async () => {
    await expect(
      getPoolRegistryStatus(
        config,
        undefined,
        vi.fn().mockResolvedValue(
          new Response(new Uint8Array(256 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ).rejects.toThrow(/too large/);
  });

  it.each([
    [
      "page network scope",
      (value: ReturnType<typeof page>) => {
        value.networkId = toBase58(new Uint8Array(32).fill(0xff));
      },
    ],
    [
      "page factory scope",
      (value: ReturnType<typeof page>) => {
        value.factoryAddress = id(99);
      },
    ],
    [
      "record network scope",
      (value: ReturnType<typeof page>) => {
        value.pools[0]!.networkId = toBase58(new Uint8Array(32).fill(0xff));
      },
    ],
    [
      "record factory scope",
      (value: ReturnType<typeof page>) => {
        value.pools[0]!.factoryAddress = id(99);
      },
    ],
  ])("rejects a mismatched %s", async (_name, mutate) => {
    const value = page();
    mutate(value);
    await expect(readPage(value)).rejects.toThrow(/different chain scope/);
  });

  it.each([
    [
      "uppercase address",
      (pool: RegistryPool) => {
        pool.token0Address = `0x${"AA".repeat(32)}`;
      },
    ],
    [
      "zero token",
      (pool: RegistryPool) => {
        pool.token0Address = id(0);
      },
    ],
    [
      "reversed pair",
      (pool: RegistryPool) => {
        [pool.token0Address, pool.token1Address] = [
          pool.token1Address,
          pool.token0Address,
        ];
      },
    ],
    [
      "equal pair",
      (pool: RegistryPool) => {
        pool.token1Address = pool.token0Address;
      },
    ],
    [
      "zero child",
      (pool: RegistryPool) => {
        pool.handlerAddress = id(0);
      },
    ],
    [
      "duplicate child",
      (pool: RegistryPool) => {
        pool.driverAddress = pool.handlerAddress;
      },
    ],
    [
      "zero pairCount",
      (pool: RegistryPool) => {
        pool.pairCount = "0";
      },
    ],
    [
      "oversized pairCount",
      (pool: RegistryPool) => {
        pool.pairCount = "4294967296";
      },
    ],
    [
      "noncanonical pairCount",
      (pool: RegistryPool) => {
        pool.pairCount = "01";
      },
    ],
    [
      "numeric event sequence",
      (pool: RegistryPool) => {
        pool.eventSequence = 1 as never;
      },
    ],
    [
      "oversized event sequence",
      (pool: RegistryPool) => {
        pool.eventSequence = "4294967296";
      },
    ],
    [
      "malformed transaction hash",
      (pool: RegistryPool) => {
        pool.transactionHash = "0x12";
      },
    ],
    [
      "noncanonical block",
      (pool: RegistryPool) => {
        pool.createdBlock = "012";
      },
    ],
    [
      "zero created block",
      (pool: RegistryPool) => {
        pool.createdBlock = "0";
      },
    ],
    [
      "invalid timestamp",
      (pool: RegistryPool) => {
        pool.indexedAt = "yesterday";
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    const value = page();
    mutate(value.pools[0]!);
    await expect(readPage(value)).rejects.toThrow(RegistryClientError);
  });

  it.each([
    [
      "pair",
      (left: RegistryPool, right: RegistryPool) => {
        right.token0Address = left.token0Address;
        right.token1Address = left.token1Address;
      },
    ],
    [
      "event",
      (left: RegistryPool, right: RegistryPool) => {
        right.transactionHash = left.transactionHash;
        right.eventSequence = left.eventSequence;
      },
    ],
    [
      "liquidity token",
      (left: RegistryPool, right: RegistryPool) => {
        right.liquidityTokenAddress = left.liquidityTokenAddress;
      },
    ],
    [
      "handler",
      (left: RegistryPool, right: RegistryPool) => {
        right.handlerAddress = left.handlerAddress;
      },
    ],
    [
      "driver",
      (left: RegistryPool, right: RegistryPool) => {
        right.driverAddress = left.driverAddress;
      },
    ],
    [
      "pairCount",
      (left: RegistryPool, right: RegistryPool) => {
        right.pairCount = left.pairCount;
      },
    ],
  ])("rejects duplicate %s evidence", async (_name, mutate) => {
    const value = page([pool(1), pool(2)]);
    mutate(value.pools[0]!, value.pools[1]!);
    await expect(readPage(value)).rejects.toThrow(/duplicate/);
  });

  it("rejects snapshot, filter, search, sort, pagination, total, and hasMore contradictions", async () => {
    const cases = [
      { ...page(), asOfBlock: "11" },
      { ...page(), limit: 10 },
      { ...page(), offset: 1 },
      { ...page(), total: 0 },
      { ...page(), hasMore: true },
      page([pool(2), pool(1)]),
    ];
    for (const value of cases)
      await expect(readPage(value)).rejects.toThrow(RegistryClientError);
    await expect(readPage(page(), { token: id(9) })).rejects.toThrow(
      /token filter/,
    );
    await expect(readPage(page(), { q: "not-present" })).rejects.toThrow(
      /search result/,
    );
  });

  it("accepts case-sensitive base58 search results and text-ordered token sorts", async () => {
    const value = page();
    const fragment = value.pools[0]!.handlerAddress.slice(-10);
    expect(fragment).not.toBe(fragment.toLowerCase());
    await expect(readPage(value, { q: fragment })).resolves.toMatchObject({
      pools: [{ handlerAddress: value.pools[0]!.handlerAddress }],
    });
    await expect(
      readPage(value, { q: fragment.toLowerCase() }),
    ).rejects.toThrow(/search result/);

    // 31 zero bytes then 57 is "1…1z"; then 58 is "1…121". Byte order puts 57
    // first, but display sorts follow the base58 text, which puts 58 first.
    const low = (last: number) => {
      const bytes = new Uint8Array(32);
      bytes[31] = last;
      return toBase58(bytes);
    };
    const first = {
      ...pool(1),
      token0Address: low(57),
      token1Address: id(200),
    };
    const second = {
      ...pool(2),
      token0Address: low(58),
      token1Address: id(201),
    };
    const sorted = (pools: ReturnType<typeof pool>[]) =>
      getRegistryPools(
        config,
        { sort: "token0", limit: 20, offset: 0, asOfBlock: "12" },
        undefined,
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ ...page(pools), total: pools.length }),
          ),
      );
    await expect(sorted([second, first])).resolves.toMatchObject({
      pools: [{ token0Address: low(58) }, { token0Address: low(57) }],
    });
    await expect(sorted([first, second])).rejects.toThrow(RegistryClientError);
  });

  it("requires every expected page slot to be present", async () => {
    await expect(
      readPage({ ...page(), total: 2, hasMore: true }),
    ).rejects.toThrow(/pools/);
    await expect(
      readPage({ ...page([]), total: 1, hasMore: true }),
    ).rejects.toThrow(/pools/);
  });

  it("accepts the maximum Thruput u32 event sequence", async () => {
    const value = page();
    value.pools[0]!.eventSequence = "4294967295";
    await expect(readPage(value)).resolves.toMatchObject({
      pools: [{ eventSequence: "4294967295" }],
    });
  });

  it("rejects unknown response fields and malformed status semantics", async () => {
    await expect(readPage({ ...page(), unexpected: true })).rejects.toThrow(
      /pool page/,
    );
    await expect(
      getPoolRegistryStatus(
        config,
        undefined,
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ ...status(), syncState: "idle", syncing: true }),
          ),
      ),
    ).rejects.toThrow(/syncing/);
    await expect(
      getPoolRegistryStatus(
        config,
        undefined,
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ ...status(), lastSuccessfulSyncAt: "bad" }),
          ),
      ),
    ).rejects.toThrow(/lastSuccessfulSyncAt/);
  });
});

function readPage(
  value: unknown,
  additions: { token?: string; q?: string } = {},
) {
  return getRegistryPools(
    config,
    { sort: "oldest", limit: 20, offset: 0, asOfBlock: "12", ...additions },
    undefined,
    vi.fn().mockResolvedValue(jsonResponse(value)),
  );
}

function pool(index = 1): RegistryPool {
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
    createdBlock: String(10 + index),
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function page(pools = [pool()]) {
  return {
    networkId: config.networkId,
    factoryAddress: id(3),
    pools,
    total: pools.length,
    limit: 20,
    offset: 0,
    asOfBlock: "12",
    hasMore: false,
    historyLimited: false,
  };
}

function status() {
  return {
    networkId: config.networkId,
    factoryAddress: id(3),
    indexedThroughBlock: "12",
    poolCount: 1,
    historyLimited: false,
    syncState: "idle",
    syncing: false,
    lastSuccessfulSyncAt: "2026-09-05T00:00:00.000Z",
    lastError: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
