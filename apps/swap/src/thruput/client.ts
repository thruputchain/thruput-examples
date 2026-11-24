import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  type ConnectedThruputClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";

/**
 * A read client pinned to the app's network. The SDK checks the node's
 * network identity when it connects, and rejects a node on another network.
 */
export function createReadClient(
  config: Pick<AppConfig, "rpcUrl" | "networkId">,
): Promise<ConnectedThruputClient> {
  return createThruputClient({
    cluster: defineCluster({
      name: "swap",
      rpcUrl: config.rpcUrl.href,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [] as const,
    }),
    transport: new HttpTransport(config.rpcUrl.href, { timeoutMs: 10_000 }),
  });
}
