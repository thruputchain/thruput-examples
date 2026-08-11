import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

import type { AppConfig } from "@/config";

export function createReadClient(config: AppConfig): GroundhogClient {
  const browserOrigin =
    typeof window === "undefined" ? undefined : window.location.origin;
  return createGroundhogClient(
    new HttpTransport(resolveReadRpcUrl(config.rpcUrl, browserOrigin), {
      fetch: (...args) => globalThis.fetch(...args),
      timeoutMs: 10_000,
    }),
  );
}

export function resolveReadRpcUrl(
  configuredUrl: URL,
  browserOrigin?: string,
): string {
  if (browserOrigin === undefined) return configuredUrl.href;

  const origin = new URL(browserOrigin);
  if (
    origin.origin !== configuredUrl.origin &&
    isLoopback(origin.hostname) &&
    isLoopback(configuredUrl.hostname)
  ) {
    return new URL("/groundhog-rpc", origin).href;
  }
  return configuredUrl.href;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
