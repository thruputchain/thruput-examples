import {
  createGroundhogClient,
  defineCluster,
  getNetworkInfo,
  hashFromHex,
  HttpTransport,
  toHex0x,
  type GroundhogClient,
  type ConnectedGroundhogClient,
} from "@groundhogchain/client";
import { networkHash } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";

export function createReadClient(
  config: Pick<AppConfig, "registryEnabled" | "rpcUrl" | "networkIdHex">,
): Promise<ConnectedGroundhogClient> {
  const target = resolveReadRpcUrl(
    config,
    typeof window === "undefined" ? undefined : window.location.origin,
  );
  const transport = new HttpTransport(target, {
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: 10_000,
  });
  return createGroundhogClient({
    cluster: defineCluster({
      name: "launchpad",
      rpcUrl: target,
      networkHash: networkHash(hashFromHex(`0x${config.networkIdHex}`)),
      capabilities: [] as const,
    }),
    transport: {
      async request(method, params, options) {
        // Retain network checks for evidence reads after initial connection.
        if (method !== "groundhog_networkInfo") {
          await assertExpectedNetwork(
            { getNetworkInfo: () => getNetworkInfo(transport) },
            config.networkIdHex,
          );
        }
        return transport.request(method, params, options);
      },
    },
  });
}

export async function assertExpectedNetwork(
  client: Pick<GroundhogClient, "getNetworkInfo">,
  expectedNetworkIdHex: string,
): Promise<void> {
  const network = await client.getNetworkInfo();
  if (toHex0x(network.networkHash) !== `0x${expectedNetworkIdHex}`) {
    throw new Error(
      "The RPC network does not match the configured launchpad network.",
    );
  }
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
