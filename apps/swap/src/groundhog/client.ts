import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

import type { GlobalConfig } from "@/config";

export function createReadClient(
  config: Pick<GlobalConfig, "registryEnabled" | "rpcUrl">,
  signal?: AbortSignal,
): GroundhogClient {
  const browserOrigin =
    typeof window === "undefined" ||
    import.meta.env.MODE === "local-integration"
      ? undefined
      : window.location.origin;
  return deferClient(
    createGroundhogClient({
      transport: new HttpTransport(resolveReadRpcUrl(config, browserOrigin), {
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
      }),
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
  config: Pick<GlobalConfig, "registryEnabled" | "rpcUrl">,
  browserOrigin?: string,
): string {
  if (browserOrigin === undefined) return config.rpcUrl.href;

  if (config.registryEnabled) {
    return new URL("/groundhog-rpc", browserOrigin).href;
  }

  const origin = new URL(browserOrigin);
  if (
    origin.origin !== config.rpcUrl.origin &&
    isLoopback(origin.hostname) &&
    isLoopback(config.rpcUrl.hostname)
  ) {
    return new URL("/groundhog-rpc", origin).href;
  }
  return config.rpcUrl.href;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
