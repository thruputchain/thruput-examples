import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  buildNamedCodecs,
  resolveCodec,
} from "@groundhogchain/client/contract";
import { serializeCxs } from "@groundhogchain/xdr";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { normalizeNetworkId } from "./src/config-values";
import { spec as lifeSpec } from "./src/contracts/generated/game-of-life";

const root = path.dirname(fileURLToPath(import.meta.url));
const READ_RPC_METHODS = new Set([
  "groundhog_chainTip",
  "groundhog_getEvents",
  "groundhog_view",
]);
const MAX_BODY = 1_000_000;
const MAX_INDEXER_JSON = 1_000_000;
const MAX_INDEXER_TILE = 131_072;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-ancestors 'none'",
};

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, root, "");
  const target = environment.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545";
  const indexerTarget =
    environment.VITE_GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787";
  const { networkId, contractAddress } = indexerProxyScope(
    mode === "test" || command === "build"
      ? {
          VITE_GROUNDHOG_NETWORK_ID:
            environment.VITE_GROUNDHOG_NETWORK_ID ?? "11".repeat(32),
          VITE_GAME_OF_LIFE_CONTRACT_ADDRESS:
            environment.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS ??
            `0x${"22".repeat(32)}`,
        }
      : environment,
  );
  validateRpcTarget(target);
  validateIndexerTarget(indexerTarget);
  return {
    envPrefix: [
      "VITE_GROUNDHOG_RPC_URL",
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
      "VITE_GAME_OF_LIFE_INDEXER_URL",
    ],
    plugins: [
      react(),
      tailwindcss(),
      readOnlyRpcProxy(target),
      readOnlyIndexerProxy(indexerTarget, networkId, contractAddress),
      ...(mode === "e2e" ? [fixtureArtifacts(networkId, contractAddress)] : []),
    ],
    resolve: { alias: { "@": path.resolve(root, "src") } },
    server: {
      host: "127.0.0.1",
      cors: false,
      headers: SECURITY_HEADERS,
    },
    preview: { host: "127.0.0.1", cors: false, headers: SECURITY_HEADERS },
    test: {
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://127.0.0.1" } },
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "vite.config.test.ts"],
    },
  };
});

export function validateRpcTarget(input: string): void {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !isLoopback(url.hostname)
  ) {
    throw new Error(
      "The Phase 4 RPC proxy requires a credential-free loopback HTTP(S) target",
    );
  }
}

export function validateIndexerTarget(input: string): void {
  try {
    validateRpcTarget(input);
    const url = new URL(input);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error();
  } catch {
    throw new Error(
      "The Phase 4 indexer proxy requires a credential-free loopback HTTP(S) origin root without a path, query, or hash",
    );
  }
}

export function indexerProxyScope(
  environment: Record<string, string | undefined>,
): {
  readonly networkId: string;
  readonly contractAddress: string;
} {
  const networkId = normalizeNetworkId(
    environment.VITE_GROUNDHOG_NETWORK_ID ?? "",
  );
  const contractAddress = environment.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS ?? "";
  if (!/^0x[0-9a-f]{64}$/.test(contractAddress))
    throw new Error(
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS must be canonical lowercase hex32",
    );
  return { networkId, contractAddress };
}

export function isAllowedRpcRequest(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return false;
  const value = input as Record<string, unknown>;
  return (
    value.jsonrpc === "2.0" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.method === "string" &&
    READ_RPC_METHODS.has(value.method) &&
    Object.keys(value).every((key) =>
      ["jsonrpc", "id", "method", "params"].includes(key),
    )
  );
}

export function isSameOriginLoopback(
  headers: IncomingMessage["headers"],
): boolean {
  if (!headers.host || headers["sec-fetch-site"] === "cross-site") return false;
  try {
    const source = headers.origin ?? headers.referer;
    if (!source) return false;
    const origin = new URL(source);
    return (
      isLoopback(origin.hostname) &&
      ["http:", "https:"].includes(origin.protocol) &&
      origin.host === headers.host
    );
  } catch {
    return false;
  }
}

export interface IndexerRoute {
  readonly contentType: string;
  readonly maxBytes: number;
}

export function allowedIndexerRoute(
  requestUrl: string,
  networkId: string,
  contractAddress: string,
): IndexerRoute | null {
  if (
    !/^[0-9a-f]{64}$/.test(networkId) ||
    !/^0x[0-9a-f]{64}$/.test(contractAddress) ||
    requestUrl.includes("?") ||
    requestUrl.includes("#") ||
    requestUrl.includes("%")
  )
    return null;
  const base = `/v1/worlds/${networkId}/${contractAddress}`;
  if (
    requestUrl === `${base}/latest.json` ||
    requestUrl === `${base}/status.json`
  )
    return { contentType: "application/json", maxBytes: MAX_INDEXER_JSON };
  if (
    new RegExp(`^${base}/0x[0-9a-f]{64}/(?:manifest|provenance)\\.json$`).test(
      requestUrl,
    )
  )
    return { contentType: "application/json", maxBytes: MAX_INDEXER_JSON };
  const tile = requestUrl.match(
    new RegExp(`^${base}/0x[0-9a-f]{64}/tiles/([0-6])/(\\d+)/(\\d+)\\.bin$`),
  );
  if (!tile) return null;
  const z = Number(tile[1]);
  const tilesPerSide = Math.ceil(10_000 / (256 * 2 ** (6 - z)));
  if (Number(tile[2]) >= tilesPerSide || Number(tile[3]) >= tilesPerSide)
    return null;
  return {
    contentType:
      z === 6
        ? "application/vnd.groundhog.life-cells-v1"
        : "application/vnd.groundhog.life-density-u16le",
    maxBytes: MAX_INDEXER_TILE,
  };
}

function readOnlyRpcProxy(target: string): Plugin {
  const targetUrl = new URL(target);
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "POST")
      return error(response, 405, "POST is required");
    if (!isSameOriginLoopback(request.headers))
      return error(response, 403, "Same-origin loopback request required");
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() !==
      "application/json"
    )
      return error(response, 415, "application/json is required");
    try {
      const body = await readBody(request);
      const envelope: unknown = JSON.parse(body);
      if (!isAllowedRpcRequest(envelope))
        return error(
          response,
          403,
          "RPC method is not available through this read-only proxy",
        );
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (
        mediaType(upstream.headers.get("content-type")) !== "application/json"
      )
        return error(
          response,
          502,
          "RPC upstream returned an unsafe content type",
        );
      const bytes = await readBoundedResponse(upstream, MAX_BODY);
      response.statusCode = upstream.status;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", bytes.length);
      response.end(bytes);
    } catch (cause) {
      return error(
        response,
        502,
        cause instanceof Error ? cause.message : "RPC proxy failed",
      );
    }
  };
  return {
    name: "groundhog-read-only-rpc",
    configureServer(server) {
      server.middlewares.use("/groundhog-rpc", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/groundhog-rpc", middleware);
    },
  };
}

function readOnlyIndexerProxy(
  target: string,
  networkId: string,
  contractAddress: string,
): Plugin {
  const targetUrl = new URL(target);
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "GET")
      return error(response, 405, "GET is required");
    if (!isSameOriginLoopback(request.headers))
      return error(response, 403, "Same-origin loopback request required");
    const route = allowedIndexerRoute(
      request.url ?? "",
      networkId,
      contractAddress,
    );
    if (!route)
      return error(
        response,
        404,
        "Indexer path is not available through this proxy",
      );
    try {
      const upstream = await fetch(new URL(request.url!, targetUrl.origin), {
        method: "GET",
        headers: { accept: route.contentType },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (isIndexerArtifactNotFound(upstream.status)) {
        await upstream.body?.cancel().catch(() => undefined);
        return error(response, 404, "Indexer artifact not found");
      }
      if (mediaType(upstream.headers.get("content-type")) !== route.contentType)
        return error(
          response,
          502,
          "Indexer upstream returned an unsafe content type",
        );
      const bytes = await readBoundedResponse(upstream, route.maxBytes);
      response.statusCode = upstream.status;
      response.setHeader("content-type", route.contentType);
      response.setHeader("content-length", bytes.length);
      response.setHeader("x-content-type-options", "nosniff");
      copySafeArtifactHeader(
        upstream,
        response,
        "etag",
        /^W\/"[^"\r\n]*"$|^"[^"\r\n]*"$/,
      );
      copySafeArtifactHeader(
        upstream,
        response,
        "cache-control",
        /^[a-zA-Z0-9_\s=,";*-]+$/,
      );
      response.end(bytes);
    } catch (cause) {
      return error(
        response,
        502,
        cause instanceof Error ? cause.message : "Indexer proxy failed",
      );
    }
  };
  return {
    name: "groundhog-read-only-indexer",
    configureServer(server) {
      server.middlewares.use("/groundhog-indexer", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/groundhog-indexer", middleware);
    },
  };
}

export function isIndexerArtifactNotFound(status: number): boolean {
  return status === 404;
}

async function readBoundedResponse(
  upstream: Response,
  maximum: number,
): Promise<Buffer> {
  if (!upstream.body) return Buffer.alloc(0);
  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error("Upstream response is too large");
      chunks.push(Buffer.from(value));
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  }
  return Buffer.concat(chunks, length);
}

function mediaType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function copySafeArtifactHeader(
  upstream: Response,
  response: ServerResponse,
  name: string,
  pattern: RegExp,
): void {
  const value = upstream.headers.get(name);
  if (value && pattern.test(value)) response.setHeader(name, value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) throw new Error("RPC request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function error(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: message }));
}
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function fixtureArtifacts(network: string, contract: string): Plugin {
  const digest = `0x${"aa".repeat(32)}`;
  const block = `0x${"bb".repeat(32)}`;
  const transaction = `0x${"cc".repeat(32)}`;
  const base = `/v1/worlds/${network}/${contract}`;
  const identity = {
    networkId: network,
    contractAddress: contract,
    generation: "0",
    seed: "7",
    population: "32768",
    stateDigest: digest,
  };
  const json = new Map<string, unknown>([
    [
      `${base}/latest.json`,
      {
        schemaVersion: 1,
        generation: "0",
        stateDigest: digest,
        manifestUrl: `${base}/${digest}/manifest.json`,
        sourceBlockHeight: "9",
        sourceBlockHash: block,
        publishedAt: "2026-08-28T01:02:03Z",
      },
    ],
    [
      `${base}/${digest}/manifest.json`,
      {
        schemaVersion: 1,
        ...identity,
        width: 10000,
        height: 10000,
        population: "32768",
        tileSize: 256,
        maxZoom: 6,
        densityEncoding: "u16le-live-count",
        cellEncoding: "row-major-lsb-first",
        tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
        verification: {
          canonicalDownloadVerified: true,
          individualTileProofs: false,
        },
      },
    ],
    [
      `${base}/${digest}/provenance.json`,
      {
        schemaVersion: 1,
        ...identity,
        sourceBlockHeight: "9",
        sourceBlockHash: block,
        evidenceKind: "world-initialized-event",
        transactionHash: transaction,
        eventIndex: 0,
        eventKind: "WorldInitialized",
        requestId: null,
        requester: null,
        verifiedAt: "2026-08-28T01:02:03Z",
      },
    ],
    [
      `${base}/status.json`,
      {
        schemaVersion: 1,
        state: "idle",
        observed: { generation: "0", stateDigest: digest },
        preparing: null,
        published: { generation: "0", stateDigest: digest },
        retry: null,
        errorCode: null,
        heartbeatAt: "2026-08-28T01:02:03Z",
      },
    ],
  ]);
  const metadataMethod = lifeSpec.interfaces[0]!.methods.find(
    (method) => method.name === "get_metadata",
  )!;
  const metadataCodec = resolveCodec(
    metadataMethod.return_type,
    buildNamedCodecs([...lifeSpec.type_defs]),
  );
  const metadataBytes = serializeCxs(
    {
      width: 10_000n,
      height: 10_000n,
      generation: 0n,
      seed: 7n,
      population: 32_768n,
      state_digest: new Uint8Array(32).fill(0xaa),
      chunk_bytes: 1_000n,
      chunks_per_row: 2n,
      max_queue_len: 16n,
    },
    metadataCodec,
  );
  return {
    name: "life-e2e-artifacts",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        if (request.method === "POST" && pathname === "/") {
          const envelope = JSON.parse(await readBody(request)) as {
            readonly id: string | number;
          };
          const body = JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result: {
              output: { result: "return", returnData: hex(metadataBytes) },
              events: [],
              height: "9",
            },
          });
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("content-length", Buffer.byteLength(body));
          response.end(body);
          return;
        }
        const value = json.get(pathname);
        if (value) {
          const body = JSON.stringify(value);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("content-length", Buffer.byteLength(body));
          response.end(body);
          return;
        }
        const tile = pathname.match(
          new RegExp(`^${base}/${digest}/tiles/(\\d)/(\\d+)/(\\d+)\\.bin$`),
        );
        if (!tile) return next();
        const z = Number(tile[1]);
        const bytes = z === 6 ? fixtureCells() : fixtureDensity(z);
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          z === 6
            ? "application/vnd.groundhog.life-cells-v1"
            : "application/vnd.groundhog.life-density-u16le",
        );
        response.setHeader("content-length", bytes.length);
        response.end(bytes);
      });
    },
  };
}
function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
function fixtureDensity(z: number): Buffer {
  const bytes = Buffer.alloc(131072);
  const scale = 2 ** (6 - z);
  const maximum = scale * scale;
  for (let index = 0; index < 65536; index += 1)
    bytes.writeUInt16LE(index % (maximum + 1), index * 2);
  return bytes;
}
function fixtureCells(): Buffer {
  const bytes = Buffer.alloc(8192);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = index % 2 ? 0xaa : 0x55;
  return bytes;
}
