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
import type { RegistryScope, RegistryToken } from "./domain.ts";
import { RegistryIndexer } from "./indexer.ts";
import { RegistryStore } from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: `0x${"22".repeat(32)}`,
  tokenCodeHash: `0x${"33".repeat(32)}`,
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
  it("ingests ascending pages through one fixed target", async () => {
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([
      page([token(1, "4")], "next", "10"),
      page([token(2, "10"), token(3, "11")], "later", "12"),
    ]);
    const indexer = createIndexer(store, source);

    await indexer.sync();

    expect(source.requests.map((request) => request.cursor)).toEqual([
      null,
      "next",
    ]);
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      tokenCount: 2,
      syncState: "idle",
    });
    store.close();
  });

  it("resumes a committed mid-scan cursor after restart", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = new RegistryStore(databasePath, scope);
    first.beginScan("1", "10");
    first.commitPage([token(1, "4")], "persisted");
    first.close();
    const store = new RegistryStore(databasePath, scope);
    const source = queuedSource([page([token(2, "9")], null, "20")]);

    await createIndexer(store, source).sync();

    expect(source.requests[0]).toMatchObject({
      anchorBlock: "1",
      cursor: "persisted",
    });
    expect(store.getStatus()).toMatchObject({
      indexedThroughBlock: "10",
      tokenCount: 2,
    });
    store.close();
  });

  it("replays from the durable anchor only when an opaque cursor is rejected", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([token(1, "4")], "expired");
    const source = queuedSource([
      new RegistryCursorRejectedError(),
      page([token(1, "4"), token(2, "8")], null, "12"),
    ]);

    await createIndexer(store, source).sync();

    expect(source.requests.map((request) => request.cursor)).toEqual([
      "expired",
      null,
    ]);
    expect(store.getStatus().tokenCount).toBe(2);
    store.close();
  });

  it("bounds repeated rejected-cursor replays", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([], "expired");
    const responses: Array<RegistrySourcePage | Error> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(
        new RegistryCursorRejectedError(),
        page([], `rejected-${attempt}`, "10"),
        new RegistryCursorRejectedError(),
      );
    }
    const source = queuedSource(responses);

    await createIndexer(store, source).sync();

    expect(source.requests).toHaveLength(12);
    expect(store.getStatus()).toMatchObject({
      syncState: "idle",
      lastError: "The registry event cursor was rejected by the RPC",
    });
    expect(store.getScan()?.nextCursor).toBe("rejected-3");
    store.close();
  });

  it("halts on a repeated cursor", async () => {
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([
      page([], "repeat", "10"),
      page([], "repeat", "10"),
    ]);

    await createIndexer(store, source).sync();

    expect(store.getStatus()).toMatchObject({
      syncState: "integrityFault",
      indexedThroughBlock: "0",
    });
    store.close();
  });

  it("treats immutable evidence conflicts as terminal and preserves the scan", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([token(1, "4")], "next");
    const conflicting = { ...token(1, "4"), name: "Conflicting name" };

    await createIndexer(
      store,
      queuedSource([page([conflicting], null, "10")]),
    ).sync();

    expect(store.getStatus().syncState).toBe("integrityFault");
    expect(store.getScan()?.nextCursor).toBe("next");
    store.close();
  });

  it("persists retention gaps and handles no-new-block pages", async () => {
    const limitedStore = new RegistryStore(":memory:", scope);
    await createIndexer(
      limitedStore,
      queuedSource([page([token(1, "5")], null, "5", "5")]),
    ).sync();
    expect(limitedStore.getStatus().historyLimited).toBe(true);
    limitedStore.close();

    const emptyStore = new RegistryStore(":memory:", scope);
    await createIndexer(
      emptyStore,
      queuedSource([page([], null, "0", "1")]),
    ).sync();
    expect(emptyStore.getStatus()).toMatchObject({
      indexedThroughBlock: "0",
      tokenCount: 0,
      syncState: "idle",
    });
    emptyStore.close();
  });

  it("does not report a retention gap through an accepted continuation cursor", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([token(1, "4")], "persisted");

    await createIndexer(
      store,
      queuedSource([page([token(2, "9")], null, "12", "5")]),
    ).sync();

    expect(store.getStatus()).toMatchObject({
      historyLimited: false,
      indexedThroughBlock: "10",
      tokenCount: 2,
    });
    store.close();
  });

  it("retries transient failures without resetting the cursor", async () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([], "durable");
    const source = queuedSource([
      new Error("upstream unavailable"),
      page([], null, "10"),
    ]);
    const states: string[] = [];
    const indexer = createIndexer(store, source, {
      sleep: async () => {
        states.push(store.getStatus().syncState);
      },
    });

    await indexer.sync();

    expect(states).toEqual(["retrying"]);
    expect(source.requests.map((request) => request.cursor)).toEqual([
      "durable",
      "durable",
    ]);
    expect(store.getStatus()).toMatchObject({
      syncState: "idle",
      lastError: null,
    });
    store.close();
  });

  it("does not persist arbitrary transport error details", async () => {
    const store = new RegistryStore(":memory:", scope);
    const secret = "https://rpc.example.test/events?token=private-secret";

    await createIndexer(store, queuedSource([new Error(secret)]), {
      maximumRetries: 0,
    }).sync();

    expect(store.getStatus().lastError).toBe(
      "Registry synchronization is temporarily unavailable",
    );
    expect(JSON.stringify(store.getStatus())).not.toContain(secret);
    expect(JSON.stringify(store.getStatus())).not.toContain("private-secret");
    store.close();
  });

  it("coalesces active requests into one trailing scan", async () => {
    const store = new RegistryStore(":memory:", scope);
    let resolvePage!: (page: RegistrySourcePage) => void;
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

  it("applies public cooldown and stops active work", async () => {
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([new Promise<RegistrySourcePage>(() => {})]);
    let now = new Date("2026-09-05T12:00:00.000Z");
    const indexer = createIndexer(store, source, { now: () => now });

    indexer.requestSync();
    indexer.requestSync();
    await Promise.resolve();
    expect(source.requests).toHaveLength(1);
    now = new Date(now.valueOf() + 1_001);
    indexer.requestSync();
    await indexer.stop();
    expect(store.getStatus().syncState).toBe("idle");
    store.close();
  });

  it("halts automatic work on malformed events and bounds terminal errors", async () => {
    vi.useFakeTimers();
    const store = new RegistryStore(":memory:", scope);
    const source = queuedSource([
      new RegistryIntegrityError("x".repeat(2_000)),
      page([], null, "0"),
    ]);
    const indexer = createIndexer(store, source, { syncIntervalMs: 10 });
    indexer.start();
    await vi.runAllTicks();
    await indexer.sync();
    await vi.advanceTimersByTimeAsync(100);

    expect(source.requests).toHaveLength(1);
    expect(store.getStatus().syncState).toBe("integrityFault");
    expect(Buffer.byteLength(store.getStatus().lastError!)).toBeLessThanOrEqual(
      500,
    );
    await indexer.stop();
    store.close();
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
  const requests: Array<{ anchorBlock: string; cursor: string | null }> = [];
  const source: RegistrySource & {
    responses: Array<RegistrySourcePage | Error | Promise<RegistrySourcePage>>;
    requests: Array<{ anchorBlock: string; cursor: string | null }>;
  } = {
    responses,
    requests,
    async getPage(request): Promise<RegistrySourcePage> {
      requests.push({
        anchorBlock: request.anchorBlock,
        cursor: request.cursor,
      });
      const response:
        RegistrySourcePage | Error | Promise<RegistrySourcePage> | undefined =
        source.responses.shift();
      if (response === undefined) throw new Error("Unexpected source request");
      if (response instanceof Error) throw response;
      return abortable(response, request.signal);
    },
  };
  return source;
}

async function abortable(
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
  tokens: RegistryToken[],
  nextCursor: string | null,
  latestBlock: string,
  oldestBlock = "1",
): RegistrySourcePage {
  return { tokens, nextCursor, latestBlock, oldestBlock };
}

function token(sequence: number, blockHeight: string): RegistryToken {
  const byte = sequence.toString(16).padStart(2, "0");
  return {
    networkId: scope.networkId,
    factoryAddress: scope.factoryAddress,
    tokenAddress: `0x${byte.repeat(32)}`,
    creatorAddress: `0x${"44".repeat(32)}`,
    administratorAddress: `0x${"55".repeat(32)}`,
    initialHolderAddress: `0x${"66".repeat(32)}`,
    initialSupply: "1000",
    name: `Token ${sequence}`,
    symbol: `T${sequence}`,
    decimals: 7,
    tokenCodeHash: scope.tokenCodeHash,
    transactionHash: `0x${(sequence + 20).toString(16).padStart(2, "0").repeat(32)}`,
    eventSequence: sequence,
    blockHeight,
    indexedAt: "2026-09-05T12:00:00.000Z",
  };
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "registry-indexer-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "registry.sqlite");
}
