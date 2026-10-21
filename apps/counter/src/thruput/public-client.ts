import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  toBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "../config";

export async function createPublicClient(config: AppConfig, rpcUrl: string) {
  const transport = new HttpTransport(rpcUrl, { timeoutMs: 5_000 });
  const client = await createThruputClient({
    cluster: defineCluster({
      name: "counter",
      rpcUrl,
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [],
    }),
    transport,
  });
  const request = transport.request.bind(transport);
  transport.request = async (method, params, options) => {
    if (
      method !== "getNetworkInfo" &&
      toBase58((await client.getNetworkInfo({}, options)).networkHash) !==
        config.networkId
    )
      throw new Error("The RPC network no longer matches this Counter.");
    return request(method, params, options);
  };
  return client;
}
