import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "./config.ts";
import type { IndexerStatus } from "./indexer.ts";
import type { TokenStore } from "./store.ts";

/** The browser may read through the proxy. The wallet sends writes. */
const readMethods = new Set([
  "getVersionInfo",
  "getNetworkInfo",
  "getChainConfig",
  "getServerLimits",
  "getChainTip",
  "getBalance",
  "getStorage",
  "getRegisteredAuth",
  "getBlockByHeight",
  "getEvents",
  "getTransactionReceipt",
  "getTransactionStatus",
  "getTransactionsByBlock",
  "getTransactionsByRootAddress",
  "simulateInvocation",
  "simulateInvocations",
]);
const maxBytes = 4 * 1024 * 1024;

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function createApiHandler(
  config: ServerConfig,
  store: TokenStore,
  status: IndexerStatus,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      json(response, status.historyError ? 503 : 200, status);
      return true;
    }
    if (url.pathname === "/api/config") {
      json(response, 200, config.publicConfig);
      return true;
    }
    if (url.pathname === "/api/tokens") {
      if (request.method !== "GET") {
        json(response, 405, { error: "GET is required." });
        return true;
      }
      const limit = Number(url.searchParams.get("limit") ?? 24);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      ) {
        json(response, 400, { error: "Use a limit of 1–100 and an offset of 0 or more." });
        return true;
      }
      json(response, 200, {
        ...store.listTokens({
          q: url.searchParams.get("q")?.trim().slice(0, 100) || undefined,
          creator: url.searchParams.get("creator") || undefined,
          limit,
          offset,
        }),
        indexedThrough: status.indexedThrough,
      });
      return true;
    }
    if (url.pathname !== "/thruput-rpc") return false;
    if (request.method !== "POST") {
      json(response, 405, { error: "POST is required." });
      return true;
    }
    let body: unknown;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) {
          json(response, 413, { error: "Request is too large." });
          return true;
        }
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(response, 400, { error: "Expected one JSON-RPC request." });
      return true;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("method" in body) ||
      typeof body.method !== "string" ||
      !readMethods.has(body.method)
    ) {
      json(response, 403, { error: "Only read-only RPC methods are available." });
      return true;
    }
    try {
      const upstream = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await upstream.text();
      if (!upstream.ok || text.length > maxBytes)
        throw new Error("RPC unavailable");
      json(response, 200, JSON.parse(text));
    } catch {
      json(response, 502, { error: "Thruput RPC is unavailable." });
    }
    return true;
  };
}
