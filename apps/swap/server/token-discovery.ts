import type { IncomingMessage, ServerResponse } from "node:http";

import {
  discoveryQuery,
  MAX_DISCOVERY_RESPONSE_BYTES,
  projectToken,
  readDiscoveryJson,
  record,
  validateDiscoveryResponse,
  validateScope,
  type DiscoveryScope,
} from "../src/token-discovery/wire.ts";
import { RpcRateLimiter, rpcClientIdentity } from "./rate-limit.ts";

interface Options {
  fetch?: typeof globalThis.fetch | undefined;
  trustedProxy?: boolean | undefined;
  now?: (() => number) | undefined;
}

export function createTokenDiscoveryHandler(
  config: { origin: string; scope: DiscoveryScope } | null,
  options: Options = {},
) {
  const limiter = new RpcRateLimiter(60, 10_000, options.now);
  const fetcher = options.fetch ?? globalThis.fetch;
  let active = 0;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    let query: string;
    try {
      const target = request.url ?? "";
      const rawPath = target.split("?", 1)[0] ?? "";
      const decodedPath = decodeURIComponent(rawPath);
      if (
        !target.startsWith("/") ||
        target.startsWith("//") ||
        target.includes("#") ||
        /[\x00-\x20\\]/.test(rawPath) ||
        /%2f|%5c/i.test(rawPath) ||
        decodedPath.includes("\0") ||
        decodedPath.includes("\\") ||
        decodedPath
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      )
        throw new Error();
      if (!decodedPath.startsWith("/api/token-discovery")) return false;
      if (Buffer.byteLength(target) > 2_048) throw new Error();
      decodeURIComponent(target);
      if (rawPath !== "/api/token-discovery" || config === null) {
        send(404, "not_found", "Route not found");
        return true;
      }
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        send(405, "method_not_allowed", "GET is required");
        return true;
      }
      if (
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      )
        throw new Error();
      const parameters = new URL(target, "http://discovery.invalid")
        .searchParams;
      if (
        [...parameters.keys()].some((key) => key !== "q") ||
        parameters.getAll("q").length > 1
      )
        throw new Error();
      query = discoveryQuery(parameters.get("q") ?? "");
      if (
        !limiter.allow(
          rpcClientIdentity(request, options.trustedProxy ?? false),
        )
      ) {
        send(429, "rate_limited", "Token discovery request rate exceeded");
        return true;
      }
    } catch {
      send(400, "invalid_request", "Invalid token discovery request");
      return true;
    }
    const { scope, origin } = config;
    if (active >= 16) {
      send(503, "discovery_busy", "Token discovery is busy");
      return true;
    }
    // Both reads and their bodies share one slot and deadline.
    active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 10_000);
    request.once("aborted", abort);
    response.once("close", abort);
    request.socket.once("close", abort);
    try {
      const status = record(await getJson("/api/registry/status"));
      validateScope({ ...status, tokenCodeHash: scope.tokenCodeHash }, scope);
      decimal(status.indexedThroughBlock);
      if (
        !nonnegativeInteger(status.tokenCount) ||
        typeof status.historyLimited !== "boolean" ||
        typeof status.syncing !== "boolean" ||
        typeof status.syncState !== "string" ||
        !["idle", "syncing", "retrying", "integrityFault"].includes(
          status.syncState,
        ) ||
        status.syncing !==
          (status.syncState === "syncing" || status.syncState === "retrying")
      )
        throw new Error();
      if (status.syncState === "integrityFault") {
        send(
          503,
          "registry_integrity_fault",
          "Token registry integrity check failed",
        );
        return true;
      }
      const parameters = new URLSearchParams({
        sort: "newest",
        limit: "20",
        offset: "0",
      });
      if (query) parameters.set("q", query);
      const page = record(await getJson(`/api/tokens?${parameters}`));
      const snapshot = decimal(page.asOfBlock);
      if (
        page.limit !== 20 ||
        page.offset !== 0 ||
        !Array.isArray(page.tokens) ||
        page.tokens.length > 20 ||
        !nonnegativeInteger(page.total) ||
        page.tokens.length !== Math.min(page.total, 20) ||
        page.hasMore !== page.total > page.tokens.length ||
        typeof page.historyLimited !== "boolean"
      )
        throw new Error();
      const tokens = page.tokens.map((value) => {
        const row = record(value);
        validateScope(row, scope);
        if (BigInt(decimal(row.blockHeight)) > BigInt(snapshot))
          throw new Error();
        return projectToken(row);
      });
      const projected = validateDiscoveryResponse(
        {
          scope,
          tokens,
          hasMore: page.hasMore,
          historyLimited: status.historyLimited || page.historyLimited,
          syncState: status.syncState,
        },
        scope,
      );
      const body = JSON.stringify(projected);
      if (Buffer.byteLength(body) > MAX_DISCOVERY_RESPONSE_BYTES)
        throw new Error();
      sendBody(200, body);
    } catch {
      send(502, "discovery_unavailable", "Token discovery is unavailable");
    } finally {
      clearTimeout(timeout);
      request.off("aborted", abort);
      response.off("close", abort);
      request.socket.off("close", abort);
      active -= 1;
    }
    return true;

    async function getJson(path: string): Promise<unknown> {
      controller.signal.throwIfAborted();
      const response = await fetcher(new URL(path, origin), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      return readDiscoveryJson(response, controller.signal);
    }

    function send(status: number, code: string, message: string): void {
      sendBody(status, JSON.stringify({ error: { code, message } }));
    }

    function sendBody(status: number, body: string): void {
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = status;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("x-content-type-options", "nosniff");
      if (!request.complete) {
        response.shouldKeepAlive = false;
        response.setHeader("connection", "close");
        response.once("finish", () => request.socket.destroySoon());
      }
      response.end(body);
    }
  };
}

function decimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,99})$/.test(value) ||
    value.trim() !== value
  )
    throw new Error("Invalid block height");
  return value;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
