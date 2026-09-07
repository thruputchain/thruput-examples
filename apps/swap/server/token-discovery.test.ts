// @vitest-environment node
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTokenDiscoveryHandler } from "./token-discovery.ts";
import { createRegistryHttpServer } from "./http.ts";
import { RegistryStore } from "./store.ts";
import { tokenDiscoveryProxy } from "../vite.config.ts";

const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const scope = {
  networkId: "ab".repeat(32),
  factoryAddress: address(1),
  tokenCodeHash: address(2),
};
const config = { origin: "https://private-registry.test", scope };
const token = {
  ...scope,
  tokenAddress: address(3),
  creatorAddress: address(4),
  name: "Token",
  symbol: "TOK",
  decimals: 18,
  blockHeight: "10",
  privateField: "not-for-browser",
};
const status = {
  networkId: scope.networkId,
  factoryAddress: scope.factoryAddress,
  indexedThroughBlock: "10",
  tokenCount: 1,
  historyLimited: false,
  syncing: false,
  syncState: "idle",
  lastError: "private failure",
};
const page = {
  tokens: [token],
  total: 1,
  limit: 20,
  offset: 0,
  asOfBlock: "10",
  hasMore: false,
  historyLimited: false,
};
const json = (value: unknown) => Response.json(value);
const servers: Server[] = [];
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const operation of cleanup.splice(0)) await operation();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  return `http://127.0.0.1:${address.port}`;
}

async function setup(
  fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      json(
        new URL(String(input)).pathname === "/api/registry/status"
          ? status
          : page,
      ),
    ),
  enabled = true,
) {
  const handler = createTokenDiscoveryHandler(enabled ? config : null, {
    fetch: fetcher,
  });
  const origin = await listen(
    createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
    }),
  );
  return { origin, fetcher };
}

function raw(
  origin: string,
  target: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin,
      { path: target, method, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("fixed token discovery boundary", () => {
  it("uses exactly two fixed reads, no forwarded headers, and projects safe fields", async () => {
    const { origin, fetcher } = await setup();
    const response = await fetch(
      `${origin}/api/token-discovery?q=%20creator%25_%20`,
      {
        headers: {
          cookie: "secret",
          authorization: "secret",
          origin: "https://evil.test",
          "x-real-ip": "bad",
          "x-forwarded-for": "bad",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const header of [
      "access-control-allow-origin",
      "set-cookie",
      "location",
    ])
      expect(response.headers.has(header)).toBe(false);
    const body = await response.json();
    expect(body).toEqual({
      scope,
      tokens: [
        {
          tokenAddress: token.tokenAddress,
          creatorAddress: token.creatorAddress,
          name: "Token",
          symbol: "TOK",
          decimals: 18,
        },
      ],
      hasMore: false,
      historyLimited: false,
      syncState: "idle",
    });
    expect(JSON.stringify(body)).not.toMatch(/private|lastError|blockHeight/);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${config.origin}/api/registry/status`,
      `${config.origin}/api/tokens?sort=newest&limit=20&offset=0&q=creator%25_`,
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toEqual({
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      });
    expect(fetcher.mock.calls[0]![1]!.signal).toBe(
      fetcher.mock.calls[1]![1]!.signal,
    );
  });

  it("omits blank q, preserves ordering, nullable metadata and freshness", async () => {
    const tokens = Array.from({ length: 20 }, (_, i) => ({
      ...token,
      tokenAddress: address(100 - i),
      name: null,
      symbol: null,
      decimals: null,
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          ...status,
          syncState: "retrying",
          syncing: true,
          historyLimited: true,
        }),
      )
      .mockResolvedValueOnce(
        json({ ...page, tokens, total: 21, hasMore: true }),
      );
    const { origin } = await setup(fetcher);
    const response = await fetch(`${origin}/api/token-discovery?q=%20`);
    const result = await response.json();
    expect(result).toMatchObject({
      historyLimited: true,
      hasMore: true,
      syncState: "retrying",
    });
    expect(
      result.tokens.map((t: { tokenAddress: string }) => t.tokenAddress),
    ).toEqual(tokens.map((t) => t.tokenAddress));
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `${config.origin}/api/tokens?sort=newest&limit=20&offset=0`,
    );
  });

  it.each([
    "/api/token-discovery?q=a&q=b",
    "/api/token-discovery?limit=1",
    "/api/token-discovery?creator=x",
    "/api/token-discovery?q=%FF",
    "/api/token-discovery?q=%ZZ",
    `/api/token-discovery?q=${encodeURIComponent("é".repeat(51))}`,
    `/api/token-discovery?q=${"x".repeat(2048)}`,
    "/api%2ftoken-discovery",
    "/api/token-discovery/../tokens",
    "/api/token-discovery/%2e%2e",
    "/api/token-discovery#x",
    "https://evil.test/api/token-discovery",
    "//evil.test/api/token-discovery",
  ])("rejects invalid target %s before fetching", async (target) => {
    const { origin, fetcher } = await setup();
    expect((await raw(origin, target)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "/api/token-discovery/",
    "/api/token-discovery/extra",
    "/api/token-discovery-extra",
    "/api/%74oken-discovery",
  ])("does not serve malformed route %s as an SPA", async (target) => {
    const { origin, fetcher } = await setup();
    expect((await raw(origin, target)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects methods/bodies and exposes no disabled route", async () => {
    const { origin, fetcher } = await setup();
    expect((await raw(origin, "/api/token-discovery", "POST")).status).toBe(
      405,
    );
    expect((await raw(origin, "/api/token-discovery", "HEAD")).status).toBe(
      405,
    );
    expect(
      (
        await raw(
          origin,
          "/api/token-discovery",
          "GET",
          { "content-length": "2" },
          "{}",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await raw(
          origin,
          "/api/token-discovery",
          "GET",
          { "transfer-encoding": "chunked" },
          "{}",
        )
      ).status,
    ).toBe(400);
    const disabled = await setup(fetcher, false);
    expect((await raw(disabled.origin, "/api/token-discovery")).status).toBe(
      404,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { networkId: "cd".repeat(32) },
    { networkId: scope.networkId.toUpperCase() },
    { factoryAddress: address(50) },
    { syncing: true },
    { historyLimited: "false" },
    { indexedThroughBlock: "01" },
    { tokenCount: -1 },
    { syncState: "unknown" },
    { syncState: ["idle"] },
  ])("rejects invalid status even with an empty index: %j", async (change) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...status, ...change }))
      .mockResolvedValueOnce(json({ ...page, tokens: [], total: 0 }));
    const { origin } = await setup(fetcher);
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on integrityFault without exposing lastError", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ...status, syncState: "integrityFault" }));
    const { origin } = await setup(fetcher);
    const response = await fetch(`${origin}/api/token-discovery`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tokenCodeHash: address(99) },
    { networkId: "cd".repeat(32) },
    { factoryAddress: address(99) },
    { tokenAddress: address(0) },
    { tokenAddress: `${address(3)}\n` },
    { creatorAddress: `${address(4)}\n` },
    { creatorAddress: "0x12" },
    { blockHeight: "11" },
    { blockHeight: "10\n" },
    { blockHeight: "1".repeat(101) },
    { name: "é".repeat(129) },
    { symbol: "é".repeat(33) },
    { decimals: 256 },
    { decimals: -1 },
    { decimals: 1.5 },
  ])("rejects whole pages with invalid rows: %j", async (change) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(status))
      .mockResolvedValueOnce(
        json({ ...page, tokens: [{ ...token, ...change }] }),
      );
    const { origin } = await setup(fetcher);
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(502);
  });

  it.each([
    { limit: 10 },
    { offset: 1 },
    { total: -1 },
    { total: 1.5 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { hasMore: true },
    { historyLimited: 0 },
    { asOfBlock: "01" },
    { total: 2 },
    { tokens: [token, token], total: 2 },
  ])("rejects invalid pagination/duplicates: %j", async (change) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(status))
      .mockResolvedValueOnce(json({ ...page, ...change }));
    const { origin } = await setup(fetcher);
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(502);
  });

  it.each(["declared", "chunked", "html", "json", "redirect", "failure"])(
    "bounds and cancels invalid upstream %s",
    async (kind) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              kind === "chunked" ? "x".repeat(256_001) : "bad",
            ),
          );
        },
        cancel,
      });
      const headers: Record<string, string> = {
        "content-type": kind === "html" ? "text/html" : "application/json",
      };
      if (kind === "declared") headers["content-length"] = "256001";
      const upstream =
        kind === "json"
          ? new Response("not-json", { headers })
          : new Response(stream, {
              headers,
              status:
                kind === "redirect" ? 302 : kind === "failure" ? 500 : 200,
            });
      const { origin } = await setup(
        vi.fn<typeof fetch>().mockResolvedValue(upstream),
      );
      const response = await fetch(`${origin}/api/token-discovery`);
      expect(response.status).toBe(502);
      expect(
        Buffer.byteLength((await response.json()).error.message),
      ).toBeLessThanOrEqual(300);
      if (kind !== "json") expect(cancel).toHaveBeenCalled();
    },
  );

  it("limits clients to 60/minute without trusting spoofed headers", async () => {
    const { origin, fetcher } = await setup();
    for (let i = 0; i < 60; i++)
      expect(
        (
          await fetch(`${origin}/api/token-discovery`, {
            headers: { "x-real-ip": `192.0.2.${i}` },
          })
        ).status,
      ).toBe(200);
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(120);
  });

  it("admits 16 active reads without queuing and releases slots on disconnect", async () => {
    const signals: AbortSignal[] = [];
    let block = true;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        if (!block)
          return json(
            new URL(String(input)).pathname === "/api/registry/status"
              ? status
              : page,
          );
        const signal = init!.signal!;
        signals.push(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("private upstream")),
            { once: true },
          ),
        );
      });
    const { origin } = await setup(fetcher);
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      fetch(`${origin}/api/token-discovery`, {
        signal: controller.signal,
      }).catch(() => undefined),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(16));
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(16);
    controllers.forEach((controller) => controller.abort());
    await Promise.all(pending);
    await vi.waitFor(() =>
      expect(signals.every((signal) => signal.aborted)).toBe(true),
    );
    block = false;
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(200);
  });

  it("uses a total 10-second deadline through the second response body and releases its slot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(status))
      .mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel,
          }),
          { headers: { "content-type": "application/json" } },
        );
      })
      .mockImplementation(async (input) =>
        json(
          new URL(String(input)).pathname === "/api/registry/status"
            ? status
            : page,
        ),
      );
    const { origin } = await setup(fetcher);
    const pending = fetch(`${origin}/api/token-discovery`);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(200);
  });

  it("wires the same boundary through real production routing without changing pools/CSP/RPC", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "discovery-production-"),
    );
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      path.join(directory, "index.html"),
      "<!doctype html><p>Swap</p>",
    );
    const store = new RegistryStore(":memory:", {
      networkId: scope.networkId,
      factoryAddress: address(50),
    });
    cleanup.push(() => store.close());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        json(
          new URL(String(input)).pathname === "/api/registry/status"
            ? status
            : page,
        ),
      );
    const origin = await listen(
      createRegistryHttpServer(
        store,
        { requestSync() {} },
        {
          staticDirectory: directory,
          rpcUrl: "https://rpc.test",
          tokenDiscovery: config,
          fetch: fetcher,
        },
      ),
    );
    const response = await fetch(`${origin}/api/token-discovery`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect((await fetch(`${origin}/api/pools`)).status).toBe(200);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect(
      (
        await fetch(`${origin}/groundhog-rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "groundhog_sendRawTransaction",
            params: [],
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      await (await fetch(`${origin}/pools/new?tokenA=${address(3)}`)).text(),
    ).toContain("Swap");
    expect((await raw(origin, "/api/token-discovery/extra")).status).toBe(404);
  });

  it.each(["configureServer", "configurePreviewServer"] as const)(
    "wires the Vite %s middleware before SPA fallback",
    async (hook) => {
      const plugin = tokenDiscoveryProxy(null);
      const use = vi.fn();
      const configure = plugin[hook];
      if (typeof configure !== "function") throw new Error("Missing hook");
      // Vite's hook only uses Connect's middleware registration.
      configure.call({} as never, { middlewares: { use } } as never);
      const middleware = use.mock.calls[0]![0];
      const next = vi.fn();
      const origin = await listen(
        createServer((request, response) =>
          middleware(request, response, () => {
            next();
            response.end("SPA");
          }),
        ),
      );
      expect((await fetch(`${origin}/api/token-discovery`)).status).toBe(404);
      expect((await raw(origin, "/api/token-discovery/%2e%2e")).status).toBe(
        400,
      );
      expect(next).not.toHaveBeenCalled();
      expect(await (await fetch(`${origin}/pools`)).text()).toBe("SPA");
    },
  );
});
