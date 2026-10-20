import {
  createThruputClient,
  defineCluster,
  getNetworkInfo,
  hashFromBase58,
  HttpTransport,
  toBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "../config";

export function createPublicClient(config: AppConfig, rpcUrl: string) {
  const transport = new HttpTransport(rpcUrl, { timeoutMs: 5_000 });
  return createThruputClient({
    cluster: defineCluster({
      name: "counter",
      rpcUrl,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [],
    }),
    transport: {
      async request(method, params, options) {
        if (
          method !== "groundhog_networkInfo" &&
          toBase58((await getNetworkInfo(transport)).networkHash) !==
            config.networkId
        )
          throw new Error("The RPC network no longer matches this Counter.");
        return transport.request(method, params, options);
      },
    },
  });
}
