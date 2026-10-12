// @vitest-environment node

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistryPool, RegistryScope } from "../shared/registry.ts";
import {
  createRegistryHttpServer,
  DEFAULT_MAXIMUM_RPC_CONCURRENCY,
  DEFAULT_RPC_REQUESTS_PER_MINUTE,
  isAllowedProductionRpcRequest,
  isValidJsonRpcResponse,
  parsePoolQuery,
  rpcClientIdentity,
  RpcRateLimiter,
} from "./http.ts";
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
      pools: [{ pairCount: "1", eventSequence: "4294967295" }],
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

describe("production HTTP server", () => {
  let directory: string;
  let outsideDirectory: string;
  let store: RegistryStore;
  let server: Server;
  let origin: string;
  const upstream = vi.fn<typeof fetch>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "swap-static-"));
    outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "swap-outside-"));
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "index.html"), "<main>swap</main>");
    await writeFile(path.join(directory, "assets", "app.js"), "export {};");
    await writeFile(path.join(outsideDirectory, "secret.txt"), "secret");
    upstream.mockReset().mockResolvedValue(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        headers: { "content-type": "application/json" },
      }),
    );
    store = new RegistryStore(":memory:", scope);
    server = createRegistryHttpServer(
      store,
      { requestSync() {} },
      {
        staticDirectory: directory,
        rpcUrl: "https://rpc.example.test/fixed",
        fetch: upstream,
      },
    );
    origin = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    store.close();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outsideDirectory, { recursive: true, force: true }),
    ]);
  });

  it("serves static assets, HEAD, and SPA routes with safe cache policy", async () => {
    const asset = await fetch(`${origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("export {};");

    const head = await fetch(`${origin}/assets/app.js`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    for (const target of ["/", "/pools", "/pools/a/b"]) {
      const page = await fetch(`${origin}${target}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("swap");
    }
  });

  it("serves the LP contract artifact as same-origin JSON without an RPC call", async () => {
    const artifact = { contractType: "rv32", data: "0x010203", hash: address(9) };
    await mkdir(path.join(directory, "contract-artifacts"));
    await writeFile(path.join(directory, "contract-artifacts", `${artifact.hash}.json`), JSON.stringify(artifact));
    const response = await fetch(`${origin}/contract-artifacts/${artifact.hash}.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual(artifact);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never falls back API, RPC, or missing asset paths", async () => {
    for (const target of [
      "/api/unknown",
      "/thruput-rpc/extra",
      "/assets/missing.js",
      `/contract-artifacts/${address(9)}.json`,
      "/missing.css",
    ]) {
      const response = await fetch(`${origin}${target}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("<main>swap");
    }
  });

  it("rejects traversal, malformed paths, and escaping symlinks", async () => {
    await symlink(
      path.join(outsideDirectory, "secret.txt"),
      path.join(directory, "escape.txt"),
    );
    for (const target of ["/%ZZ", "/%2e%2e/secret", "/foo%5cbar", "/%00"]) {
      const response = await rawRequest(origin, target);
      expect(response.status).toBe(400);
      expect(response.body).not.toContain("secret");
    }
    const escaped = await fetch(`${origin}/escape.txt`);
    expect(escaped.status).toBe(400);
    expect(await escaped.text()).not.toContain("secret");
  });

  it.each([
    ["groundhog_networkInfo", []],
    ["groundhog_chainTip", []],
    ["groundhog_getTransactionReceipt", [hash(1)]],
    ["groundhog_getTransactionStatus", [hash(2)]],
    ["groundhog_view", [viewRequest()]],
    ["groundhog_getEvents", [eventQuery()]],
  ])(
    "proxies exact read-only %s requests without caller headers",
    async (method, params) => {
      const response = await fetch(`${origin}/thruput-rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer private",
          cookie: "private=value",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      const [, options] = upstream.mock.calls.at(-1) ?? [];
      expect(options).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
      });
      expect(options?.headers).not.toHaveProperty("authorization");
      expect(options?.headers).not.toHaveProperty("cookie");
    },
  );

  it.each([
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_sendRawTransaction",
        params: [],
      },
      403,
    ],
    [[{ jsonrpc: "2.0", id: 1, method: "groundhog_view", params: [] }], 400],
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_chainTip",
        params: [],
        extra: true,
      },
      400,
    ],
    [{ jsonrpc: "2.0", id: 1, method: "groundhog_chainTip" }, 400],
    [{ jsonrpc: "2.0", id: 1, method: "groundhog_chainTip", params: [1] }, 400],
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_getTransactionStatus",
        params: [hash(1).toUpperCase()],
      },
      400,
    ],
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_view",
        params: [{ ...viewRequest(), calldata: `0x${"00".repeat(65_537)}` }],
      },
      400,
    ],
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_getEvents",
        params: [{ ...eventQuery(), limit: 501 }],
      },
      400,
    ],
  ])("rejects malformed or write RPC envelope %#", async (body, status) => {
    const response = await fetch(`${origin}/thruput-rpc`, rpcRequest(body));
    expect(response.status).toBe(status);
  });

  it("sanitizes upstream HTTP, body, and transport failures", async () => {
    const failures: Array<Response | Error> = [
      new Response("private upstream", { status: 401 }),
      new Response("private body", {
        headers: { "content-type": "text/plain" },
      }),
      new Response("x".repeat(1_048_577), {
        headers: { "content-type": "application/json" },
      }),
      new Error("private transport secret"),
    ];
    for (const failure of failures) {
      if (failure instanceof Response) upstream.mockResolvedValueOnce(failure);
      else upstream.mockRejectedValueOnce(failure);
      const response = await fetch(
        `${origin}/thruput-rpc`,
        rpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_chainTip",
          params: [],
        }),
      );
      const body = await response.text();
      expect(response.status).toBe(502);
      expect(body).not.toContain("private");
      expect(Buffer.byteLength(body)).toBeLessThan(700);
    }
  });

  it("caps concurrency and rate limits by socket address, not XFF", async () => {
    await close(server);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream.mockImplementationOnce(async () => {
      await blocked;
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        headers: { "content-type": "application/json" },
      });
    });
    server = createRegistryHttpServer(
      store,
      { requestSync() {} },
      {
        staticDirectory: directory,
        rpcUrl: "https://rpc.example.test",
        fetch: upstream,
        maximumRpcConcurrency: 1,
        rpcRequestsPerMinute: 2,
      },
    );
    origin = await listen(server);
    const first = fetch(`${origin}/thruput-rpc`, rpcRequest(chainTip()));
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    const busy = await fetch(`${origin}/thruput-rpc`, rpcRequest(chainTip()));
    expect(busy.status).toBe(503);
    release();
    expect((await first).status).toBe(200);
    const limited = await fetch(`${origin}/thruput-rpc`, {
      ...rpcRequest(chainTip()),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
    });
    expect(limited.status).toBe(429);
  });

  it("atomically reserves a slot before concurrent request bodies finish", async () => {
    await close(server);
    let releaseUpstream!: () => void;
    upstream.mockImplementationOnce(
      async () =>
        await new Promise<Response>((resolve) => {
          releaseUpstream = () =>
            resolve(
              new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                headers: { "content-type": "application/json" },
              }),
            );
        }),
    );
    server = createRegistryHttpServer(
      store,
      { requestSync() {} },
      {
        staticDirectory: directory,
        rpcUrl: "https://rpc.example.test",
        fetch: upstream,
        maximumRpcConcurrency: 1,
      },
    );
    origin = await listen(server);
    const requests = [
      fetch(`${origin}/thruput-rpc`, rpcRequest(chainTip())),
      fetch(`${origin}/thruput-rpc`, rpcRequest(chainTip())),
    ];
    const busy = await Promise.race(requests);
    expect(busy.status).toBe(503);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    releaseUpstream();
    const responses = await Promise.all(requests);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 503]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("aborts upstream on client disconnect and releases its slot", async () => {
    await close(server);
    let upstreamSignal: AbortSignal | undefined;
    upstream.mockImplementationOnce(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined;
          upstreamSignal?.addEventListener(
            "abort",
            () => reject(upstreamSignal?.reason),
            { once: true },
          );
        }),
    );
    server = createRegistryHttpServer(
      store,
      { requestSync() {} },
      {
        staticDirectory: directory,
        rpcUrl: "https://rpc.example.test",
        fetch: upstream,
        maximumRpcConcurrency: 1,
      },
    );
    origin = await listen(server);
    const disconnected = startRpcRequest(origin, chainTip());
    await vi.waitFor(() => expect(upstreamSignal).toBeInstanceOf(AbortSignal));

    disconnected.destroy();

    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    upstream.mockResolvedValueOnce(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.waitFor(async () => {
      const response = await fetch(
        `${origin}/thruput-rpc`,
        rpcRequest(chainTip()),
      );
      expect(response.status).toBe(200);
    });
  });

  it.each([
    null,
    [],
    { jsonrpc: "2.0", id: 2, result: {} },
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "x" } },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, error: { code: "-1", message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: -1 } },
  ])("rejects invalid upstream JSON-RPC envelope %#", async (envelope) => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify(envelope), {
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await fetch(
      `${origin}/thruput-rpc`,
      rpcRequest(chainTip()),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(JSON.stringify(envelope));
  });

  it("sanitizes valid upstream RPC errors without changing SDK semantics", async () => {
    const canaries = {
      url: "https://operator:credential@rpc.example.test/private",
      credential: "Bearer rpc-secret-token",
      body: '{"private":"upstream body"}',
    };
    upstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "sdk-request-7",
          error: {
            code: -32602,
            message: Object.values(canaries).join(" "),
            data: canaries,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const response = await fetch(
      `${origin}/thruput-rpc`,
      rpcRequest({ ...chainTip(), id: "sdk-request-7" }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: "sdk-request-7",
      error: { code: -32602, message: "RPC request failed" },
    });
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(body)),
    );
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1_048_576);
    for (const canary of Object.values(canaries)) {
      expect(body).not.toContain(canary);
    }
  });

  it("enforces the RPC response bound after error sanitization", async () => {
    const emptyIdRequest = JSON.stringify({ ...chainTip(), id: "" });
    const id = "x".repeat(1_048_576 - Buffer.byteLength(emptyIdRequest));
    upstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -1, message: "" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const response = await fetch(
      `${origin}/thruput-rpc`,
      rpcRequest({ ...chainTip(), id }),
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(Buffer.byteLength(body)).toBeLessThan(700);
    expect(body).not.toContain(id.slice(0, 1_000));
  });

  it("passes valid RPC result envelopes through verbatim", async () => {
    const upstreamBody =
      ' { "jsonrpc": "2.0", "id": 1, "result": { "height": "7" } }\n';
    upstream.mockResolvedValueOnce(
      new Response(upstreamBody, {
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await fetch(
      `${origin}/thruput-rpc`,
      rpcRequest(chainTip()),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(upstreamBody)),
    );
  });
});

describe("production RPC validation", () => {
  it("accepts only exact canonical per-method parameter shapes", () => {
    expect(isAllowedProductionRpcRequest(chainTip())).toBe(true);
    expect(
      isAllowedProductionRpcRequest({
        jsonrpc: "2.0",
        id: null,
        method: "groundhog_view",
        params: [viewRequest()],
      }),
    ).toBe(true);
    expect(
      isAllowedProductionRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_getEvents",
        params: [eventQuery()],
      }),
    ).toBe(true);
  });

  it.each([
    ["0", true],
    ["9007199254740993", true],
    ["9223372036854775807", true],
    ["9223372036854775808", false],
    [1, false],
    ["01", false],
    ["-1", false],
    ["1.0", false],
    ["1\n", false],
  ])("validates decimal-string event height %j", (height, accepted) => {
    expect(isAllowedProductionRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "groundhog_getEvents",
      params: [{ ...eventQuery(), anchor: { kind: "atHeight", height } }],
    })).toBe(accepted);
  });

  it("validates exact success and error response envelopes", () => {
    expect(
      isValidJsonRpcResponse(
        { jsonrpc: "2.0", id: "read", result: null },
        "read",
      ),
    ).toBe(true);
    expect(
      isValidJsonRpcResponse(
        {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { groundhog: ["arbitrary", 1] },
          },
        },
        1,
      ),
    ).toBe(true);
    expect(
      isValidJsonRpcResponse(
        { jsonrpc: "2.0", id: 1, result: {}, extension: true },
        1,
      ),
    ).toBe(false);
  });
});

describe("production RPC admission controls", () => {
  it("sets defaults above worst-case directory enrichment demand", () => {
    const maximumConcurrentViews = 4 * 19;
    const maximumPageRequests = 20 * 3 * (8 + 19);
    expect(DEFAULT_MAXIMUM_RPC_CONCURRENCY).toBeGreaterThanOrEqual(
      maximumConcurrentViews,
    );
    expect(DEFAULT_RPC_REQUESTS_PER_MINUTE).toBeGreaterThanOrEqual(
      maximumPageRequests,
    );
  });

  it("bounds high-cardinality clients and prunes expired windows without timers", () => {
    let now = 1_000;
    const limiter = new RpcRateLimiter(2, 3, () => now);
    for (let index = 0; index < 100; index += 1) {
      limiter.allow(`198.51.100.${index}`);
    }
    expect(limiter.trackedClientCount).toBe(3);

    now += 60_000;
    expect(limiter.allow("2001:db8::1")).toBe(true);
    expect(limiter.trackedClientCount).toBe(1);
  });

  it("shares one bounded overflow window for excess identities", () => {
    const limiter = new RpcRateLimiter(2, 1, () => 0);
    expect(limiter.allow("192.0.2.1")).toBe(true);
    expect(limiter.allow("192.0.2.2")).toBe(true);
    expect(limiter.allow("192.0.2.3")).toBe(true);
    expect(limiter.allow("192.0.2.4")).toBe(false);
    expect(limiter.trackedClientCount).toBe(1);
  });

  it("ignores forwarding headers unless the proxy is explicitly trusted", () => {
    const request = identityRequest({
      "x-forwarded-for": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
    });
    expect(rpcClientIdentity(request, false)).toBe("127.0.0.1");
    expect(rpcClientIdentity(request, true)).toBe("203.0.113.2");
    expect(
      rpcClientIdentity(identityRequest({ "x-real-ip": "2001:db8::1" }), true),
    ).toBe("2001:db8::1");
  });

  it.each([
    {},
    { "x-real-ip": "client.example" },
    { "x-real-ip": "203.0.113.1, 203.0.113.2" },
    { "x-real-ip": ["203.0.113.1", "203.0.113.2"] },
  ])("rejects malformed trusted proxy identity %#", (headers) => {
    expect(() => rpcClientIdentity(identityRequest(headers), true)).toThrow(
      "one valid IP address",
    );
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
    eventSequence: "4294967295",
    createdBlock: "12",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function viewRequest() {
  return {
    contract: address(1),
    entrypoint: `0x${"12".repeat(8)}`,
    calldata: "0x",
    caller: address(2),
  };
}

function eventQuery() {
  return {
    filters: [
      {
        contractAddresses: [address(1)],
        topics: { topic0: [hash(2)], topic1: [], topic2: [] },
      },
    ],
    order: "ascending",
    anchor: { kind: "atHeight", height: "1" },
    cursor: "0x",
    limit: 500,
  };
}

function chainTip() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "groundhog_chainTip",
    params: [],
  };
}

function rpcRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function startRpcRequest(origin: string, body: unknown) {
  const url = new URL(origin);
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: "/thruput-rpc",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  request.on("error", () => undefined);
  request.end(JSON.stringify(body));
  return request;
}

function identityRequest(headers: Record<string, string | string[]>) {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as Pick<import("node:http").IncomingMessage, "headers" | "socket">;
}
