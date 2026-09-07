import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { loadSwapAppUrl } from "./src/swap-config.ts";
import { loadExplorerUrl } from "./src/explorer-config.ts";

import {
  createPublicConfigManifest,
  PUBLIC_CONFIG_MANIFEST_FILENAME,
} from "./server/public-config-manifest.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const allowedRpcMethods = new Set([
  "groundhog_networkInfo",
  "groundhog_chainTip",
  "groundhog_getEvents",
  "groundhog_getTransactionReceipt",
  "groundhog_getTransactionStatus",
  "groundhog_sendRawTransaction",
  "groundhog_view",
]);
const maxRpcBodyBytes = 1_000_000;
const maxRpcResponseBytes = 1_000_000;
export const PRODUCTION_BROWSER_RPC_URL = "https://same-origin.invalid/";

export default defineConfig(({ command, isPreview, mode }) => {
  const environment = loadEnv(mode, root, "");
  loadSwapAppUrl(environment.VITE_SWAP_APP_URL);
  loadExplorerUrl(environment.VITE_EXPLORER_URL);
  const rpcTarget =
    environment.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545";
  validateRpcTarget(rpcTarget, {
    command,
    isPreview: isPreview ?? false,
    registryEnabled: environment.VITE_TOKEN_REGISTRY_ENABLED === "true",
  });
  const credentialsEnabled =
    command === "serve" &&
    !(isPreview ?? false) &&
    isLoopback(new URL(rpcTarget).hostname) &&
    environment.GROUNDHOG_DEV_PERSONAS !== undefined;
  const registryProductionBuild =
    command === "build" &&
    mode === "production" &&
    environment.VITE_TOKEN_REGISTRY_ENABLED === "true";

  return {
    envPrefix: [
      "VITE_GROUNDHOG_RPC_URL",
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_GROUNDHOG_WALLET_ENTRYPOINT",
      "VITE_GROUNDHOG_WALLET_ADDRESS",
      "VITE_NATIVE_HOG_ADDRESS",
      "VITE_NATIVE_BALANCE_ITEM_COST",
      "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
      "VITE_STANDARD_TOKEN_HASH",
      "VITE_TOKEN_REGISTRY_ENABLED",
      "VITE_SWAP_APP_URL",
      "VITE_EXPLORER_URL",
    ],
    define: {
      "import.meta.env.GROUNDHOG_DEV_PERSONAS": developmentPersonasDefinition(
        command,
        isPreview ?? false,
        environment,
        rpcTarget,
      ),
      ...(registryProductionBuild
        ? {
            "import.meta.env.VITE_GROUNDHOG_RPC_URL": JSON.stringify(
              PRODUCTION_BROWSER_RPC_URL,
            ),
          }
        : {}),
    },
    plugins: [
      react(),
      tailwindcss(),
      developmentCredentialHostGuard(credentialsEnabled),
      localRpcProxy(rpcTarget),
      ...(registryProductionBuild
        ? [productionPublicConfigManifest(environment)]
        : []),
    ],
    ...(credentialsEnabled
      ? {
          server: {
            cors: false,
            headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
          },
        }
      : {}),
    resolve: { alias: { "@": path.resolve(root, "src") } },
    test: {
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://localhost" } },
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});

export function productionPublicConfigManifest(
  environment: Record<string, string | undefined>,
): Plugin {
  const manifest = createPublicConfigManifest(environment);
  return {
    name: "groundhog-production-public-config-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: PUBLIC_CONFIG_MANIFEST_FILENAME,
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

function developmentCredentialHostGuard(enabled: boolean): Plugin {
  return {
    name: "groundhog-development-credential-host-guard",
    configureServer(server) {
      validateDevelopmentServerHost(server.config.server.host, enabled);
    },
  };
}

export function validateDevelopmentServerHost(
  host: string | boolean | undefined,
  credentialsEnabled: boolean,
): void {
  if (!credentialsEnabled) return;
  const hostname = typeof host === "string" ? host : "localhost";
  if (host === true || !isLoopback(hostname)) {
    throw new Error(
      "Disposable development wallets may only be served from a loopback host",
    );
  }
}

export function developmentPersonasDefinition(
  command: "build" | "serve",
  isPreview: boolean,
  environment: Record<string, string | undefined>,
  rpcTarget = "http://127.0.0.1:9545",
): string {
  if (
    command !== "serve" ||
    isPreview ||
    !isLoopback(new URL(rpcTarget).hostname)
  ) {
    return "undefined";
  }
  return JSON.stringify(environment.GROUNDHOG_DEV_PERSONAS) ?? "undefined";
}

function localRpcProxy(target: string): Plugin {
  const targetUrl = new URL(target);
  const targetIsLoopback = isLoopback(targetUrl.hostname);
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "POST")
      return sendProxyError(response, 405, "POST is required");
    if (!targetIsLoopback)
      return sendProxyError(
        response,
        403,
        "Local RPC proxy target is not loopback",
      );
    if (!isSameOriginLocalRequest(request)) {
      return sendProxyError(
        response,
        403,
        "Local RPC proxy requires a same-origin loopback request",
      );
    }
    if (
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return sendProxyError(response, 415, "application/json is required");
    }
    try {
      const body = await readBody(request);
      const envelope: unknown = JSON.parse(body);
      if (!isAllowedRequest(envelope)) {
        return sendProxyError(
          response,
          403,
          "RPC method is not available through the local proxy",
        );
      }
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        return sendProxyError(response, 502, "Local RPC proxy failed");
      }
      const responseBody = await readUpstreamBody(upstream);
      response.statusCode = upstream.status;
      response.setHeader(
        "content-type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      response.end(responseBody);
    } catch {
      sendProxyError(response, 502, "Local RPC proxy failed");
    }
  };
  return {
    name: "groundhog-local-rpc-proxy",
    configureServer(server) {
      server.middlewares.use("/groundhog-rpc", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/groundhog-rpc", middleware);
    },
  };
}

export async function readUpstreamBody(
  response: Response,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxRpcResponseBytes) {
    throw new Error("RPC response body is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxRpcResponseBytes) {
      await reader.cancel();
      throw new Error("RPC response body is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxRpcBodyBytes)
      throw new Error("RPC request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function isAllowedRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "method" in value &&
    typeof value.method === "string" &&
    allowedRpcMethods.has(value.method)
  );
}

function sendProxyError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: message }));
}

export function isSameOriginLocalRequest(
  request: Pick<IncomingMessage, "headers">,
): boolean {
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    const requestHost = new URL(`http://${host}`);
    if (
      !isLoopback(requestHost.hostname) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return false;
    }
    const origin = request.headers.origin;
    if (origin === undefined) return false;
    const originUrl = new URL(origin);
    return (
      originUrl.protocol === "http:" && originUrl.host === requestHost.host
    );
  } catch {
    return false;
  }
}

export function validateRpcTarget(
  value: string,
  context: {
    command: "build" | "serve";
    isPreview: boolean;
    registryEnabled: boolean;
  } = { command: "serve", isPreview: false, registryEnabled: false },
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_GROUNDHOG_RPC_URL must be a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("VITE_GROUNDHOG_RPC_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      "VITE_GROUNDHOG_RPC_URL must not contain a query string or fragment",
    );
  }
  const productionRegistryBuild =
    context.command === "build" && context.registryEnabled;
  if (
    productionRegistryBuild &&
    (url.protocol === "http:" || url.protocol === "https:")
  ) {
    return;
  }
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new Error(
      "VITE_GROUNDHOG_RPC_URL must target a loopback HTTP server",
    );
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
