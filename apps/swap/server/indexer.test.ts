// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RegistryCursorRejectedError,
  RegistryIntegrityError,
  type RegistrySource,
  type RegistrySourcePage,
} from "./chain.ts";
import type { RegistryPool, RegistryScope } from "../shared/registry.ts";
import { RegistryIndexer } from "./indexer.ts";
import { RegistryStore } from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: address(200),
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RegistryIndexer", () => {
  it("starts at block 1 and ingests ascending pages through one fixed target", async () => {
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([
      page([pool(1, "4")], "next", "10"),
      page([pool(2, "10"), pool(3, "11")], "later", "12"),
    ]);

    await createIndexer(store, source).sync();

    expect(source.requests).toEqual([
      { anchorBlock: "1", cursor: null, limit: 2 },
      { anchorBlock: "1", cursor: "next", limit: 2 },
    ]);
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      poolCount: 2,
      syncState: "idle",
    });
    expect(source.verifications).toBe(3);
    store.close();
  });

  it("accepts only the exact anchor-minus-one no-new-blocks response", async () => {
    const fresh = new RegistryStore(":memory:", scope);
    await createIndexer(fresh, queuedSource([page([], null, "0")])).sync();
    expect(fresh.getStatus()).toMatchObject({
      indexedThroughBlock: "0",
      poolCount: 0,
      syncState: "idle",
      lastError: null,
    });
    fresh.close();

    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([page([], null, "5"), page([], null, "5")]);
    const indexer = createIndexer(store, source);
    await indexer.sync();
    await indexer.sync();
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "5",
      poolCount: 0,
    });
    expect(source.requests[1]?.anchorBlock).toBe("6");
    store.close();
  });

  it("treats a no-scan source regression below indexed height as transient", async () => {
    const store = new RegistryStore(":memory:", scope);
    const firstSuccess = new Date("2026-09-05T12:00:00.000Z");
    await createIndexer(store, queuedSource([page([], null, "5")]), {
      now: () => firstSuccess,
    }).sync();
    expect(store.getStatus().lastSuccessfulSyncAt).toBe(
      firstSuccess.toISOString(),
    );

    await createIndexer(store, queuedSource([page([], null, "4")]), {
      maximumRetries: 0,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    }).sync();

    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "5",
      syncState: "idle",
      lastSuccessfulSyncAt: firstSuccess.toISOString(),
      lastError: "Registry synchronization is temporarily unavailable",
    });
    store.close();
  });

  it("resumes a durable cursor and target after reopening", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = new RegistryStore(databasePath, scope);
    first.beginScan("1", "10");
    first.commitPage([pool(1, "4")], "persisted");
    first.close();
    const store = new RegistryStore(databasePath, scope);
    const source = queuedSource([page([pool(2, "9")], null, "20")]);

    await createIndexer(store, source).sync();

    expect(source.requests[0]).toMatchObject({
      anchorBlock: "1",
      cursor: "persisted",
    });
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      poolCount: 2,
    });
    store.close();
  });

  it("preserves a durable scan when a restarted source lags its target", async () => {
    const databasePath = await temporaryDatabasePath();
    const seeded = new RegistryStore(databasePath, scope);
    seeded.beginScan("1", "10");
    seeded.commitPage([pool(1, "4")], "persisted");
    seeded.close();

    const lagging = new RegistryStore(databasePath, scope);
    const laggingSource = queuedSource([page([pool(2, "9")], null, "9")]);
    await createIndexer(lagging, laggingSource, { maximumRetries: 0 }).sync();
    expect(lagging.getStatus()).toMatchObject({
      indexedThroughBlock: "0",
      poolCount: 1,
      syncState: "idle",
      lastError: "Registry synchronization is temporarily unavailable",
    });
    expect(lagging.getScan()).toEqual({
      anchorBlock: "1",
      targetBlock: "10",
      nextCursor: "persisted",
    });
    lagging.close();

    const recovered = new RegistryStore(databasePath, scope);
    const recoveredSource = queuedSource([page([pool(2, "9")], null, "10")]);
    await createIndexer(recovered, recoveredSource).sync();
    expect(recovered.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      poolCount: 2,
      syncState: "idle",
      lastError: null,
    });
    expect(recoveredSource.requests[0]?.cursor).toBe("persisted");
    recovered.close();
  });

  it("retries a lagging durable source without committing the lagging page", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1, "4")], "persisted");
    const source = queuedSource([
      page([pool(2, "9")], null, "9"),
      page([pool(2, "9")], null, "10"),
    ]);
    const countsDuringBackoff: number[] = [];

    await createIndexer(store, source, {
      sleep: async () => {
        countsDuringBackoff.push(store.getStatus().poolCount);
      },
    }).sync();

    expect(countsDuringBackoff).toEqual([1]);
    expect(source.requests.map(({ cursor }) => cursor)).toEqual([
      "persisted",
      "persisted",
    ]);
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      poolCount: 2,
      syncState: "idle",
    });
    store.close();
  });

  it("replays an invalid cursor once from the durable anchor", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1, "4")], "expired");
    const source = queuedSource([
      new RegistryCursorRejectedError(),
      page([pool(1, "4"), pool(2, "8")], null, "12"),
    ]);

    await createIndexer(store, source).sync();

    expect(source.requests.map(({ cursor }) => cursor)).toEqual([
      "expired",
      null,
    ]);
    expect(store.getStatus().poolCount).toBe(2);
    store.close();
  });

  it("enters an integrity fault when a replayed scan cursor is rejected", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([], "expired");
    const source = queuedSource([
      new RegistryCursorRejectedError(),
      page([], "replacement", "10"),
      new RegistryCursorRejectedError(),
    ]);

    await createIndexer(store, source).sync();

    expect(source.requests.map(({ cursor }) => cursor)).toEqual([
      "expired",
      null,
      "replacement",
    ]);
    expect(store.getStatus()).toMatchObject({
      syncState: "integrityFault",
      lastError: "The replayed registry cursor was rejected",
    });
    store.close();
  });

  it("retains the one-replay budget across transient scan retries", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([], "expired");
    const source = queuedSource([
      new RegistryCursorRejectedError(),
      page([], "replacement", "10"),
      new Error("temporary outage"),
      new RegistryCursorRejectedError(),
    ]);

    await createIndexer(store, source).sync();

    expect(store.getStatus().syncState).toBe("integrityFault");
    expect(source.requests.map(({ cursor }) => cursor)).toEqual([
      "expired",
      null,
      "replacement",
      "replacement",
    ]);
    store.close();
  });

  it("halts on repeated cursors and immutable evidence conflicts", async () => {
    const repeatedStore = new RegistryStore(":memory:", scope);
    await createIndexer(
      repeatedStore,
      queuedSource([page([], "repeat", "10"), page([], "repeat", "10")]),
    ).sync();
    expect(repeatedStore.getStatus().syncState).toBe("integrityFault");
    repeatedStore.close();

    const conflictStore = new RegistryStore(":memory:", scope);
    conflictStore.beginScan("1", "10");
    conflictStore.commitPage([pool(1, "4")], "next");
    await createIndexer(
      conflictStore,
      queuedSource([
        page([{ ...pool(1, "4"), driverAddress: address(99) }], null, "10"),
      ]),
    ).sync();
    expect(conflictStore.getStatus().syncState).toBe("integrityFault");
    expect(conflictStore.getScan()?.nextCursor).toBe("next");
    conflictStore.close();
  });

  it("persists retained-prefix baselines and rejects later pair-count gaps", async () => {
    const limited = new RegistryStore(":memory:", scope);
    await createIndexer(
      limited,
      queuedSource([page([pool(5, "7"), pool(6, "8")], null, "8", "7")]),
    ).sync();
    expect(limited.getStatus()).toMatchObject({
      historyLimited: true,
      poolCount: 2,
    });
    limited.close();

    const gap = new RegistryStore(":memory:", scope);
    await createIndexer(
      gap,
      queuedSource([page([pool(1, "4"), pool(3, "5")], null, "5")]),
    ).sync();
    expect(gap.getStatus()).toMatchObject({
      syncState: "integrityFault",
      poolCount: 0,
    });
    gap.close();
  });

  it("faults when retention advances during a continuation page", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1, "4")], "persisted");

    await createIndexer(
      store,
      queuedSource([page([pool(2, "9")], null, "10", "5")]),
    ).sync();

    expect(store.getStatus()).toMatchObject({
      syncState: "integrityFault",
      poolCount: 1,
      historyLimited: false,
      lastError: "RPC reported a retention gap on a continuation page",
    });
    expect(store.getScan()?.nextCursor).toBe("persisted");
    store.close();
  });

  it("retries transient failures without resetting a durable cursor", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([], "durable");
    const source = queuedSource([
      new Error("upstream unavailable"),
      page([], null, "10"),
    ]);
    const states: string[] = [];

    await createIndexer(store, source, {
      sleep: async () => {
        states.push(store.getStatus().syncState);
      },
    }).sync();

    expect(states).toEqual(["retrying"]);
    expect(source.requests.map(({ cursor }) => cursor)).toEqual([
      "durable",
      "durable",
    ]);
    expect(store.getStatus()).toMatchObject({
      syncState: "idle",
      lastError: null,
    });
    store.close();
  });

  it("retries transient network verification failures", async () => {
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([page([], null, "0")]);
    source.verifyNetworkIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue(undefined);

    await createIndexer(store, source, { sleep: async () => undefined }).sync();

    expect(source.verifyNetworkIdentity).toHaveBeenCalledTimes(2);
    expect(store.getStatus()).toMatchObject({
      syncState: "idle",
      lastError: null,
    });
    store.close();
  });

  it("sanitizes exhausted transport errors", async () => {
    const store = new RegistryStore(":memory:", scope);
    await createIndexer(
      store,
      queuedSource([new Error("https://rpc.invalid/?secret=credential")]),
      { maximumRetries: 0 },
    ).sync();
    expect(store.getStatus().lastError).toBe(
      "Registry synchronization is temporarily unavailable",
    );
    store.close();
  });

  it("coalesces active requests into one trailing scan with a one-second cooldown", async () => {
    const store = new RegistryStore(":memory:", scope);
    let resolvePage!: (value: RegistrySourcePage) => void;
    const source = queuedSource([
      new Promise<RegistrySourcePage>((resolve) => {
        resolvePage = resolve;
      }),
      page([], null, "0"),
    ]);
    let now = new Date("2026-09-05T12:00:00.000Z");
    const indexer = createIndexer(store, source, { now: () => now });

    indexer.requestSync();
    indexer.requestSync();
    await Promise.resolve();
    expect(source.requests).toHaveLength(1);
    now = new Date(now.valueOf() + 1_001);
    indexer.requestSync();
    resolvePage(page([], null, "0"));
    await indexer.sync();
    expect(source.requests).toHaveLength(2);
    await indexer.stop();
    store.close();
  });

  it("starts periodically, stops terminal work, and aborts active RPC", async () => {
    vi.useFakeTimers();
    const faultStore = new RegistryStore(":memory:", scope);
    const faultSource = queuedSource([
      new RegistryIntegrityError("x".repeat(2_000)),
      page([], null, "0"),
    ]);
    const faultIndexer = createIndexer(faultStore, faultSource, {
      syncIntervalMs: 10,
    });
    faultIndexer.start();
    await vi.runAllTicks();
    await faultIndexer.sync();
    await vi.advanceTimersByTimeAsync(100);
    expect(faultSource.requests).toHaveLength(1);
    expect(
      Buffer.byteLength(faultStore.getStatus().lastError!),
    ).toBeLessThanOrEqual(500);
    await faultIndexer.stop();
    faultStore.close();

    vi.useRealTimers();
    const abortStore = new RegistryStore(":memory:", scope);
    let observedSignal: AbortSignal | undefined;
    const abortSource: RegistrySource = {
      verifyNetworkIdentity: async () => undefined,
      getPage: async (request) => {
        observedSignal = request.signal;
        return new Promise<RegistrySourcePage>((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            {
              once: true,
            },
          ),
        );
      },
    };
    const abortIndexer = createIndexer(abortStore, abortSource);
    abortIndexer.start();
    await Promise.resolve();
    await abortIndexer.stop();
    expect(observedSignal?.aborted).toBe(true);
    expect(abortStore.getStatus().syncState).toBe("idle");
    abortStore.close();
  });
});

function createIndexer(
  store: RegistryStore,
  source: RegistrySource,
  overrides: Partial<ConstructorParameters<typeof RegistryIndexer>[2]> = {},
) {
  return new RegistryIndexer(store, source, {
    pageSize: 2,
    syncIntervalMs: 60_000,
    retryDelayMs: () => 0,
    ...overrides,
  });
}

function queuedSource(
  responses: Array<RegistrySourcePage | Error | Promise<RegistrySourcePage>>,
) {
  const source: RegistrySource & {
    requests: Array<{
      anchorBlock: string;
      cursor: string | null;
      limit: number;
    }>;
    verifications: number;
  } = {
    requests: [],
    verifications: 0,
    async verifyNetworkIdentity(signal) {
      if (signal.aborted) throw signal.reason;
      source.verifications += 1;
    },
    async getPage(request) {
      source.requests.push({
        anchorBlock: request.anchorBlock,
        cursor: request.cursor,
        limit: request.limit,
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected source request");
      if (response instanceof Error) throw response;
      return abortable(response, request.signal);
    },
  };
  return source;
}

function abortable(
  value: RegistrySourcePage | Promise<RegistrySourcePage>,
  signal: AbortSignal,
): Promise<RegistrySourcePage> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    }),
  ]);
}

function page(
  pools: RegistryPool[],
  nextCursor: string | null,
  latestBlock: string,
  oldestBlock = "1",
): RegistrySourcePage {
  return { pools, nextCursor, latestBlock, oldestBlock };
}

function pool(pairCount: number, createdBlock: string): RegistryPool {
  return {
    ...scope,
    token0Address: address(pairCount * 2),
    token1Address: address(pairCount * 2 + 1),
    liquidityTokenAddress: address(pairCount + 60),
    handlerAddress: address(pairCount + 80),
    driverAddress: address(pairCount + 100),
    pairCount: String(pairCount),
    transactionHash: address(pairCount + 120),
    eventSequence: String(pairCount - 1),
    createdBlock,
    indexedAt: "2026-09-05T12:00:00.000Z",
  };
}

function address(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "swap-registry-indexer-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "registry.sqlite");
}
