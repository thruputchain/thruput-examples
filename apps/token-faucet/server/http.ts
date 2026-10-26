import type { IncomingMessage, ServerResponse } from "node:http";
import { address } from "../shared/config";
import { clientIpKey } from "./ip";
import { ClaimError, publicClaim } from "./store";
import type { Claims } from "./claims";
import type { ServerConfig } from "./config";

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}
export function createApiHandler(config: ServerConfig, claims: Claims) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/healthz") {
      json(response, 200, { ok: true });
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      let ip: string;
      try {
        ip = clientIpKey(request, config.proxySecret, config.ipSalt);
      } catch {
        throw new ClaimError("Use the faucet's public gateway.", 403);
      }
      claims.store.rateLimit(ip);
      if (url.pathname === "/api/config" && request.method === "GET") {
        json(response, 200, claims.publicConfig());
        return true;
      }
      if (url.pathname.startsWith("/api/claims/") && request.method === "GET") {
        const id = url.pathname.slice("/api/claims/".length);
        const claim = ID.test(id) ? claims.store.get(id) : null;
        json(
          response,
          claim ? 200 : 404,
          claim ? publicClaim(claim) : { error: "Claim not found." },
        );
        return true;
      }
      if (url.pathname !== "/api/claims" || request.method !== "POST") {
        json(response, 404, { error: "Not found." });
        return true;
      }
      const site = request.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none")
        throw new ClaimError("Use the faucet page to claim tokens.", 403);
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new ClaimError("Send JSON.", 415);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) throw new ClaimError("Request is too large.", 413);
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ClaimError("Invalid JSON.", 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("id" in body) ||
        typeof body.id !== "string" ||
        !ID.test(body.id) ||
        !("recipient" in body) ||
        typeof body.recipient !== "string" ||
        !("networkId" in body) ||
        body.networkId !== config.publicConfig.networkId ||
        !("anchorHash" in body) ||
        body.anchorHash !== config.publicConfig.anchorHash
      )
        throw new ClaimError(
          "Invalid claim or changed network. Reload the page.",
          400,
        );
      let recipient: string;
      try {
        recipient = address(body.recipient);
      } catch {
        throw new ClaimError("Enter a nonzero base58 wallet address.", 400);
      }
      if (
        recipient === config.publicConfig.faucetAddress ||
        config.publicConfig.tokens.some((t) => t.address === recipient)
      )
        throw new ClaimError(
          "Enter your wallet address, not a faucet or token contract.",
          400,
        );
      json(response, 202, claims.claim(body.id, recipient, ip));
    } catch (error) {
      if (response.destroyed) return true;
      if (error instanceof ClaimError) {
        if (error.status === 429 || error.status === 503)
          response.setHeader("Retry-After", error.retryAfter);
        json(response, error.status, {
          error: error.message,
          retryAfter: error.retryAfter,
        });
      } else
        json(response, 503, {
          error:
            "Faucet is unavailable. Keep your claim ID and check its status.",
        });
    }
    return true;
  };
}
