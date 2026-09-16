import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { canonicalAddress, type FaucetManifest } from "../src/domain.ts";
import type { ClaimService } from "./claims.ts";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let value = "";
  for await (const chunk of request) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 1_024)
      throw new Error("Request body is too large.");
  }
  return JSON.parse(value);
}

export function faucetServer(
  manifest: FaucetManifest,
  claims: Pick<ClaimService, "claim" | "status">,
  dist: string,
) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/config") {
        json(response, 200, manifest);
      } else if (request.method === "GET" && url.pathname === "/api/claims") {
        let address: string;
        try {
          address = canonicalAddress(url.searchParams.get("address"));
        } catch {
          json(response, 400, { error: "Enter a valid wallet address." });
          return;
        }
        const results = await Promise.all(
          manifest.tokens.map(async (token) => [
            token.address,
            await claims.status(token.address, address),
          ]),
        );
        json(response, 200, Object.fromEntries(results));
      } else if (request.method === "POST" && url.pathname === "/api/claims") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          json(response, 415, { error: "Use application/json." });
          return;
        }
        let token: string;
        let address: string;
        try {
          const input = (await body(request)) as {
            token?: unknown;
            address?: unknown;
          };
          token = canonicalAddress(input.token);
          address = canonicalAddress(input.address);
          if (!manifest.tokens.some((entry) => entry.address === token))
            throw new Error("Unknown token");
        } catch {
          json(response, 400, {
            error: "Choose a faucet token and enter a valid wallet address.",
          });
          return;
        }
        try {
          json(response, 200, await claims.claim(token, address));
        } catch {
          json(response, 503, {
            error:
              "Transfer not yet confirmed. Retry to check the same claim; you will not receive a duplicate transfer.",
          });
        }
      } else if (url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "Not found." });
      } else if (request.method === "GET" || request.method === "HEAD") {
        const root = resolve(dist);
        const path = resolve(
          root,
          `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
        );
        if (!path.startsWith(root + sep)) {
          json(response, 404, { error: "Not found." });
          return;
        }
        const file = await stat(path).catch(() => null);
        if (!file?.isFile()) {
          json(response, 404, { error: "Not found." });
          return;
        }
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
        };
        response.writeHead(200, {
          "Content-Type": types[extname(path)] ?? "application/octet-stream",
        });
        if (request.method === "HEAD") response.end();
        else
          createReadStream(path)
            .on("error", () => response.destroy())
            .pipe(response);
      } else json(response, 405, { error: "Method not allowed." });
    } catch {
      if (!response.headersSent)
        json(response, 500, {
          error: "The faucet is unavailable. Please retry shortly.",
        });
      else response.destroy();
    }
  });
}
