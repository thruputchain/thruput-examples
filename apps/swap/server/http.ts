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
  type PoolQuery,
  type RegistrySort,
  type SyncController,
} from "./domain.ts";
import { RegistryStore } from "./store.ts";
import { RpcRateLimiter, rpcClientIdentity } from "./rate-limit.ts";
import { createTokenDiscoveryHandler } from "./token-discovery.ts";
import type { loadTokenDiscoveryServerConfig } from "./token-discovery-config.ts";
import {
  boundedInteger,
  canonicalAddress,
  canonicalDecimal,
  ValidationError,
} from "./validation.ts";

export {
  RpcRateLimiter,
  rpcClientIdentity,
  DEFAULT_RPC_REQUESTS_PER_MINUTE,
} from "./rate-limit.ts";

const MAX_REQUEST_TARGET_BYTES = 8 * 1_024;
const MAX_REQUEST_BODY_BYTES = 1_024 * 1_024;
const MAX_REGISTRY_RESPONSE_BYTES = 256 * 1_024;
const MAX_RPC_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_PUBLIC_ERROR_BYTES = 500;
const MAX_VIEW_CALLDATA_BYTES = 64 * 1_024;
const MAX_EVENT_FILTERS = 10;
const MAX_EVENT_VALUES_PER_FILTER = 20;
const MAX_EVENT_CURSOR_CHARACTERS = 4_096;
const RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_MAXIMUM_RPC_CONCURRENCY = 128;
const ALLOWED_POOL_PARAMETERS = new Set([
  "q",
  "token",
  "sort",
  "limit",
  "offset",
  "asOfBlock",
]);
const READ_ONLY_RPC_METHODS = new Set([
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

export interface ProductionHttpOptions {
  staticDirectory?: string;
  rpcUrl: URL | string;
  publicConfig?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  maximumRpcConcurrency?: number;
  rpcRequestsPerMinute?: number;
  maximumRateLimitClients?: number;
  trustedProxy?: boolean;
  tokenDiscovery?: ReturnType<typeof loadTokenDiscoveryServerConfig>;
  now?: () => number;
}

interface ProductionContext {
  staticDirectory: string;
  indexPath: string;
  rpcUrl: URL;
  fetch: typeof globalThis.fetch;
  maximumRpcConcurrency: number;
  activeRpcRequests: number;
  rateLimit: RpcRateLimiter;
  trustedProxy: boolean;
}

export function createRegistryHttpServer(
  store: RegistryStore,
  syncController: SyncController,
  production?: ProductionHttpOptions,
): Server {
  const productionContext =
    production === undefined ? undefined : createProductionContext(production);
  const discovery = createTokenDiscoveryHandler(
    production?.tokenDiscovery ?? null,
    {
      fetch: production?.fetch,
      trustedProxy: production?.trustedProxy,
      now: production?.now,
    },
  );
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      if (await discovery(request, response)) return;
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
        if (
          productionContext === undefined ||
          url.pathname !== "/groundhog-rpc"
        ) {
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
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
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
  return sendJson(response, 200, store.queryPools(parsePoolQuery(url)));
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
  if (url.search !== "")
    throw new ValidationError("Query parameters are not accepted");
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

function createProductionContext(
  options: ProductionHttpOptions,
): ProductionContext {
  const staticDirectory = options.staticDirectory ? realpathSync(options.staticDirectory) : "";
  const indexPath = staticDirectory ? realpathSync(path.join(staticDirectory, "index.html")) : "";
  if (staticDirectory && !isWithin(staticDirectory, indexPath)) {
    throw new Error("Static index must be inside the static directory");
  }
  const rpcUrl = new URL(options.rpcUrl);
  if (
    !["http:", "https:"].includes(rpcUrl.protocol) ||
    rpcUrl.username !== "" ||
    rpcUrl.password !== "" ||
    rpcUrl.search !== "" ||
    rpcUrl.hash !== ""
  ) {
    throw new Error("Production RPC URL must be HTTP without credentials");
  }
  return {
    staticDirectory,
    indexPath,
    rpcUrl,
    fetch: options.fetch ?? globalThis.fetch,
    maximumRpcConcurrency:
      options.maximumRpcConcurrency ?? DEFAULT_MAXIMUM_RPC_CONCURRENCY,
    activeRpcRequests: 0,
    rateLimit: new RpcRateLimiter(
      options.rpcRequestsPerMinute,
      options.maximumRateLimitClients,
      options.now,
    ),
    trustedProxy: options.trustedProxy ?? false,
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
  const client = rpcClientIdentity(request, context.trustedProxy);
  if (!context.rateLimit.allow(client)) {
    return rejectBeforeBody(
      request,
      response,
      429,
      "rate_limited",
      "RPC request rate exceeded",
    );
  }
  const releaseSlot = acquireRpcSlot(context);
  if (releaseSlot === null) {
    return rejectBeforeBody(
      request,
      response,
      503,
      "rpc_busy",
      "RPC proxy is busy",
    );
  }

  const lifecycle = requestLifecycleSignal(request, response);
  try {
    const body = await readBoundedRequestBody(request);
    let envelope: unknown;
    try {
      envelope = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(
        400,
        "invalid_rpc_request",
        "Invalid JSON-RPC request",
      );
    }
    if (!isAllowedProductionRpcRequest(envelope)) {
      const method = isRecord(envelope) ? envelope.method : undefined;
      throw new HttpError(
        typeof method === "string" && !READ_ONLY_RPC_METHODS.has(method)
          ? 403
          : 400,
        typeof method === "string" && !READ_ONLY_RPC_METHODS.has(method)
          ? "rpc_method_not_allowed"
          : "invalid_rpc_request",
        typeof method === "string" && !READ_ONLY_RPC_METHODS.has(method)
          ? "RPC method is not available"
          : "Invalid JSON-RPC request",
      );
    }

    let upstream: Response;
    try {
      upstream = await context.fetch(context.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body.toString("utf8"),
        redirect: "error",
        signal: AbortSignal.any([
          lifecycle.signal,
          AbortSignal.timeout(RPC_TIMEOUT_MS),
        ]),
      });
    } catch {
      throw new HttpError(
        502,
        "rpc_unavailable",
        "RPC upstream is unavailable",
      );
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new HttpError(
        502,
        "rpc_unavailable",
        "RPC upstream is unavailable",
      );
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
      const responseEnvelope: unknown = JSON.parse(
        Buffer.from(responseBody).toString("utf8"),
      );
      if (!isValidJsonRpcResponse(responseEnvelope, envelope.id)) {
        throw new Error("Invalid JSON-RPC response envelope");
      }
      if ("error" in responseEnvelope) {
        responseBody = sanitizedJsonRpcError(responseEnvelope);
      }
    } catch {
      throw new HttpError(
        502,
        "invalid_rpc_response",
        "RPC upstream returned an invalid response",
      );
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", responseBody.byteLength);
    response.end(responseBody);
  } finally {
    lifecycle.cleanup();
    releaseSlot();
  }
}

type JsonRpcId = string | number | null;
interface ProductionRpcRequest extends Record<string, unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: unknown[];
}

interface JsonRpcResultResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

export function isAllowedProductionRpcRequest(
  value: unknown,
): value is ProductionRpcRequest {
  if (
    !isExactRecord(value, ["jsonrpc", "id", "method", "params"]) ||
    value.jsonrpc !== "2.0" ||
    !isRpcId(value.id) ||
    typeof value.method !== "string" ||
    !READ_ONLY_RPC_METHODS.has(value.method) ||
    !Array.isArray(value.params)
  ) {
    return false;
  }
  switch (value.method) {
    case "groundhog_networkInfo":
    case "groundhog_chainTip":
      return value.params.length === 0;
    case "groundhog_getTransactionReceipt":
    case "groundhog_getTransactionStatus":
      return value.params.length === 1 && isCanonicalHash(value.params[0]);
    case "groundhog_view":
      return validViewParams(value.params);
    case "groundhog_getEvents":
      return validEventParams(value.params);
    default:
      return false;
  }
}

export function isValidJsonRpcResponse(
  value: unknown,
  requestId: JsonRpcId,
): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== requestId) {
    return false;
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  if (hasResult) return isExactRecord(value, ["jsonrpc", "id", "result"]);
  if (!isExactRecord(value, ["jsonrpc", "id", "error"])) return false;
  const error = value.error;
  return (
    isRecord(error) &&
    hasKeys(error, ["code", "message"]) &&
    hasOnlyKeys(error, ["code", "message", "data"]) &&
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    typeof error.message === "string"
  );
}

function sanitizedJsonRpcError(response: JsonRpcErrorResponse): Uint8Array {
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: response.id,
      error: {
        code: Number.isSafeInteger(response.error.code)
          ? response.error.code
          : -32603,
        message: "RPC request failed",
      },
    }),
  );
  if (body.byteLength > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("RPC response is too large after sanitization");
  }
  return body;
}

function acquireRpcSlot(context: ProductionContext): (() => void) | null {
  if (context.activeRpcRequests >= context.maximumRpcConcurrency) return null;
  context.activeRpcRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    context.activeRpcRequests -= 1;
  };
}

function requestLifecycleSignal(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("RPC client disconnected"));
  request.once("aborted", abort);
  response.once("close", abort);
  request.socket.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abort);
      request.socket.off("close", abort);
    },
  };
}

function validViewParams(params: unknown[]): boolean {
  if (params.length !== 1) return false;
  const request = params[0];
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, ["contract", "entrypoint", "calldata", "caller"]) ||
    !hasKeys(request, ["contract", "entrypoint", "calldata"]) ||
    !isCanonicalAddress(request.contract) ||
    typeof request.entrypoint !== "string" ||
    !/^0x[0-9a-f]{16}$/u.test(request.entrypoint) ||
    !isBoundedHex(request.calldata, MAX_VIEW_CALLDATA_BYTES)
  ) {
    return false;
  }
  return request.caller === undefined || isCanonicalAddress(request.caller);
}

function validEventParams(params: unknown[]): boolean {
  if (params.length !== 1) return false;
  const query = params[0];
  if (
    !isExactRecord(query, ["filters", "order", "anchor", "cursor", "limit"]) ||
    !Array.isArray(query.filters) ||
    query.filters.length < 1 ||
    query.filters.length > MAX_EVENT_FILTERS ||
    (query.order !== "ascending" && query.order !== "descending") ||
    !validEventAnchor(query.anchor) ||
    !isBoundedCursor(query.cursor) ||
    !Number.isSafeInteger(query.limit) ||
    (query.limit as number) < 1 ||
    (query.limit as number) > 500
  ) {
    return false;
  }
  return query.filters.every(validEventFilter);
}

function validEventFilter(value: unknown): boolean {
  if (
    !isExactRecord(value, ["contractAddresses", "topics"]) ||
    !Array.isArray(value.contractAddresses) ||
    value.contractAddresses.length > MAX_EVENT_VALUES_PER_FILTER ||
    !value.contractAddresses.every(isCanonicalAddress) ||
    !isExactRecord(value.topics, ["topic0", "topic1", "topic2"])
  ) {
    return false;
  }
  return [value.topics.topic0, value.topics.topic1, value.topics.topic2].every(
    (topics) =>
      Array.isArray(topics) &&
      topics.length <= MAX_EVENT_VALUES_PER_FILTER &&
      topics.every(isCanonicalHash),
  );
}

function validEventAnchor(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "atBeginning" || value.kind === "atEnd") {
    return isExactRecord(value, ["kind"]);
  }
  return (
    value.kind === "atHeight" &&
    isExactRecord(value, ["kind", "height"]) &&
    Number.isSafeInteger(value.height) &&
    (value.height as number) >= 0
  );
}

function isRpcId(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isCanonicalAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/u.test(value);
}

function isCanonicalHash(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/u.test(value);
}

function isBoundedHex(value: unknown, maximumBytes: number): boolean {
  return (
    typeof value === "string" &&
    value.length <= maximumBytes * 2 + 2 &&
    /^0x(?:[0-9a-f]{2})*$/u.test(value)
  );
}

function isBoundedCursor(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_EVENT_CURSOR_CHARACTERS &&
    /^0x(?:[0-9a-f]{2})*$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasKeys(value, keys) && hasOnlyKeys(value, keys);
}

function hasKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
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
  await requireEmptyBody(request);
  const pathname = decodeURIComponent(url.pathname);
  const candidate = await existingFile(
    path.join(context.staticDirectory, pathname.slice(1)),
  );
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
    response.end(await file.readFile());
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
  if (/%2f/iu.test(rawPathname))
    throw new ValidationError("Request path is invalid");
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

async function requireEmptyBody(request: IncomingMessage): Promise<void> {
  const body = await readBoundedRequestBody(request);
  if (body.byteLength !== 0)
    throw new ValidationError("Request body is not accepted");
}

async function readBoundedRequestBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/u.test(contentLength))
      throw new ValidationError("Content-Length is invalid");
    if (Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function readBoundedResponseBody(
  response: Response,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/u.test(declared) &&
    Number(declared) > MAX_RPC_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
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
    if (length > MAX_RPC_RESPONSE_BYTES) {
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

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/iu.test(value);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=()",
  );
  response.setHeader("cache-control", "no-store");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  if (encoded.byteLength > MAX_REGISTRY_RESPONSE_BYTES) {
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
  if (!request.complete)
    return rejectBeforeBody(request, response, status, code, message);
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
