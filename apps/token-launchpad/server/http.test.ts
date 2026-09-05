// @vitest-environment node

import type { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RegistryScope, RegistryToken } from "./domain.ts";
import { createRegistryHttpServer, parseTokenQuery } from "./http.ts";
import { RegistryStore } from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: `0x${"22".repeat(32)}`,
  tokenCodeHash: `0x${"33".repeat(32)}`,
};

describe("registry HTTP API", () => {
  let store: RegistryStore;
  let server: Server;
  let origin: string;
  let syncRequests: number;

  beforeEach(async () => {
    store = new RegistryStore(":memory:", scope);
    syncRequests = 0;
    server = createRegistryHttpServer(store, {
      requestSync() {
        syncRequests += 1;
        store.updateStatus({ syncState: "syncing" });
      },
    });
    origin = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    store.close();
  });

  it("serves health and status without chain access", async () => {
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const status = await fetch(`${origin}/api/registry/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      networkId: scope.networkId,
      factoryAddress: scope.factoryAddress,
      indexedThroughBlock: "0",
      tokenCount: 0,
      historyLimited: false,
      syncState: "idle",
      syncing: false,
      lastSuccessfulSyncAt: null,
      lastError: null,
    });
  });

  it("schedules sync and returns the current status with 202", async () => {
    const response = await fetch(`${origin}/api/registry/sync`, {
      method: "POST",
    });
    expect(response.status).toBe(202);
    expect(syncRequests).toBe(1);
    expect(await response.json()).toMatchObject({
      syncState: "syncing",
      syncing: true,
    });
  });

  it("returns bounded token query defaults", async () => {
    const response = await fetch(`${origin}/api/tokens`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokens: [],
      total: 0,
      limit: 20,
      offset: 0,
      asOfBlock: "0",
      hasMore: false,
      historyLimited: false,
    });
  });

  it("serves populated, searchable, creator-filtered token pages", async () => {
    store.beginScan("1", "12");
    store.commitPage([token()], null);
    const response = await fetch(
      `${origin}/api/tokens?q=${token().tokenAddress.slice(-8)}&creator=${token().creatorAddress}&sort=name&limit=1&offset=0`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      asOfBlock: "12",
      hasMore: false,
      tokens: [{ tokenAddress: token().tokenAddress, name: "Acorn" }],
    });
  });

  it.each([
    "/api/tokens?unknown=1",
    "/api/tokens?limit=0",
    "/api/tokens?limit=1&limit=2",
    "/api/tokens?offset=10001",
    "/api/tokens?sort=random",
    "/api/tokens?creator=0x12",
    "/api/tokens?asOfBlock=01",
    `/api/tokens?q=${"a".repeat(101)}`,
    "/healthz?verbose=true",
  ])("rejects invalid request query %s", async (target) => {
    const response = await fetch(`${origin}${target}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("enforces route methods and rejects sync bodies", async () => {
    const method = await fetch(`${origin}/api/tokens`, { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");

    const body = await fetch(`${origin}/api/registry/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(body.status).toBe(400);
    expect(syncRequests).toBe(0);
  });

  it("returns 404 for unknown paths and security headers on errors", async () => {
    const response = await fetch(`${origin}/api/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not expose controller errors", async () => {
    await close(server);
    server = createRegistryHttpServer(store, {
      requestSync() {
        throw new Error(`secret-${"x".repeat(1_000)}`);
      },
    });
    origin = await listen(server);

    const response = await fetch(`${origin}/api/registry/sync`, {
      method: "POST",
    });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(Buffer.byteLength(body)).toBeLessThan(500);
    expect(body).not.toContain("secret");
  });
});

describe("parseTokenQuery", () => {
  it("trims search and parses all supported values", () => {
    const creator = `0x${"AA".repeat(32)}`;
    expect(
      parseTokenQuery(
        new URL(
          `http://registry.test/api/tokens?q=%20Token%20&creator=${creator}&sort=symbol&limit=100&offset=10000&asOfBlock=999`,
        ),
      ),
    ).toEqual({
      q: "Token",
      creator: creator.toLowerCase(),
      sort: "symbol",
      limit: 100,
      offset: 10_000,
      asOfBlock: "999",
    });
  });

  it("enforces search limits by UTF-8 bytes", () => {
    expect(
      parseTokenQuery(
        new URL(`http://registry.test/api/tokens?q=${"é".repeat(50)}`),
      ).q,
    ).toBe("é".repeat(50));
    expect(() =>
      parseTokenQuery(
        new URL(`http://registry.test/api/tokens?q=${"é".repeat(51)}`),
      ),
    ).toThrow(/100 UTF-8 bytes/);
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not bind to TCP");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function token(): RegistryToken {
  return {
    ...scope,
    tokenAddress: `0x${"44".repeat(32)}`,
    creatorAddress: `0x${"55".repeat(32)}`,
    administratorAddress: `0x${"66".repeat(32)}`,
    initialHolderAddress: `0x${"77".repeat(32)}`,
    initialSupply: "100000000000000000000",
    name: "Acorn",
    symbol: "NUT",
    decimals: 7,
    transactionHash: scope.factoryAddress,
    eventSequence: 0,
    blockHeight: "12",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}
