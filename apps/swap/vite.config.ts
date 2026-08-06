import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const READ_METHODS = new Set(["groundhog_chainTip", "groundhog_view"]);
const MAX_RPC_BODY_BYTES = 1_000_000;

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, "");
  const rpcTarget =
    environment.VITE_GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545";

  return {
    envPrefix: [
      "VITE_GROUNDHOG_RPC_URL",
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_GROUNDHOG_WALLET_ADDRESS",
      "VITE_SWAP_ROUTER_ADDRESS",
      "VITE_SWAP_PAIR_ADDRESS",
      "VITE_SWAP_HANDLER_ADDRESS",
      "VITE_SWAP_DRIVER_ADDRESS",
      "VITE_TOKEN_A_ADDRESS",
      "VITE_TOKEN_B_ADDRESS",
      "VITE_TOKEN_A_SYMBOL",
      "VITE_TOKEN_B_SYMBOL",
      "VITE_TOKEN_DECIMALS",
    ],
    plugins: [react(), tailwindcss(), readOnlyRpcProxy(rpcTarget)],
    resolve: {
      alias: {
        "@": path.resolve(root, "src"),
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});

function readOnlyRpcProxy(target: string): Plugin {
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

    try {
      const body = await readBody(request);
      const envelope: unknown = JSON.parse(body);
      if (!isReadRequest(envelope)) {
        return sendProxyError(response, 403, "RPC method is not available through the read proxy");
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
    name: "groundhog-read-only-rpc-proxy",
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

function isReadRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "method" in value &&
    typeof value.method === "string" &&
    READ_METHODS.has(value.method)
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
