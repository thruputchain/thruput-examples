import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ValidationError } from "./validation.ts";

export const DEFAULT_RPC_REQUESTS_PER_MINUTE = 2_000;
export const DEFAULT_MAXIMUM_RATE_LIMIT_CLIENTS = 10_000;

interface RateLimitWindow {
  windowStartedAt: number;
  requests: number;
}

export class RpcRateLimiter {
  readonly #maximum: number;
  readonly #maximumClients: number;
  readonly #now: () => number;
  readonly #clients = new Map<string, RateLimitWindow>();
  #overflow: RateLimitWindow | null = null;

  constructor(
    maximum = DEFAULT_RPC_REQUESTS_PER_MINUTE,
    maximumClients = DEFAULT_MAXIMUM_RATE_LIMIT_CLIENTS,
    now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("RPC rate limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maximumClients) || maximumClients < 1) {
      throw new Error("RPC rate-limit client bound must be positive");
    }
    this.#maximum = maximum;
    this.#maximumClients = maximumClients;
    this.#now = now;
  }

  get trackedClientCount(): number {
    return this.#clients.size;
  }

  allow(client: string): boolean {
    const now = this.#now();
    this.#prune(now);
    let window = this.#clients.get(client);
    if (window === undefined) {
      if (this.#clients.size >= this.#maximumClients) {
        this.#overflow = currentWindow(this.#overflow, now);
        return consumeWindow(this.#overflow, this.#maximum);
      }
      window = { windowStartedAt: now, requests: 0 };
      this.#clients.set(client, window);
    }
    return consumeWindow(window, this.#maximum);
  }

  #prune(now: number): void {
    for (const [client, window] of this.#clients) {
      if (now - window.windowStartedAt < 60_000) break;
      this.#clients.delete(client);
    }
    if (
      this.#overflow !== null &&
      now - this.#overflow.windowStartedAt >= 60_000
    ) {
      this.#overflow = null;
    }
  }
}

function currentWindow(
  window: RateLimitWindow | null,
  now: number,
): RateLimitWindow {
  return window === null || now - window.windowStartedAt >= 60_000
    ? { windowStartedAt: now, requests: 0 }
    : window;
}

function consumeWindow(window: RateLimitWindow, maximum: number): boolean {
  if (window.requests >= maximum) return false;
  window.requests += 1;
  return true;
}

export function rpcClientIdentity(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxy: boolean,
): string {
  if (!trustedProxy) return request.socket.remoteAddress ?? "unknown";
  const value = request.headers["x-real-ip"];
  if (typeof value !== "string" || isIP(value) === 0) {
    throw new ValidationError("X-Real-IP must contain one valid IP address");
  }
  return value;
}
