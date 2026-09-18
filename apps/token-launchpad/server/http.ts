import { realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import {
  REGISTRY_SORTS,
  type RegistrySort,
  type SyncController,
  type TokenQuery,
} from "../shared/registry.ts";
import { RegistryStore } from "./store.ts";
import {
  boundedInteger,
  canonicalAddress,
  canonicalDecimal,
  ValidationError,
} from "./validation.ts";

const MAX_REQUEST_TARGET_BYTES = 2_048;
const MAX_PUBLIC_ERROR_BYTES = 300;
const MAX_RPC_BYTES = 1_000_000;
const RPC_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const PRODUCTION_RPC_METHODS = new Set([
  "groundhog_networkInfo",
  "groundhog_chainTip",
  "groundhog_getEvents",
  "groundhog_getTransactionReceipt",
  "groundhog_getTransactionStatus",
  "groundhog_view",
]);
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const ALLOWED_TOKEN_PARAMETERS = new Set([
  "tokenAddress",
  "q",
  "creator",
  "sort",
  "limit",
  "offset",
  "asOfBlock",
]);

export interface ProductionHttpOptions {
  staticDirectory?: string;
  rpcUrl: URL | string;
  publicConfig?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export function createRegistryHttpServer(
  store: RegistryStore,
  syncController: SyncController,
  production?: ProductionHttpOptions,
): Server {
  const productionContext =
    production === undefined ? undefined : createProductionContext(production);
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = requestUrl(request);
      if (url.pathname === "/api/config") {
        if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "GET is required");
        await requireEmptyBody(request);
        rejectParameters(url);
        if (!production?.publicConfig) throw new HttpError(503, "configuration_unavailable", "Public configuration is unavailable");
        return sendJson(response, 200, production.publicConfig);
      }
      const allowedMethod = methodForPath(url.pathname);
      if (allowedMethod !== null) {
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
        return handleApiRequest(store, syncController, url, response);
      }

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return rejectBeforeBody(
          request,
          response,
          404,
          "not_found",
          "Route not found",
        );
      }

      if (
        url.pathname === "/groundhog-rpc" ||
        url.pathname.startsWith("/groundhog-rpc/")
      ) {
        if (productionContext === undefined) {
          return rejectBeforeBody(
            request,
            response,
            404,
            "not_found",
            "Route not found",
          );
        }
        if (url.pathname !== "/groundhog-rpc") {
          return rejectBeforeBody(
            request,
            response,
            404,
            "not_found",
            "Route not found",
          );
        }
        return await handleRpcRequest(
          request,
          response,
          url,
          productionContext,
        );
      }

      if (productionContext === undefined || !productionContext.staticDirectory) {
        return rejectBeforeBody(
          request,
          response,
          404,
          "not_found",
          "Route not found",
        );
      }
      return await serveStatic(request, response, url, productionContext);
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
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.timeout = REQUEST_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;
  return server;
}

function handleApiRequest(
  store: RegistryStore,
  syncController: SyncController,
  url: URL,
  response: ServerResponse,
): void {
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
    ...(url.searchParams.has("tokenAddress")
      ? {
          tokenAddress: canonicalAddress(
            url.searchParams.get("tokenAddress")!,
            "tokenAddress",
          ),
        }
      : {}),
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
      decodedPathname.split("/").some((part) => part === "." || part === "..")
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

interface ProductionContext {
  staticDirectory: string;
  indexPath: string;
  rpcUrl: URL;
  fetch: typeof globalThis.fetch;
}

function createProductionContext(
  options: ProductionHttpOptions,
): ProductionContext {
  const staticDirectory = options.staticDirectory ? realpathSync(options.staticDirectory) : "";
  const indexPath = staticDirectory ? realpathSync(path.join(staticDirectory, "index.html")) : "";
  if (staticDirectory && !isWithin(staticDirectory, indexPath)) {
    throw new Error("Static index must be inside the static directory");
  }
  const rpcUrl =
    options.rpcUrl instanceof URL
      ? new URL(options.rpcUrl)
      : new URL(options.rpcUrl);
  if (
    !["http:", "https:"].includes(rpcUrl.protocol) ||
    rpcUrl.username !== "" ||
    rpcUrl.password !== ""
  ) {
    throw new Error("Production RPC URL must be HTTP without credentials");
  }
  return {
    staticDirectory,
    indexPath,
    rpcUrl,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

async function handleRpcRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ProductionContext,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    return rejectBeforeBody(
      request,
      response,
      405,
      "method_not_allowed",
      "POST is required",
    );
  }
  if (url.search !== "") {
    return rejectBeforeBody(
      request,
      response,
      400,
      "invalid_request",
      "Query parameters are not accepted",
    );
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    return rejectBeforeBody(
      request,
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    );
  }

  const body = await readBoundedRequestBody(request);
  let envelope: unknown;
  try {
    envelope = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_rpc_request", "Invalid JSON-RPC request");
  }
  if (!isJsonRpcRequest(envelope)) {
    throw new HttpError(400, "invalid_rpc_request", "Invalid JSON-RPC request");
  }
  if (!PRODUCTION_RPC_METHODS.has(envelope.method)) {
    throw new HttpError(
      403,
      "rpc_method_not_allowed",
      "RPC method is not available",
    );
  }

  let upstream: Response;
  try {
    upstream = await context.fetch(context.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body.toString("utf8"),
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "rpc_unavailable", "RPC upstream is unavailable");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "rpc_unavailable", "RPC upstream is unavailable");
  }
  if (!isJsonContentType(upstream.headers.get("content-type") ?? undefined)) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HttpError(
      502,
      "invalid_rpc_response",
      "RPC upstream returned an invalid response",
    );
  }

  let responseBody: Uint8Array;
  try {
    responseBody = await readBoundedResponseBody(upstream);
  } catch {
    throw new HttpError(
      502,
      "invalid_rpc_response",
      "RPC upstream returned an invalid response",
    );
  }
  response.statusCode = upstream.status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", responseBody.byteLength);
  response.end(responseBody);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ProductionContext,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    return rejectBeforeBody(
      request,
      response,
      405,
      "method_not_allowed",
      "GET or HEAD is required",
    );
  }

  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = path.join(context.staticDirectory, pathname.slice(1));
  const candidate = await existingFile(requestedPath);
  let filePath = context.indexPath;
  let isIndex = true;
  if (candidate !== null) {
    if (!isWithin(context.staticDirectory, candidate)) {
      throw new HttpError(400, "invalid_request", "Request path is invalid");
    }
    filePath = candidate;
    isIndex = candidate === context.indexPath;
  } else if (
    pathname.startsWith("/assets/") ||
    path.posix.extname(pathname) !== ""
  ) {
    throw new HttpError(404, "not_found", "File not found");
  }

  const file = await open(filePath, "r");
  try {
    const fileStat = await file.stat();
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      MIME_TYPES[path.extname(filePath).toLowerCase()] ??
        "application/octet-stream",
    );
    response.setHeader("content-length", fileStat.size);
    response.setHeader(
      "cache-control",
      isIndex
        ? "no-cache, no-store, must-revalidate"
        : pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    );
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const body = await file.readFile();
    response.end(body);
  } finally {
    await file.close();
  }
}

async function existingFile(candidate: string): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/iu.test(value);
}

export function isJsonRpcRequest(
  value: unknown,
): value is { jsonrpc: "2.0"; method: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "method" in value &&
    typeof value.method === "string" &&
    (!("id" in value) ||
      value.id === null ||
      typeof value.id === "string" ||
      (typeof value.id === "number" && Number.isFinite(value.id))) &&
    (!("params" in value) ||
      (typeof value.params === "object" && value.params !== null))
  );
}

async function readBoundedRequestBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_RPC_BYTES) {
    request.resume();
    throw new HttpError(413, "request_too_large", "RPC request is too large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_RPC_BYTES) {
      request.resume();
      throw new HttpError(413, "request_too_large", "RPC request is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function readBoundedResponseBody(
  response: Response,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RPC_BYTES) {
    throw new Error("RPC response is too large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RPC_BYTES) {
      await reader.cancel();
      throw new Error("RPC response is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
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
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
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
