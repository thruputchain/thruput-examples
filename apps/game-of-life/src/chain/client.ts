import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";
import type { AppConfig } from "@/config";

export function createReadClient(
  config: Pick<AppConfig, "rpcUrl" | "rpcProxyPath">,
): GroundhogClient {
  const browser = typeof window === "undefined" ? undefined : window.location;
  const url = browser
    ? new URL(config.rpcProxyPath, browser.origin).href
    : config.rpcUrl.href;
  const promise = createGroundhogClient({
    transport: new HttpTransport(url, {
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
