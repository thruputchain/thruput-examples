import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

import type { GlobalConfig } from "@/config";

export function createReadClient(
  config: Pick<GlobalConfig, "rpcUrl">,
  signal?: AbortSignal,
): GroundhogClient {
  const browserOrigin =
    typeof window === "undefined" ||
    import.meta.env.MODE === "local-integration"
      ? undefined
      : window.location.origin;
  return deferClient(
    createGroundhogClient({
      transport: new HttpTransport(
        resolveReadRpcUrl(config.rpcUrl, browserOrigin),
        {
          fetch: (input, init) => {
            const combinedSignal = combineSignals(signal, init?.signal);
            return globalThis.fetch(
              input,
              combinedSignal === undefined
                ? init
                : { ...init, signal: combinedSignal },
            );
          },
          timeoutMs: 10_000,
        },
      ),
    }),
  );
}

function combineSignals(
  lifecycleSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | null | undefined,
): AbortSignal | undefined {
  if (lifecycleSignal === undefined) return requestSignal ?? undefined;
  if (requestSignal === undefined || requestSignal === null) {
    return lifecycleSignal;
  }
  return AbortSignal.any([lifecycleSignal, requestSignal]);
}

function deferClient(clientPromise: Promise<GroundhogClient>): GroundhogClient {
  return new Proxy({} as GroundhogClient, {
    get(_target, property) {
      if (property === "then") return undefined;
      return (...args: unknown[]) =>
        clientPromise.then((client) => {
          const method = Reflect.get(client, property) as (
            ...values: unknown[]
          ) => unknown;
          return Reflect.apply(method, client, args);
        });
    },
  });
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
