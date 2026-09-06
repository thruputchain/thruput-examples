// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { PoolQuery, RegistryPool, RegistryScope } from "./domain.ts";
import {
  ImmutableRegistryConflictError,
  PairCountIntegrityError,
  RegistryScopeMismatchError,
  RegistryStore,
} from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: address(200),
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RegistryStore schema and scope", () => {
  it("creates schema version 1 and reopens persisted state", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.updateStatus({ historyLimited: true });
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 1,
    });
    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    database.close();

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.healthCheck()).toBe(true);
    expect(reopened.getStatus()).toMatchObject({
      ...scope,
      historyLimited: true,
      indexedThroughBlock: "0",
      poolCount: 0,
    });
    reopened.close();
  });

  it("rejects unsupported newer schema versions", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version=2");
    database.close();

    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      /Unsupported registry schema version 2/,
    );
  });

  it("rejects a mismatched scope", async () => {
    const databasePath = await temporaryDatabasePath();
    new RegistryStore(databasePath, scope).close();

    expect(
      () =>
        new RegistryStore(databasePath, {
          ...scope,
          factoryAddress: address(201),
        }),
    ).toThrow(RegistryScopeMismatchError);
  });

  it.each([
    ["DELETE FROM registry_scope", /scope is missing/],
    [
      "UPDATE registry_scope SET network_id = 'not-a-network'",
      /scope is malformed/,
    ],
  ])("fails closed for invalid persisted scope", async (sql, expected) => {
    const databasePath = await temporaryDatabasePath();
    new RegistryStore(databasePath, scope).close();
    const database = new DatabaseSync(databasePath);
    database.exec(sql);
    database.close();

    expect(() => new RegistryStore(databasePath, scope)).toThrow(expected);
  });

  it.each([
    `UPDATE registry_scope SET network_id = '0x${"11".repeat(32)}'`,
    `UPDATE registry_scope SET factory_address = '0x${"AB".repeat(32)}'`,
  ])("rejects noncanonical persisted scope", async (sql) => {
    const databasePath = await validDatabasePath();
    mutateDatabase(databasePath, sql);
    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      /scope is malformed/,
    );
  });

  it("rejects a counterfeit version-1 database", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version=1");
    database.close();
    expect(() => new RegistryStore(databasePath, scope)).toThrow();
  });

  it.each([
    "DELETE FROM registry_state WHERE key = 'indexed_through_block'",
    "UPDATE registry_state SET value = '01' WHERE key = 'indexed_through_block'",
    "UPDATE registry_state SET value = 'maybe' WHERE key = 'history_limited'",
    "UPDATE registry_state SET value = 'broken' WHERE key = 'sync_state'",
    "INSERT INTO registry_state(key, value) VALUES ('last_successful_sync_at', 'yesterday')",
    `INSERT INTO registry_state(key, value) VALUES ('last_error', '${"x".repeat(501)}')`,
    "INSERT INTO registry_state(key, value) VALUES ('scan_anchor_block', '1')",
    "INSERT INTO registry_state(key, value) VALUES ('scan_next_cursor', 'orphan')",
    "INSERT INTO registry_state(key, value) VALUES ('retained_pair_count_baseline', '0')",
    "INSERT INTO registry_state(key, value) VALUES ('retention_baseline_pending', 'false')",
    "INSERT INTO registry_state(key, value) VALUES ('counterfeit_state', 'true')",
  ])("rejects malformed persisted state", async (sql) => {
    const databasePath = await validDatabasePath();
    mutateDatabase(databasePath, sql);
    expect(() => new RegistryStore(databasePath, scope)).toThrow();
  });

  it.each([
    "INSERT INTO pair_count_baselines(pair_count) VALUES ('0')",
    "INSERT INTO pair_count_baselines(pair_count) VALUES ('01')",
    "INSERT INTO pair_count_baselines(pair_count) VALUES ('4294967296')",
    "INSERT INTO pair_count_baselines(pair_count) VALUES ('10')",
  ])("rejects invalid or orphaned pair count baselines", async (sql) => {
    const databasePath = await validDatabasePath();
    mutateDatabase(databasePath, sql);
    expect(() => new RegistryStore(databasePath, scope)).toThrow();
  });

  it("rejects an oversized persisted scan cursor", async () => {
    const databasePath = await validDatabasePath();
    mutateDatabase(
      databasePath,
      `INSERT INTO registry_state(key, value) VALUES
        ('scan_anchor_block', '1'),
        ('scan_target_block', '10'),
        ('scan_next_cursor', '${"x".repeat(4_097)}')`,
    );
    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      /storage is invalid/,
    );
  });

  it.each([
    `UPDATE pools SET transaction_hash = '0x${"AB".repeat(32)}'`,
    `UPDATE pools SET network_id = '${"22".repeat(32)}'`,
    "UPDATE pools SET pair_count = '4294967296'",
    "UPDATE pools SET created_block = '11'",
  ])("rejects malformed persisted pool evidence", async (sql) => {
    const databasePath = await populatedDatabasePath([pool(1)]);
    mutateDatabase(databasePath, sql);
    expect(() => new RegistryStore(databasePath, scope)).toThrow();
  });

  it("rejects noncontiguous persisted pair counts", async () => {
    const databasePath = await populatedDatabasePath([pool(1), pool(2)]);
    mutateDatabase(
      databasePath,
      "UPDATE pools SET pair_count = '3' WHERE pair_count = '2'",
    );
    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      PairCountIntegrityError,
    );
  });

  it("health checks required registry structures", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    mutateDatabase(
      databasePath,
      "DELETE FROM registry_state WHERE key = 'sync_state'",
    );
    expect(store.healthCheck()).toBe(false);
    store.close();
  });

  it("reopens a database with a retained gap after existing evidence", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1), pool(2)], null);
    store.beginScan("11", "20");
    store.commitPage([pool(10, { createdBlock: "11" })], null, {
      retentionGap: true,
    });
    store.close();

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getStatus()).toMatchObject({
      historyLimited: true,
      poolCount: 3,
      indexedThroughBlock: "20",
    });
    reopened.close();
  });

  it("does not persist a baseline for contiguous retained evidence", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1)], "next");
    store.resetScanCursor();
    store.commitPage([pool(1), pool(2)], null, { retentionGap: true });
    store.close();

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getStatus()).toMatchObject({
      historyLimited: true,
      poolCount: 2,
    });
    reopened.close();

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM pair_count_baselines")
        .get(),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it("persists and validates multiple retention gaps across restarts", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = new RegistryStore(databasePath, scope);
    first.beginScan("1", "10");
    first.commitPage([pool(1), pool(2)], null);
    first.beginScan("11", "20");
    first.commitPage([pool(10, { createdBlock: "11" })], null, {
      retentionGap: true,
    });
    first.close();

    const second = new RegistryStore(databasePath, scope);
    second.beginScan("21", "30");
    second.commitPage([pool(20, { createdBlock: "21" })], "next", {
      retentionGap: true,
    });
    second.commitPage([pool(21, { createdBlock: "22" })], null);
    second.close();

    const third = new RegistryStore(databasePath, scope);
    expect(third.getStatus()).toMatchObject({
      historyLimited: true,
      indexedThroughBlock: "30",
      poolCount: 5,
    });
    third.close();

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT pair_count FROM pair_count_baselines ORDER BY length(pair_count), pair_count",
        )
        .all(),
    ).toEqual([{ pair_count: "10" }, { pair_count: "20" }]);
    database.close();
  });

  it("rejects missing and non-discontinuous persisted baselines", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1), pool(2)], null);
    store.beginScan("11", "20");
    store.commitPage([pool(10, { createdBlock: "11" })], null, {
      retentionGap: true,
    });
    store.close();

    mutateDatabase(
      databasePath,
      "DELETE FROM pair_count_baselines WHERE pair_count = '10'",
    );
    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      PairCountIntegrityError,
    );

    mutateDatabase(
      databasePath,
      "INSERT INTO pair_count_baselines(pair_count) VALUES ('10'), ('2')",
    );
    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      PairCountIntegrityError,
    );
  });
});

describe("RegistryStore ingestion", () => {
  it("persists each page and cursor atomically and completes the scan", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "20");
    store.commitPage([pool(1, { createdBlock: "10" })], "opaque-page-2");
    store.close();

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getScan()).toEqual({
      anchorBlock: "1",
      targetBlock: "20",
      nextCursor: "opaque-page-2",
    });
    expect(reopened.queryPools(query()).pools).toHaveLength(0);
    reopened.beginScan("1", "20");
    reopened.commitPage([pool(2, { createdBlock: "20" })], null);
    expect(reopened.getScan()).toBeNull();
    expect(reopened.getStatus().indexedThroughBlock).toBe("20");
    expect(reopened.queryPools(query()).pools).toHaveLength(2);
    reopened.close();
  });

  it("rolls back evidence, history state, and cursor together", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "20");
    store.commitPage([pool(1)], "before-conflict");

    expect(() =>
      store.commitPage(
        [pool(2), pool(3, { handlerAddress: pool(1).handlerAddress })],
        "after-conflict",
      ),
    ).toThrow(ImmutableRegistryConflictError);
    expect(store.getScan()?.nextCursor).toBe("before-conflict");
    expect(store.getStatus()).toMatchObject({
      poolCount: 1,
      historyLimited: false,
    });
    store.close();
  });

  it("treats identical replay as a no-op and preserves indexedAt", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1)], "replay");
    store.resetScanCursor();
    store.commitPage(
      [pool(1, { indexedAt: "2026-09-05T01:00:00.000Z" })],
      null,
    );

    expect(store.getStatus().poolCount).toBe(1);
    expect(store.queryPools(query()).pools[0]?.indexedAt).toBe(
      "2026-09-05T00:00:00.000Z",
    );
    store.close();
  });

  it.each([
    [
      "canonical pair",
      {
        token0Address: address(1),
        token1Address: address(101),
        transactionHash: hash(99),
        eventSequence: "99",
      },
    ],
    [
      "event identity",
      {
        token0Address: address(2),
        token1Address: address(102),
        transactionHash: hash(1),
        eventSequence: "1",
      },
    ],
    ["handler", { handlerAddress: address(301) }],
    ["liquidity token", { liquidityTokenAddress: address(401) }],
    ["driver", { driverAddress: address(501) }],
    ["pair count", { pairCount: "1" }],
  ])("rejects a conflict by %s", (_name, overrides) => {
    const store = completedStore([pool(1)]);
    store.beginScan("11", "12");
    expect(() =>
      store.commitPage(
        [
          pool(2, {
            createdBlock: "11",
            ...(overrides as Partial<RegistryPool>),
          }),
        ],
        null,
      ),
    ).toThrow(ImmutableRegistryConflictError);
    expect(store.getScan()).not.toBeNull();
    expect(store.getStatus().poolCount).toBe(1);
    store.close();
  });

  it("enforces complete-history and retained-prefix pair count continuity", () => {
    const complete = new RegistryStore(":memory:", scope);
    complete.beginScan("1", "10");
    expect(() => complete.commitPage([pool(2)], null)).toThrow(
      PairCountIntegrityError,
    );
    expect(complete.getStatus().poolCount).toBe(0);
    complete.close();

    const retained = new RegistryStore(":memory:", scope);
    retained.beginScan("1", "10");
    retained.commitPage([pool(50)], "next", { retentionGap: true });
    retained.commitPage([pool(51)], null);
    expect(retained.getStatus()).toMatchObject({
      poolCount: 2,
      historyLimited: true,
    });
    retained.beginScan("11", "11");
    expect(() =>
      retained.commitPage([pool(53, { createdBlock: "11" })], null),
    ).toThrow(PairCountIntegrityError);
    retained.close();
  });

  it("rejects retention changes on a continuation page", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1)], "next");
    expect(() =>
      store.commitPage([pool(2)], null, { retentionGap: true }),
    ).toThrow(PairCountIntegrityError);
    expect(store.getScan()?.nextCursor).toBe("next");
    store.close();
  });

  it("persists a pending baseline after an empty retention page", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1), pool(2)], null);
    store.beginScan("11", "20");
    store.commitPage([], "first-retained-page", { retentionGap: true });
    store.close();

    const reopened = new RegistryStore(databasePath, scope);
    reopened.commitPage([pool(10, { createdBlock: "11" })], "next");
    reopened.commitPage([pool(11, { createdBlock: "12" })], null);
    expect(reopened.getStatus()).toMatchObject({
      historyLimited: true,
      poolCount: 4,
    });
    reopened.close();
  });

  it("makes the first replay duplicate consume the baseline allowance", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1), pool(2)], null);
    store.beginScan("11", "20");
    store.commitPage([pool(3, { createdBlock: "11" })], "before-replay");
    store.resetScanCursor();
    const duplicate = pool(3, {
      createdBlock: "11",
      indexedAt: "2026-09-05T01:00:00.000Z",
    });
    expect(() =>
      store.commitPage(
        [duplicate, pool(10, { createdBlock: "12" })],
        "after-gap",
        { retentionGap: true },
      ),
    ).toThrow(PairCountIntegrityError);
    expect(store.getScan()?.nextCursor).toBeNull();
    expect(store.getStatus()).toMatchObject({
      historyLimited: false,
      poolCount: 3,
    });

    store.commitPage(
      [duplicate, pool(4, { createdBlock: "12" })],
      "after-contiguous",
      { retentionGap: true },
    );
    store.commitPage([pool(5, { createdBlock: "13" })], null);

    expect(store.getStatus()).toMatchObject({
      historyLimited: true,
      poolCount: 5,
      indexedThroughBlock: "20",
    });
    expect(store.queryPools(query()).pools.map(id)).toEqual([
      "5",
      "4",
      "3",
      "2",
      "1",
    ]);
    store.close();
  });

  it.each([
    { token0Address: address(100), token1Address: address(2) },
    { token0Address: address(0) },
    { pairCount: "0" },
    { pairCount: "01" },
    { pairCount: "4294967296" },
    { eventSequence: "1.5" },
    { createdBlock: "-1" },
    { transactionHash: "0x12" },
    { indexedAt: "yesterday" },
    { networkId: "22".repeat(32) },
  ])("validates canonical evidence at the store boundary", (overrides) => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    expect(() => store.commitPage([pool(1, overrides)], "next")).toThrow();
    expect(store.getStatus().poolCount).toBe(0);
    expect(store.getScan()?.nextCursor).toBeNull();
    store.close();
  });

  it.each(["pairCount", "eventSequence", "createdBlock"] as const)(
    "rejects unsafe numeric %s values",
    (field) => {
      const store = new RegistryStore(":memory:", scope);
      store.beginScan("1", "10");
      const value = pool(1, {
        [field]: 1 as unknown as string,
      });
      expect(() => store.commitPage([value], null)).toThrow(/canonical/);
      expect(store.getStatus().poolCount).toBe(0);
      store.close();
    },
  );

  it("accepts the maximum u32 pair count as a retained baseline", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([pool(1, { pairCount: "4294967295" })], null, {
      retentionGap: true,
    });
    expect(store.getStatus().poolCount).toBe(1);
    store.close();
  });

  it("bounds opaque cursors by characters", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    expect(() => store.commitPage([], "")).toThrow(/cursor/);
    expect(() => store.commitPage([], "x".repeat(4_097))).toThrow(/cursor/);
    store.commitPage([], "é".repeat(4_096));
    expect(store.getScan()?.nextCursor).toHaveLength(4_096);
    store.close();
  });
});

describe("RegistryStore status", () => {
  it("persists scan and bounded public status state", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.updateStatus({
      syncState: "retrying",
      lastSuccessfulSyncAt: "2026-09-05T00:00:00.000Z",
      lastError: "é".repeat(400),
    });
    const status = store.getStatus();
    expect(status.syncing).toBe(true);
    expect(status.lastSuccessfulSyncAt).toBe("2026-09-05T00:00:00.000Z");
    expect(Buffer.byteLength(status.lastError ?? "")).toBeLessThanOrEqual(500);
    expect(() =>
      store.updateStatus({ lastSuccessfulSyncAt: "invalid" }),
    ).toThrow(/ISO timestamp/);
    store.updateStatus({ historyLimited: true });
    expect(() => store.updateStatus({ historyLimited: false })).toThrow(
      /cannot be cleared/,
    );
    store.close();
  });
});

describe("RegistryStore queries", () => {
  it("uses decimal-text ordering for large blocks and event sequences", () => {
    const store = completedStore(
      [
        pool(1, {
          createdBlock: "9223372036854775808",
          eventSequence: "100000000000000000000",
        }),
        pool(2, {
          createdBlock: "100000000000000000000",
          eventSequence: "9007199254740993",
        }),
        pool(3, {
          createdBlock: "9007199254740993",
          eventSequence: "9223372036854775808",
        }),
      ],
      "100000000000000000000",
    );
    expect(store.queryPools(query({ sort: "oldest" })).pools.map(id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(store.queryPools(query({ sort: "newest" })).pools.map(id)).toEqual([
      "2",
      "1",
      "3",
    ]);
    store.close();
  });

  it("searches all addresses with NFKC normalization and literal wildcards", () => {
    const first = pool(1, { handlerAddress: addressWithSuffix("abc") });
    const second = pool(2);
    const store = completedStore([first, second]);
    expect(store.queryPools(query({ q: "ＡＢＣ" })).pools.map(id)).toEqual([
      "1",
    ]);
    expect(store.queryPools(query({ q: "%_\\" })).pools).toEqual([]);
    expect(
      store
        .queryPools(query({ q: second.driverAddress.slice(-8) }))
        .pools.map(id),
    ).toEqual(["2"]);
    store.close();
  });

  it("filters by either exact token and implements every deterministic sort", () => {
    const sharedToken = address(90);
    const values = [
      pool(1, { token1Address: sharedToken, createdBlock: "8" }),
      pool(2, {
        token0Address: address(3),
        token1Address: address(50),
        createdBlock: "9",
      }),
      pool(3, {
        token0Address: sharedToken,
        token1Address: address(103),
        createdBlock: "10",
      }),
    ];
    const store = completedStore(values);
    expect(
      store.queryPools(query({ token: sharedToken })).pools.map(id),
    ).toEqual(["3", "1"]);
    expect(store.queryPools(query({ sort: "token0" })).pools.map(id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(store.queryPools(query({ sort: "token1" })).pools.map(id)).toEqual([
      "2",
      "1",
      "3",
    ]);
    store.close();
  });

  it("keeps pagination stable on the first page snapshot", () => {
    const store = completedStore([pool(1), pool(2)], "10");
    const first = store.queryPools(query({ limit: 1 }));
    store.beginScan("11", "11");
    store.commitPage([pool(3, { createdBlock: "11" })], null);

    const second = store.queryPools(
      query({ limit: 1, offset: 1, asOfBlock: first.asOfBlock }),
    );
    expect(first).toMatchObject({ asOfBlock: "10", total: 2, hasMore: true });
    expect(second).toMatchObject({
      asOfBlock: "10",
      total: 2,
      hasMore: false,
    });
    expect(second.pools.map(id)).toEqual(["1"]);
    store.close();
  });

  it("enforces query validation at the store boundary", () => {
    const store = completedStore([]);
    expect(() => store.queryPools(query({ limit: 101 }))).toThrow(/limit/);
    expect(() => store.queryPools(query({ offset: -1 }))).toThrow(/offset/);
    expect(() => store.queryPools(query({ q: "é".repeat(51) }))).toThrow(/q/);
    expect(() => store.queryPools(query({ token: "0x12" }))).toThrow(/token/);
    expect(() => store.queryPools(query({ asOfBlock: "11" }))).toThrow(
      /indexed registry height/,
    );
    expect(() =>
      store.queryPools(query({ asOfBlock: 10 as unknown as string })),
    ).toThrow(/canonical/);
    store.close();
  });
});

function completedStore(pools: RegistryPool[], target = "10"): RegistryStore {
  const store = new RegistryStore(":memory:", scope);
  store.beginScan("1", target);
  store.commitPage(pools, null);
  return store;
}

function query(overrides: Partial<PoolQuery> = {}): PoolQuery {
  return { sort: "newest", limit: 20, offset: 0, ...overrides };
}

function pool(
  idValue: number,
  overrides: Partial<RegistryPool> = {},
): RegistryPool {
  return {
    ...scope,
    token0Address: address(idValue),
    token1Address: address(100 + idValue),
    liquidityTokenAddress: address(400 + idValue),
    handlerAddress: address(300 + idValue),
    driverAddress: address(500 + idValue),
    pairCount: String(idValue),
    transactionHash: hash(idValue),
    eventSequence: String(idValue),
    createdBlock: "10",
    indexedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function id(value: RegistryPool): string {
  return value.pairCount;
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWithSuffix(suffix: string): string {
  return `0x${"a".repeat(64 - suffix.length)}${suffix}`;
}

function hash(value: number): string {
  return `0x${(value + 1_000).toString(16).padStart(64, "0")}`;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pool-registry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "registry.sqlite");
}

async function validDatabasePath(): Promise<string> {
  const databasePath = await temporaryDatabasePath();
  new RegistryStore(databasePath, scope).close();
  return databasePath;
}

async function populatedDatabasePath(pools: RegistryPool[]): Promise<string> {
  const databasePath = await temporaryDatabasePath();
  const store = new RegistryStore(databasePath, scope);
  store.beginScan("1", "10");
  store.commitPage(pools, null);
  store.close();
  return databasePath;
}

function mutateDatabase(databasePath: string, sql: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(sql);
  database.close();
}
