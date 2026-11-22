import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "./config";
import { createRushService, RushError } from "./rush";

// The browser reads through this proxy. Wallets submit through their own RPC.
const readMethods = new Set([
  "getVersionInfo",
  "getNetworkInfo",
  "getChainConfig",
  "getServerLimits",
  "getChainTip",
  "getBalance",
  "getBlockByHeight",
  "getEvents",
  "getTransactionReceipt",
  "getTransactionStatus",
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RangeError("Request is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApiHandler(config: ServerConfig) {
  const rush = createRushService(config);
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const path = request.url?.split("?")[0];
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
    if (path === "/api/rush") {
      if (request.method === "GET") {
        json(response, 200, { rush: rush.snapshot() });
        return true;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "GET or POST is required." });
        return true;
      }
      try {
        json(response, 202, {
          rush: await rush.start(await readJson(request)),
        });
      } catch (error) {
        if (error instanceof RushError)
          json(response, error.status, { error: error.message });
        else if (error instanceof SyntaxError || error instanceof RangeError)
          json(response, 400, { error: "Expected a JSON request." });
        else
          json(response, 503, {
            error: "The rush could not start. Check the node.",
          });
      }
      return true;
    }
    if (path !== "/thruput-rpc") return false;
    if (request.method !== "POST") {
      json(response, 405, { error: "POST is required." });
      return true;
    }
    let body: unknown;
    try {
      body = await readJson(request);
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
      if (!upstream.ok) throw new Error("RPC unavailable");
      const text = await upstream.text();
      if (text.length > maxBytes) throw new Error("RPC response is too large");
      json(response, 200, JSON.parse(text));
    } catch {
      json(response, 502, { error: "Thruput RPC is unavailable." });
    }
    return true;
  };
}
