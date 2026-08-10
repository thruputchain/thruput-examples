import {
  createGroundhogClient,
  HttpTransport,
  type ChainTip,
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

export async function getValidatedChainTip(
  client: Pick<GroundhogClient, "getChainTip" | "getBlockByNumber">,
  expectedNetworkId: bigint,
): Promise<ChainTip> {
  const tip = await client.getChainTip();
  const block = await client.getBlockByNumber(tip.height);
  if (block === null) {
    throw new Error(`RPC did not return its tip block at height ${tip.height}`);
  }
  if (block.blockHeight !== tip.height) {
    throw new Error(
      `RPC returned block height ${block.blockHeight} for tip height ${tip.height}`,
    );
  }
  if (block.networkId !== expectedNetworkId) {
    throw new Error(
      `RPC network ID ${block.networkId} does not match configured network ID ${expectedNetworkId}`,
    );
  }
  return tip;
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
