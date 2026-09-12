import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "./config";

const METHODS = new Set([
  "groundhog_networkInfo",
  "groundhog_chainTip",
  "groundhog_view",
  "groundhog_getBalance",
  "groundhog_getTransactionReceipt",
  "groundhog_getTransactionStatus",
  "groundhog_sendRawTransaction",
]);
const MAX_BYTES = 1_000_000;

export function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig | Error,
  fetchRpc: typeof fetch = fetch,
): Promise<boolean> {
  const path = request.url?.split("?")[0];
  if (!["/api/config", "/groundhog-rpc", "/healthz"].includes(path ?? ""))
    return false;
  if (config instanceof Error) {
    json(response, 503, { error: config.message });
    return true;
  }
  if (path === "/api/config" || path === "/healthz") {
    json(
      response,
      request.method === "GET" ? 200 : 405,
      request.method !== "GET"
        ? { error: "GET is required." }
        : path === "/api/config"
          ? config.app
          : { ready: true },
    );
    return true;
  }
  if (request.method !== "POST") {
    json(response, 405, { error: "POST is required." });
    return true;
  }
  let body: {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) {
        json(response, 413, { error: "RPC request is too large." });
        return true;
      }
      chunks.push(bytes);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !body ||
      Array.isArray(body) ||
      body.jsonrpc !== "2.0" ||
      typeof body.method !== "string"
    )
      throw new Error();
  } catch {
    json(response, 400, { error: "Expected one JSON-RPC request." });
    return true;
  }
  if (!METHODS.has(body.method as string)) {
    json(response, 403, { error: "RPC method is not available in Counter." });
    return true;
  }
  try {
    const upstream = await fetchRpc(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!upstream.ok || !upstream.body) throw new Error();
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("RPC response is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    json(response, 200, result);
  } catch {
    // Never retry a signed transaction here: the upstream may have accepted it.
    json(response, 502, { error: "Groundhog RPC is unavailable." });
  }
  return true;
}
