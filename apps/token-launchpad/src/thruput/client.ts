import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  toBase58,
  type ThruputClient,
  type ConnectedThruputClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";

import type { AppConfig } from "@/config";

export async function createReadClient(
  config: Pick<AppConfig, "rpcUrl" | "networkId">,
): Promise<ConnectedThruputClient> {
  const target = config.rpcUrl.href;
  const transport = new HttpTransport(target, {
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: 10_000,
  });
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "launchpad",
      rpcUrl: target,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [] as const,
    }),
    transport,
  });
  const request = transport.request.bind(transport);
  transport.request = async (method, params, options) => {
    // Retain network checks for evidence reads after initial connection.
    if (method !== "getNetworkInfo")
      await assertExpectedNetwork(client, config.networkId);
    return request(method, params, options);
  };
  return client;
}

export async function assertExpectedNetwork(
  client: Pick<ThruputClient, "getNetworkInfo">,
  expectedNetworkId: string,
): Promise<void> {
  const network = await client.getNetworkInfo();
  if (toBase58(network.networkHash) !== expectedNetworkId) {
    throw new Error(
      "The RPC network does not match the configured launchpad network.",
    );
  }
}
