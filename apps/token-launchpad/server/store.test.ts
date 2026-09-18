// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { RegistryScope, RegistryToken } from "../shared/registry.ts";
import {
  ImmutableRegistryConflictError,
  RegistryScopeMismatchError,
  RegistryStore,
} from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: `0x${"22".repeat(32)}`,
  tokenCodeHash: `0x${"33".repeat(32)}`,
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

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.healthCheck()).toBe(true);
    expect(reopened.getStatus().historyLimited).toBe(true);
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

  it("rejects reopening under a different scope", async () => {
    const databasePath = await temporaryDatabasePath();
    new RegistryStore(databasePath, scope).close();

    expect(
      () =>
        new RegistryStore(databasePath, {
          ...scope,
          factoryAddress: `0x${"99".repeat(32)}`,
        }),
    ).toThrow(RegistryScopeMismatchError);
  });

  it("fails closed when a versioned database has no bound scope", async () => {
    const databasePath = await temporaryDatabasePath();
    new RegistryStore(databasePath, scope).close();
    const database = new DatabaseSync(databasePath);
    database.exec("DELETE FROM registry_scope");
    database.close();

    expect(() => new RegistryStore(databasePath, scope)).toThrow(
      /scope is missing/,
    );
  });
});

describe("RegistryStore ingestion", () => {
  it("persists a page and cursor atomically and resumes after reopening", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = new RegistryStore(databasePath, scope);
    store.beginScan("1", "20");
    store.commitPage([token(1, { blockHeight: "10" })], "opaque-page-2");
    store.close();

    const reopened = new RegistryStore(databasePath, scope);
    expect(reopened.getScan()).toEqual({
      anchorBlock: "1",
      targetBlock: "20",
      nextCursor: "opaque-page-2",
    });
    reopened.beginScan("1", "20");
    expect(reopened.getScan()?.nextCursor).toBe("opaque-page-2");
    expect(reopened.queryTokens(query()).tokens).toHaveLength(0);
    reopened.commitPage([token(2, { blockHeight: "20" })], null);
    expect(reopened.getScan()).toBeNull();
    expect(reopened.getStatus().indexedThroughBlock).toBe("20");
    expect(reopened.queryTokens(query()).tokens).toHaveLength(2);
    reopened.close();
  });

  it("rolls back records and cursor together when a page conflicts", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "20");
    store.commitPage([token(1)], "before-conflict");

    expect(() =>
      store.commitPage(
        [token(2), token(1, { creatorAddress: address(90) })],
        "after-conflict",
      ),
    ).toThrow(ImmutableRegistryConflictError);
    expect(store.getScan()?.nextCursor).toBe("before-conflict");
    store.commitPage([], null);
    expect(
      store.queryTokens(query()).tokens.map((item) => item.tokenAddress),
    ).toEqual([address(1)]);
    store.close();
  });

  it("treats identical duplicates as no-ops and rejects event conflicts", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage([token(1)], "replay-cursor");
    store.commitPage(
      [token(1, { indexedAt: "2026-09-05T01:00:00.000Z" })],
      null,
    );
    expect(store.getStatus().tokenCount).toBe(1);

    store.beginScan("11", "12");
    expect(() =>
      store.commitPage(
        [
          token(2, {
            transactionHash: hash(1),
            eventSequence: 1,
            blockHeight: "11",
          }),
        ],
        null,
      ),
    ).toThrow(ImmutableRegistryConflictError);
    expect(store.getScan()).not.toBeNull();
    store.close();
  });

  it("enforces canonical metadata bounds and accepts full u32 decimals", () => {
    const store = new RegistryStore(":memory:", scope);
    store.beginScan("1", "10");
    store.commitPage(
      [
        token(1, {
          name: "N".repeat(100),
          symbol: "S".repeat(10),
          decimals: 0xffff_ffff,
        }),
      ],
      "next",
    );
    expect(() =>
      store.commitPage([token(2, { name: "N".repeat(101) })], "next"),
    ).toThrow(/name/);
    expect(() =>
      store.commitPage([token(2, { symbol: "S".repeat(11) })], "next"),
    ).toThrow(/symbol/);
    expect(() =>
      store.commitPage(
        [
          token(2, {
            initialSupply: "170141183460469231731687303715884105728",
          }),
        ],
        "next",
      ),
    ).toThrow(/signed 128-bit/);
    store.commitPage([], null);
    expect(store.queryTokens(query()).tokens[0]?.decimals).toBe(0xffff_ffff);
    store.close();
  });
});

describe("RegistryStore queries", () => {
  it("sorts decimal block heights beyond int64 and safe integer limits", () => {
    const store = populatedStore(
      [
        token(1, { blockHeight: "9223372036854775808" }),
        token(2, { blockHeight: "100000000000000000000" }),
        token(3, { blockHeight: "9007199254740993" }),
      ],
      "100000000000000000000",
    );
    expect(store.queryTokens(query({ sort: "oldest" })).tokens.map(id)).toEqual(
      [address(3), address(1), address(2)],
    );
    expect(store.queryTokens(query({ sort: "newest" })).tokens.map(id)).toEqual(
      [address(2), address(1), address(3)],
    );
    expect(store.queryTokens(query()).tokens[0]?.initialSupply).toBe(
      "170141183460469231731687303715884105727",
    );
    store.close();
  });

  it("normalizes Unicode search and treats LIKE wildcards literally", () => {
    const store = populatedStore([
      token(1, { name: "Ｔｅｓｔ 100%_\\", symbol: "Wide" }),
      token(2, { name: "Test 100xx", symbol: "Other" }),
    ]);
    expect(store.queryTokens(query({ q: "test" })).total).toBe(2);
    expect(store.queryTokens(query({ q: "%_\\" })).tokens.map(id)).toEqual([
      address(1),
    ]);
    store.close();
  });

  it("filters by creator and supports name and symbol sorts", () => {
    const alice = address(80);
    const store = populatedStore([
      token(1, { creatorAddress: alice, name: "Zulu", symbol: "AAA" }),
      token(2, { creatorAddress: address(81), name: "Alpha", symbol: "ZZZ" }),
      token(3, { creatorAddress: alice, name: null, symbol: null }),
    ]);
    expect(store.queryTokens(query({ creator: alice })).tokens.map(id)).toEqual(
      [address(1), address(3)],
    );
    expect(store.queryTokens(query({ sort: "name" })).tokens.map(id)).toEqual([
      address(2),
      address(1),
      address(3),
    ]);
    expect(store.queryTokens(query({ sort: "symbol" })).tokens.map(id)).toEqual(
      [address(1), address(2), address(3)],
    );
    store.close();
  });

  it("keeps pagination on the first page snapshot", () => {
    const store = populatedStore([token(1), token(2)], "10");
    const first = store.queryTokens(query({ limit: 1 }));
    store.beginScan("11", "11");
    store.commitPage([token(3, { blockHeight: "11" })], null);

    const second = store.queryTokens(
      query({ limit: 1, offset: 1, asOfBlock: first.asOfBlock }),
    );
    expect(first.asOfBlock).toBe("10");
    expect(second.total).toBe(2);
    expect(second.tokens.map(id)).toEqual([address(2)]);
    expect(second.hasMore).toBe(false);
    store.close();
  });

  it("enforces query bounds at the store boundary", () => {
    const store = populatedStore([]);
    expect(() => store.queryTokens(query({ limit: 101 }))).toThrow(/limit/);
    expect(() => store.queryTokens(query({ offset: -1 }))).toThrow(/offset/);
    expect(() => store.queryTokens(query({ q: "a".repeat(101) }))).toThrow(/q/);
    expect(() => store.queryTokens(query({ asOfBlock: "11" }))).toThrow(
      /indexed registry height/,
    );
    store.close();
  });
});

function populatedStore(tokens: RegistryToken[], target = "10"): RegistryStore {
  const store = new RegistryStore(":memory:", scope);
  store.beginScan("1", target);
  store.commitPage(tokens, null);
  return store;
}

function query(
  overrides: Partial<Parameters<RegistryStore["queryTokens"]>[0]> = {},
) {
  return { sort: "newest" as const, limit: 20, offset: 0, ...overrides };
}

function token(
  idValue: number,
  overrides: Partial<RegistryToken> = {},
): RegistryToken {
  return {
    ...scope,
    tokenAddress: address(idValue),
    creatorAddress: address(50),
    administratorAddress: address(51),
    initialHolderAddress: address(52),
    initialSupply: "170141183460469231731687303715884105727",
    name: `Token ${idValue}`,
    symbol: `T${idValue}`,
    decimals: 18,
    transactionHash: hash(idValue),
    eventSequence: idValue,
    blockHeight: "10",
    indexedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function id(value: RegistryToken): string {
  return value.tokenAddress;
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function hash(value: number): string {
  return `0x${(value + 100).toString(16).padStart(64, "0")}`;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "token-registry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "registry.sqlite");
}
