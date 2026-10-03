import { createGroundhogClient, defineCluster, hashFromHex } from "@groundhogchain/client";
import { networkHash } from "@groundhogchain/protocol";
import type { AppConfig } from "../config";

export function createPublicClient(config: AppConfig, rpcUrl: string) {
  return createGroundhogClient({
    cluster: defineCluster({ name: "counter", rpcUrl, networkHash: networkHash(hashFromHex(config.networkId)), capabilities: [] }),
  });
}
