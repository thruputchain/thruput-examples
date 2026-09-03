import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_RPC_METHODS = new Set([
  "groundhog_chainTip",
  "groundhog_getEvents",
  "groundhog_getTransactionReceipt",
  "groundhog_getTransactionStatus",
  "groundhog_sendRawTransaction",
  "groundhog_view",
]);
const MAX_RPC_BODY_BYTES = 1_000_000;

export default defineConfig(({ command, isPreview, mode }) => {
  const environment = loadEnv(mode, root, "");
  const rpcTarget =
    environment.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545";
  validateRpcTarget(rpcTarget);
  const developmentCredentialsEnabled = command === "serve"
    && !(isPreview ?? false)
    && isLoopback(new URL(rpcTarget).hostname)
    && (environment.GROUNDHOG_DEV_PERSONAS !== undefined
      || environment.GROUNDHOG_DEV_PRIVATE_KEY !== undefined);

  return {
    envPrefix: [
      "VITE_GROUNDHOG_RPC_URL",
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_GROUNDHOG_WALLET_ENTRYPOINT",
      "VITE_GROUNDHOG_WALLET_ADDRESS",
      "VITE_NATIVE_HOG_ADDRESS",
      "VITE_KNOWN_TOKEN_ADDRESSES",
      "VITE_SWAP_FACTORY_ADDRESS",
      "VITE_SWAP_ROUTER_ADDRESS",
    ],
    define: {
      "import.meta.env.GROUNDHOG_DEV_PRIVATE_KEY":
        developmentPrivateKeyDefinition(
          command,
          isPreview ?? false,
          environment,
          rpcTarget,
        ),
      "import.meta.env.GROUNDHOG_DEV_PERSONAS":
        developmentPersonasDefinition(
          command,
          isPreview ?? false,
          environment,
          rpcTarget,
        ),
    },
    plugins: [
      react(),
      tailwindcss(),
      developmentCredentialHostGuard(developmentCredentialsEnabled),
      localRpcProxy(rpcTarget),
    ],
    ...(developmentCredentialsEnabled
      ? {
        server: {
          cors: false,
          headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
        },
      }
      : {}),
    resolve: {
      alias: {
        "@": path.resolve(root, "src"),
      },
    },
    test: {
      environment: "jsdom",
      environmentOptions: {
        jsdom: { url: "http://localhost" },
      },
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});

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

export function developmentPrivateKeyDefinition(
  command: "build" | "serve",
  isPreview: boolean,
  environment: Record<string, string | undefined>,
  rpcTarget = "http://127.0.0.1:9545",
): string {
  if (command !== "serve" || isPreview || !isLoopback(new URL(rpcTarget).hostname)) {
    return "undefined";
  }
  return JSON.stringify(environment.GROUNDHOG_DEV_PRIVATE_KEY) ?? "undefined";
}

export function developmentPersonasDefinition(
  command: "build" | "serve",
  isPreview: boolean,
  environment: Record<string, string | undefined>,
  rpcTarget = "http://127.0.0.1:9545",
): string {
  if (command !== "serve" || isPreview || !isLoopback(new URL(rpcTarget).hostname)) {
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
    if (request.method !== "POST") {
      return sendProxyError(response, 405, "POST is required");
    }
    if (!targetIsLoopback) {
      return sendProxyError(response, 403, "Local RPC proxy target is not loopback");
    }
    if (!isSameOriginLocalRequest(request)) {
      return sendProxyError(response, 403, "Local RPC proxy requires a same-origin loopback request");
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return sendProxyError(response, 415, "application/json is required");
    }

    try {
      const body = await readBody(request);
      const envelope: unknown = JSON.parse(body);
      if (!isAllowedRequest(envelope)) {
        return sendProxyError(response, 403, "RPC method is not available through the local proxy");
      }

      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      response.statusCode = upstream.status;
      response.setHeader(
        "content-type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      response.end(await upstream.text());
    } catch (error) {
      sendProxyError(
        response,
        502,
        error instanceof Error ? error.message : "Local RPC proxy failed",
      );
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_RPC_BODY_BYTES) {
      throw new Error("RPC request body is too large");
    }
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
    ALLOWED_RPC_METHODS.has(value.method)
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

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function isSameOriginLocalRequest(
  request: Pick<IncomingMessage, "headers">,
): boolean {
  const host = request.headers.host;
  if (host === undefined) return false;

  let requestHost: URL;
  try {
    requestHost = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopback(requestHost.hostname)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;

  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:" && originUrl.host === requestHost.host;
  } catch {
    return false;
  }
}

export function validateRpcTarget(value: string): void {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    throw new Error("VITE_GROUNDHOG_RPC_URL must not contain credentials");
  }
}
