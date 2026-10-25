import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "./config";

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

export function createApiHandler(config: ServerConfig) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const path = request.url;
    if (path === "/healthz" || path === "/api/config") {
      if (request.method !== "GET")
        json(response, 405, { error: "GET is required." });
      else
        json(
          response,
          200,
          path === "/healthz" ? { ok: true } : config.publicConfig,
        );
      return true;
    }
    if (path !== "/thruput-rpc") return false;
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
      !("jsonrpc" in body) ||
      body.jsonrpc !== "2.0" ||
      !("method" in body) ||
      typeof body.method !== "string" ||
      !readMethods.has(body.method)
    ) {
      json(response, 403, {
        error: "Only read-only RPC methods are available.",
      });
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
      if (!upstream.ok || !upstream.body) throw new Error("RPC unavailable");
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("RPC response is too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      json(response, 200, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      json(response, 502, { error: "Thruput RPC is unavailable." });
    }
    return true;
  };
}
