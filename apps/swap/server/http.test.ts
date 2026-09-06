// @vitest-environment node

import { request as httpRequest, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RegistryPool, RegistryScope } from "./domain.ts";
import { createRegistryHttpServer, parsePoolQuery } from "./http.ts";
import { RegistryStore } from "./store.ts";

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: address(200),
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
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);

    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const status = await fetch(`${origin}/api/registry/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      ...scope,
      indexedThroughBlock: "0",
      poolCount: 0,
      historyLimited: false,
      syncState: "idle",
      syncing: false,
      lastSuccessfulSyncAt: null,
      lastError: null,
    });
  });

  it("requests synchronization and returns current status", async () => {
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

  it("serves bounded pool defaults with scope and snapshot", async () => {
    const response = await fetch(`${origin}/api/pools`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...scope,
      pools: [],
      total: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
      asOfBlock: "0",
      historyLimited: false,
    });
  });

  it("serves searchable and token-filtered pool pages", async () => {
    store.beginScan("1", "12");
    store.commitPage([pool()], null);
    const response = await fetch(
      `${origin}/api/pools?q=${pool().handlerAddress.slice(-8)}&token=${pool().token1Address}&sort=oldest&limit=1&offset=0&asOfBlock=12`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ...scope,
      total: 1,
      asOfBlock: "12",
      hasMore: false,
      pools: [{ pairCount: "1", eventSequence: "9007199254740993" }],
    });
  });

  it.each([
    "/api/pools?unknown=1",
    "/api/pools?limit=0",
    "/api/pools?limit=1&limit=2",
    "/api/pools?offset=10001",
    "/api/pools?sort=random",
    "/api/pools?token=0x12",
    "/api/pools?asOfBlock=01",
    `/api/pools?q=${"é".repeat(51)}`,
    "/healthz?verbose=true",
    "/api/registry/status?verbose=true",
  ])("rejects invalid request query %s", async (target) => {
    const response = await fetch(`${origin}${target}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("normalizes search before applying its UTF-8 limit", () => {
    expect(
      parsePoolQuery(
        new URL(`http://registry.test/api/pools?q=${"Ａ".repeat(100)}`),
      ).q,
    ).toBe("A".repeat(100));
  });

  it("enforces route methods and rejects request bodies", async () => {
    const method = await fetch(`${origin}/api/pools`, { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");

    const body = await fetch(`${origin}/api/registry/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(body.status).toBe(400);
    expect(syncRequests).toBe(0);

    const query = await fetch(`${origin}/api/registry/sync?force=true`, {
      method: "POST",
    });
    expect(query.status).toBe(400);
    expect(syncRequests).toBe(0);

    const oversized = await fetch(`${origin}/api/registry/sync`, {
      method: "POST",
      body: "x".repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
  });

  it("returns exact 404 routes and security headers", async () => {
    for (const target of ["/api/unknown", "/api/pools/", "/"]) {
      const response = await fetch(`${origin}${target}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it.each(["/%2e%2e/healthz", "/api%2fpools", `/${"a".repeat(8_193)}`])(
    "rejects unsafe request target %s",
    async (target) => {
      const response = await rawRequest(origin, target);
      expect(response.status).toBe(400);
      expect(response.body).not.toContain('status":"ok');
    },
  );

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
    expect(Buffer.byteLength(body)).toBeLessThan(600);
    expect(body).not.toContain("secret");
  });
});

describe("parsePoolQuery", () => {
  it("parses and canonicalizes every supported value", () => {
    const token = `0x${"AA".repeat(32)}`;
    expect(
      parsePoolQuery(
        new URL(
          `http://registry.test/api/pools?q=%20Pool%20&token=${token}&sort=token1&limit=100&offset=10000&asOfBlock=999`,
        ),
      ),
    ).toEqual({
      q: "Pool",
      token: token.toLowerCase(),
      sort: "token1",
      limit: 100,
      offset: 10_000,
      asOfBlock: "999",
    });
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("HTTP test server did not bind to TCP");
  }
  return `http://127.0.0.1:${bound.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function rawRequest(
  origin: string,
  target: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: target,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function pool(): RegistryPool {
  return {
    ...scope,
    token0Address: address(1),
    token1Address: address(2),
    liquidityTokenAddress: address(3),
    handlerAddress: address(4),
    driverAddress: address(5),
    pairCount: "1",
    transactionHash: `0x${"ab".repeat(32)}`,
    eventSequence: "9007199254740993",
    createdBlock: "12",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
