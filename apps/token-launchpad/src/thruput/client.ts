import {
  createThruputClient,
  defineCluster,
  getNetworkInfo,
  hashFromHex,
  HttpTransport,
  toHex0x,
  type ThruputClient,
  type ConnectedThruputClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";

import type { AppConfig } from "@/config";

export function createReadClient(
  config: Pick<AppConfig, "rpcUrl" | "networkIdHex">,
): Promise<ConnectedThruputClient> {
  const target = config.rpcUrl.href;
  const transport = new HttpTransport(target, {
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: 10_000,
  });
  return createThruputClient({
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
  client: Pick<ThruputClient, "getNetworkInfo">,
  expectedNetworkIdHex: string,
): Promise<void> {
  const network = await client.getNetworkInfo();
  if (toHex0x(network.networkHash) !== `0x${expectedNetworkIdHex}`) {
    throw new Error(
      "The RPC network does not match the configured launchpad network.",
    );
  }
}
