// @vitest-environment node

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { RegistryScope, RegistryToken } from "./domain.ts";
import {
  createRegistryHttpServer,
  isJsonRpcRequest,
  parseTokenQuery,
} from "./http.ts";
import { PUBLIC_CONFIG_MANIFEST_FILENAME } from "./public-config-manifest.ts";
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
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);

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

  it("exposes the integrity fault through the existing discovery status contract", async () => {
    store.updateStatus({
      syncState: "integrityFault",
      lastError: "The RPC endpoint belongs to a different Groundhog network",
    });
    const response = await fetch(`${origin}/api/registry/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      networkId: scope.networkId,
      factoryAddress: scope.factoryAddress,
      syncState: "integrityFault",
      syncing: false,
      indexedThroughBlock: "0",
      tokenCount: 0,
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

describe("production HTTP serving", () => {
  let store: RegistryStore;
  let server: Server;
  let origin: string;
  let directory: string;
  let outsideDirectory: string;
  let upstreamFetch: Mock<typeof fetch>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-static-"));
    outsideDirectory = await mkdtemp(
      path.join(os.tmpdir(), "launchpad-outside-"),
    );
    await mkdir(path.join(directory, "assets"));
    await writeFile(
      path.join(directory, "index.html"),
      "<main>launchpad</main>",
    );
    await writeFile(path.join(directory, "assets", "app.js"), "export {};");
    await writeFile(
      path.join(directory, PUBLIC_CONFIG_MANIFEST_FILENAME),
      '{"public":"configuration"}',
    );
    await writeFile(path.join(outsideDirectory, "secret.txt"), "secret");
    store = new RegistryStore(":memory:", scope);
    upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    server = createRegistryHttpServer(
      store,
      { requestSync() {} },
      {
        staticDirectory: directory,
        rpcUrl: "http://rpc.example.test/fixed",
        fetch: upstreamFetch,
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

  it("serves assets, the index, and extensionless SPA fallbacks with safe caching", async () => {
    const asset = await fetch(`${origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await asset.text()).toBe("export {};");

    for (const target of ["/", "/tokens", "/my-tokens?page=2"]) {
      const page = await fetch(`${origin}${target}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toContain("no-store");
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toContain("launchpad");
    }
  });

  it("serves the generated contract artifact as same-origin JSON", async () => {
    await mkdir(path.join(directory, "contract-artifacts"));
    const artifact = {
      contractType: "rv32",
      data: "0x010203",
      hash: `0x${"06".repeat(32)}`,
    };
    await writeFile(
      path.join(directory, `contract-artifacts/${artifact.hash}.json`),
      JSON.stringify(artifact),
    );
    const response = await fetch(
      `${origin}/contract-artifacts/${artifact.hash}.json`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual(artifact);
  });

  it("implements HEAD without a response body", async () => {
    const response = await fetch(`${origin}/assets/app.js`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it("serves the public build manifest without cacheable or relaxed responses", async () => {
    const response = await fetch(
      `${origin}/${PUBLIC_CONFIG_MANIFEST_FILENAME}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never falls back API, RPC, or missing asset requests", async () => {
    for (const target of [
      "/api/unknown",
      "/groundhog-rpc/extra",
      "/assets/missing.js",
      "/missing.css",
    ]) {
      const response = await fetch(`${origin}${target}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.text()).not.toContain("launchpad");
    }
  });

  it("rejects invalid static methods with the complete Allow header", async () => {
    const response = await fetch(`${origin}/tokens`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each([
    "/%ZZ",
    "/tokens?q=%ZZ",
    "/%2e%2e/secret",
    "/foo%5cbar",
    "/%00",
    "/api%2ftokens",
    "/api%2Ftokens",
    "/groundhog-rpc%2fextra",
    "/groundhog-rpc%2Fextra",
    `/${"a".repeat(2_049)}`,
  ])("rejects unsafe raw path %s", async (target) => {
    const response = await rawRequest(origin, target);
    expect(response.status).toBe(400);
    expect(response.body).not.toContain("launchpad");
  });

  it("rejects static symlinks that escape the static directory", async () => {
    await symlink(
      path.join(outsideDirectory, "secret.txt"),
      path.join(directory, "escape.txt"),
    );
    const response = await fetch(`${origin}/escape.txt`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret");
  });

  it.each([
    "groundhog_networkInfo",
    "groundhog_chainTip",
    "groundhog_getEvents",
    "groundhog_getTransactionReceipt",
    "groundhog_getTransactionStatus",
    "groundhog_view",
  ])("proxies the read-only RPC method %s", async (method) => {
    const response = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        cookie: "session=private",
        authorization: "Bearer private",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ result: "ok" });

    const [target, options] = upstreamFetch.mock.calls.at(-1) ?? [];
    expect(String(target)).toBe("http://rpc.example.test/fixed");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
    });
    expect(options?.headers).not.toHaveProperty("cookie");
    expect(options?.headers).not.toHaveProperty("authorization");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects writes, batches, malformed envelopes, queries, and wrong media types", async () => {
    const requests: Array<[string, RequestInit, number]> = [
      [
        "/groundhog-rpc",
        rpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_sendRawTransaction",
        }),
        403,
      ],
      [
        "/groundhog-rpc",
        rpcRequest([{ jsonrpc: "2.0", id: 1, method: "groundhog_view" }]),
        400,
      ],
      ["/groundhog-rpc", rpcRequest({ id: 1, method: "groundhog_view" }), 400],
      [
        "/groundhog-rpc",
        rpcRequest({
          jsonrpc: "2.0",
          id: true,
          method: "groundhog_view",
        }),
        400,
      ],
      [
        "/groundhog-rpc",
        rpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_view",
          params: null,
        }),
        400,
      ],
      [
        "/groundhog-rpc",
        rpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "groundhog_view",
          params: "invalid",
        }),
        400,
      ],
      ["/groundhog-rpc?debug=1", rpcRequest({}), 400],
      [
        "/groundhog-rpc",
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        },
        415,
      ],
    ];
    for (const [target, options, status] of requests) {
      const response = await fetch(`${origin}${target}`, options);
      expect(response.status).toBe(status);
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("enforces RPC method and body limits", async () => {
    const method = await fetch(`${origin}/groundhog-rpc`);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");

    const oversized = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_000_001),
    });
    expect(oversized.status).toBe(413);
  });

  it("closes a rejected unfinished chunked request after delivering the response", async () => {
    const response = await unfinishedChunkedRequest(origin, "/api/tokens");
    expect(response).toContain("HTTP/1.1 405 Method Not Allowed");
    expect(response.toLowerCase()).toContain("connection: close");
  });

  it.each([
    new Response("not json", { headers: { "content-type": "text/plain" } }),
    new Response(new Uint8Array(1_000_001), {
      headers: { "content-type": "application/json" },
    }),
  ])(
    "returns a bounded generic error for invalid upstream responses",
    async (upstream) => {
      upstreamFetch.mockResolvedValueOnce(upstream);
      const response = await fetch(
        `${origin}/groundhog-rpc`,
        rpcRequest({ jsonrpc: "2.0", id: 1, method: "groundhog_view" }),
      );
      const body = await response.text();
      expect(response.status).toBe(502);
      expect(Buffer.byteLength(body)).toBeLessThan(500);
      expect(body).not.toContain("not json");
    },
  );

  it("returns bounded generic transport errors", async () => {
    upstreamFetch.mockRejectedValueOnce(
      new Error(`secret-${"x".repeat(2_000)}`),
    );
    const response = await fetch(
      `${origin}/groundhog-rpc`,
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "groundhog_view" }),
    );
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(Buffer.byteLength(body)).toBeLessThan(500);
    expect(body).not.toContain("secret");
  });

  it.each([
    new Response("private upstream text", {
      status: 401,
      headers: { "content-type": "text/plain" },
    }),
    new Response(JSON.stringify({ error: "private upstream JSON" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  ])("discards non-success RPC responses", async (upstream) => {
    upstreamFetch.mockResolvedValueOnce(upstream);
    const response = await fetch(
      `${origin}/groundhog-rpc`,
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "groundhog_view" }),
    );
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(Buffer.byteLength(body)).toBeLessThan(500);
    expect(body).not.toContain("private upstream");
    expect(body).not.toContain("401");
    expect(body).not.toContain("503");
  });

  it("sets production-compatible security headers on static and API responses", async () => {
    for (const target of ["/", "/healthz", "/api/unknown"]) {
      const response = await fetch(`${origin}${target}`);
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
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

describe("isJsonRpcRequest", () => {
  it.each([undefined, null, "request-1", 0, 1.5])(
    "accepts supported JSON-RPC id %#",
    (id) => {
      expect(
        isJsonRpcRequest({
          jsonrpc: "2.0",
          method: "groundhog_view",
          ...(id === undefined ? {} : { id }),
          params: [],
        }),
      ).toBe(true);
    },
  );

  it.each([true, {}, [], Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsupported JSON-RPC id %#",
    (id) => {
      expect(
        isJsonRpcRequest({ jsonrpc: "2.0", method: "groundhog_view", id }),
      ).toBe(false);
    },
  );

  it.each([null, "value", 1, true])(
    "rejects unsupported JSON-RPC params %#",
    (params) => {
      expect(
        isJsonRpcRequest({
          jsonrpc: "2.0",
          method: "groundhog_view",
          params,
        }),
      ).toBe(false);
    },
  );
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

function rpcRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function rawRequest(
  origin: string,
  target: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
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
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function unfinishedChunkedRequest(
  origin: string,
  target: string,
): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(url.port), url.hostname);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Server did not close rejected chunked request"));
    }, 2_000);
    socket.on("connect", () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nHost: ${url.host}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n5\r\nx`,
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
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
