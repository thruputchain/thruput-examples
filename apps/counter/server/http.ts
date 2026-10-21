import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "./config";
import {
  CounterPolicyError,
  CounterTopupError,
  CounterTopupRateLimitError,
  createCounterTransactions,
  parseOperation,
} from "./transactions";

const METHODS = new Set([
  "getVersionInfo",
  "getNetworkInfo",
  "getServerLimits",
  "getChainTip",
  "simulateInvocation",
  "getBalance",
  "getTransactionReceipt",
  "getTransactionStatus",
  "sendTransaction",
]);
const MAX_BYTES = 1_000_000;

function allowsBrowserTopup(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      origin === url.origin &&
      url.host === request.headers.host?.toLowerCase()
    );
  } catch {
    return false;
  }
}

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

export function createApiHandler(
  config: ServerConfig | Error,
  fetchRpc: typeof fetch = fetch,
) {
  const transactions =
    config instanceof Error || config.signingPrivateKey === null
      ? null
      : createCounterTransactions(config, fetchRpc);
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const path = request.url?.split("?")[0];
    if (
      ![
        "/api/config",
        "/api/prepare",
        "/api/topup",
        "/thruput-rpc",
        "/healthz",
      ].includes(path ?? "")
    )
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
    if (!transactions && (path === "/api/prepare" || path === "/api/topup")) {
      json(response, 503, { error: "Development signer is not configured." });
      return true;
    }
    if (path === "/api/topup" && !allowsBrowserTopup(request)) {
      json(response, 403, { error: "Request signer top-ups from this app." });
      return true;
    }
    let body: unknown;
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
    } catch {
      json(response, 400, { error: "Expected a JSON request." });
      return true;
    }
    if (path === "/api/topup") {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        json(response, 400, {
          error:
            "Top-up accepts an empty object and funds only the configured signer.",
        });
        return true;
      }
      try {
        json(response, 200, await transactions!.topup());
      } catch (error) {
        if (error instanceof CounterTopupRateLimitError) {
          response.setHeader("Retry-After", String(error.retryAfterSeconds));
          json(response, 429, {
            error: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          });
          return true;
        }
        json(response, 503, {
          error:
            error instanceof CounterTopupError
              ? error.message
              : "Could not confirm the signer top-up. The faucet may be on cooldown; try again later.",
        });
      }
      return true;
    }
    if (path === "/api/prepare") {
      try {
        const direction = parseOperation(body);
        json(response, 200, await transactions!.prepare(direction));
      } catch (error) {
        json(response, error instanceof CounterPolicyError ? 400 : 503, {
          error:
            error instanceof CounterPolicyError
              ? error.message
              : "Counter signing is unavailable. Try again shortly.",
        });
      }
      return true;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("jsonrpc" in body) ||
      body.jsonrpc !== "2.0" ||
      !("method" in body) ||
      typeof body.method !== "string"
    ) {
      json(response, 400, { error: "Expected one JSON-RPC request." });
      return true;
    }
    if (!METHODS.has(body.method)) {
      json(response, 403, { error: "RPC method is not available in Counter." });
      return true;
    }
    if (body.method === "sendTransaction") {
      if (!transactions) {
        json(response, 403, {
          error: "Submit wallet transactions through the wallet provider.",
        });
        return true;
      }
      try {
        transactions!.assertSubmission(
          "params" in body ? body.params : undefined,
        );
      } catch (error) {
        json(response, 403, {
          error:
            error instanceof CounterPolicyError
              ? error.message
              : "Counter transaction rejected.",
        });
        return true;
      }
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
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      json(response, 200, result);
    } catch {
      // Never retry a signed transaction here: the upstream may have accepted it.
      json(response, 502, { error: "Thruput RPC is unavailable." });
    }
    return true;
  };
}
