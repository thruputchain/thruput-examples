import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

export function createReadClient(rpcUrl: URL): GroundhogClient {
  const target =
    typeof window !== "undefined" &&
    isLoopback(window.location.hostname) &&
    isLoopback(rpcUrl.hostname)
      ? new URL("/groundhog-rpc", window.location.origin).href
      : rpcUrl.href;
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

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
