import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

import type { AppConfig } from "@/config";

export function createReadClient(
  config: Pick<AppConfig, "registryEnabled" | "rpcUrl">,
): GroundhogClient {
  const target = resolveReadRpcUrl(
    config,
    typeof window === "undefined" ? undefined : window.location.origin,
  );
  const promise = createGroundhogClient({
    transport: new HttpTransport(target, {
      fetch: (...args) => globalThis.fetch(...args),
      timeoutMs: 10_000,
    }),
  });
  return new Proxy({} as GroundhogClient, {
    get(_target, property) {
      if (property === "then") return undefined;
      return (...args: unknown[]) =>
        promise.then((client) =>
          Reflect.apply(
            Reflect.get(client, property) as (...values: unknown[]) => unknown,
            client,
            args,
          ),
        );
    },
  });
}

export function resolveReadRpcUrl(
  config: Pick<AppConfig, "registryEnabled" | "rpcUrl">,
  browserOrigin?: string,
): string {
  if (browserOrigin === undefined) return config.rpcUrl.href;
  if (config.registryEnabled) {
    return new URL("/groundhog-rpc", browserOrigin).href;
  }
  const browserUrl = new URL(browserOrigin);
  return isLoopback(browserUrl.hostname) && isLoopback(config.rpcUrl.hostname)
    ? new URL("/groundhog-rpc", browserOrigin).href
    : config.rpcUrl.href;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
