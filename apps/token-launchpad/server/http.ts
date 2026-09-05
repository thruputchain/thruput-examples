import { createServer, type IncomingMessage, type Server } from "node:http";

import {
  REGISTRY_SORTS,
  type RegistrySort,
  type SyncController,
  type TokenQuery,
} from "./domain.ts";
import { RegistryStore } from "./store.ts";
import {
  boundedInteger,
  canonicalAddress,
  canonicalDecimal,
  ValidationError,
} from "./validation.ts";

const MAX_REQUEST_TARGET_BYTES = 2_048;
const MAX_PUBLIC_ERROR_BYTES = 300;
const ALLOWED_TOKEN_PARAMETERS = new Set([
  "q",
  "creator",
  "sort",
  "limit",
  "offset",
  "asOfBlock",
]);

export function createRegistryHttpServer(
  store: RegistryStore,
  syncController: SyncController,
): Server {
  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = requestUrl(request);
      const allowedMethod = methodForPath(url.pathname);
      if (allowedMethod === null) {
        return sendError(response, 404, "not_found", "Route not found");
      }
      if (request.method !== allowedMethod) {
        response.setHeader("allow", allowedMethod);
        return sendError(
          response,
          405,
          "method_not_allowed",
          `${allowedMethod} is required`,
        );
      }
      await requireEmptyBody(request);

      if (url.pathname === "/healthz") {
        rejectParameters(url);
        if (!store.healthCheck()) {
          return sendError(response, 503, "not_ready", "Registry is not ready");
        }
        return sendJson(response, 200, { status: "ok" });
      }
      if (url.pathname === "/api/registry/status") {
        rejectParameters(url);
        return sendJson(response, 200, store.getStatus());
      }
      if (url.pathname === "/api/registry/sync") {
        rejectParameters(url);
        syncController.requestSync();
        return sendJson(response, 202, store.getStatus());
      }
      return sendJson(response, 200, store.queryTokens(parseTokenQuery(url)));
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendError(response, 400, "invalid_request", error.message);
      }
      return sendError(
        response,
        500,
        "internal_error",
        "Internal server error",
      );
    }
  });
}

export function parseTokenQuery(url: URL): TokenQuery {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_TOKEN_PARAMETERS.has(key)) {
      throw new ValidationError(`Unknown query parameter: ${key}`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError(`${key} must be provided once`);
    }
  }

  const qValue = url.searchParams.get("q");
  const q = qValue?.trim();
  if (q !== undefined && Buffer.byteLength(q) > 100) {
    throw new ValidationError("q must contain at most 100 UTF-8 bytes");
  }
  const creatorValue = url.searchParams.get("creator");
  const asOfBlockValue = url.searchParams.get("asOfBlock");
  const sort = url.searchParams.get("sort") ?? "newest";
  if (!isRegistrySort(sort)) {
    throw new ValidationError("sort must be newest, oldest, name, or symbol");
  }

  return {
    ...(q === undefined || q === "" ? {} : { q }),
    ...(creatorValue === null
      ? {}
      : { creator: canonicalAddress(creatorValue, "creator") }),
    sort,
    limit: queryInteger(url, "limit", 20, 1, 100),
    offset: queryInteger(url, "offset", 0, 0, 10_000),
    ...(asOfBlockValue === null
      ? {}
      : { asOfBlock: canonicalDecimal(asOfBlockValue, "asOfBlock") }),
  };
}

function isRegistrySort(value: string): value is RegistrySort {
  return REGISTRY_SORTS.some((candidate) => candidate === value);
}

function requestUrl(request: IncomingMessage): URL {
  const target = request.url;
  if (
    target === undefined ||
    Buffer.byteLength(target) > MAX_REQUEST_TARGET_BYTES
  ) {
    throw new ValidationError("Request target is invalid");
  }
  try {
    return new URL(target, "http://registry.local");
  } catch {
    throw new ValidationError("Request target is invalid");
  }
}

function methodForPath(pathname: string): "GET" | "POST" | null {
  switch (pathname) {
    case "/healthz":
    case "/api/registry/status":
    case "/api/tokens":
      return "GET";
    case "/api/registry/sync":
      return "POST";
    default:
      return null;
  }
}

function rejectParameters(url: URL): void {
  if (url.search !== "") {
    throw new ValidationError("Query parameters are not accepted");
  }
}

function queryInteger(
  url: URL,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = url.searchParams.get(key);
  return value === null
    ? fallback
    : boundedInteger(value, key, minimum, maximum);
}

async function requireEmptyBody(request: IncomingMessage): Promise<void> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && contentLength !== "0") {
    throw new ValidationError("Request body is not accepted");
  }
  for await (const chunk of request) {
    if (Buffer.byteLength(chunk) > 0) {
      throw new ValidationError("Request body is not accepted");
    }
  }
}

function setSecurityHeaders(
  response: import("node:http").ServerResponse,
): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store");
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendError(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, {
    error: {
      code,
      message: truncateUtf8(message, MAX_PUBLIC_ERROR_BYTES),
    },
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}
