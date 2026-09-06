import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  REGISTRY_SORTS,
  type PoolQuery,
  type RegistrySort,
  type SyncController,
} from "./domain.ts";
import { RegistryStore } from "./store.ts";
import {
  boundedInteger,
  canonicalAddress,
  canonicalDecimal,
  ValidationError,
} from "./validation.ts";

const MAX_REQUEST_TARGET_BYTES = 8 * 1_024;
const MAX_REQUEST_BODY_BYTES = 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_PUBLIC_ERROR_BYTES = 500;
const ALLOWED_POOL_PARAMETERS = new Set([
  "q",
  "token",
  "sort",
  "limit",
  "offset",
  "asOfBlock",
]);

export function createRegistryHttpServer(
  store: RegistryStore,
  syncController: SyncController,
): Server {
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = requestUrl(request);
      const allowedMethod = methodForPath(url.pathname);
      if (allowedMethod === null) {
        return rejectBeforeBody(
          request,
          response,
          404,
          "not_found",
          "Route not found",
        );
      }
      if (request.method !== allowedMethod) {
        response.setHeader("allow", allowedMethod);
        return rejectBeforeBody(
          request,
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
      return sendJson(response, 200, store.queryPools(parsePoolQuery(url)));
    } catch (error) {
      if (error instanceof HttpError) {
        return sendRequestError(
          request,
          response,
          error.status,
          error.code,
          error.message,
        );
      }
      if (error instanceof ValidationError) {
        return sendRequestError(
          request,
          response,
          400,
          "invalid_request",
          error.message,
        );
      }
      return sendRequestError(
        request,
        response,
        500,
        "internal_error",
        "Internal server error",
      );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

export function parsePoolQuery(url: URL): PoolQuery {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_POOL_PARAMETERS.has(key)) {
      throw new ValidationError(`Unknown query parameter: ${key}`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError(`${key} must be provided once`);
    }
  }

  const rawSearch = url.searchParams.get("q");
  const q = rawSearch?.normalize("NFKC").trim();
  if (q !== undefined && Buffer.byteLength(q) > 100) {
    throw new ValidationError("q must contain at most 100 UTF-8 bytes");
  }
  const token = url.searchParams.get("token");
  const asOfBlock = url.searchParams.get("asOfBlock");
  const sort = url.searchParams.get("sort") ?? "newest";
  if (!isRegistrySort(sort)) {
    throw new ValidationError("sort must be newest, oldest, token0, or token1");
  }

  return {
    ...(q === undefined || q === "" ? {} : { q }),
    ...(token === null ? {} : { token: canonicalAddress(token, "token") }),
    sort,
    limit: queryInteger(url, "limit", 20, 1, 100),
    offset: queryInteger(url, "offset", 0, 0, 10_000),
    ...(asOfBlock === null
      ? {}
      : { asOfBlock: canonicalDecimal(asOfBlock, "asOfBlock") }),
  };
}

function isRegistrySort(value: string): value is RegistrySort {
  return REGISTRY_SORTS.some((candidate) => candidate === value);
}

function requestUrl(request: IncomingMessage): URL {
  const target = request.url;
  if (
    target === undefined ||
    Buffer.byteLength(target) > MAX_REQUEST_TARGET_BYTES ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#")
  ) {
    throw new ValidationError("Request target is invalid");
  }
  const rawPathname = target.split("?", 1)[0] ?? "";
  if (/%2f/iu.test(rawPathname)) {
    throw new ValidationError("Request path is invalid");
  }
  try {
    decodeURIComponent(target);
    const decodedPathname = decodeURIComponent(rawPathname);
    if (
      decodedPathname.includes("\0") ||
      decodedPathname.includes("\\") ||
      decodedPathname
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      throw new ValidationError("Request path is invalid");
    }
    return new URL(target, "http://registry.local");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Request target is invalid");
  }
}

function methodForPath(pathname: string): "GET" | "POST" | null {
  switch (pathname) {
    case "/healthz":
    case "/api/registry/status":
    case "/api/pools":
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
  if (contentLength !== undefined) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new ValidationError("Content-Length is invalid");
    }
    if (Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
  }

  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
  }
  if (length !== 0 || (contentLength !== undefined && contentLength !== "0")) {
    throw new ValidationError("Request body is not accepted");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
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
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  if (encoded.byteLength > MAX_RESPONSE_BYTES) {
    throw new HttpError(
      500,
      "response_too_large",
      "Registry response is too large",
    );
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", encoded.byteLength);
  response.end(encoded);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, {
    error: { code, message: truncateUtf8(message, MAX_PUBLIC_ERROR_BYTES) },
  });
}

function sendRequestError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (!request.complete) {
    rejectBeforeBody(request, response, status, code, message);
    return;
  }
  sendError(response, status, code, message);
}

function rejectBeforeBody(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  response.shouldKeepAlive = false;
  response.setHeader("connection", "close");
  response.once("finish", () => request.socket.destroySoon());
  sendError(response, status, code, message);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
