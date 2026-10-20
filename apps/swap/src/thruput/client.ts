import {
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  NetworkMismatchError as ClientNetworkMismatchError,
  toBase58,
  type ThruputClient,
  type ConnectedThruputClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";

import type { GlobalConfig } from "@/config";

export async function createReadClient(
  config: Pick<GlobalConfig, "rpcUrl" | "networkId">,
  signal?: AbortSignal,
): Promise<ConnectedThruputClient> {
  try {
    return await createThruputClient({
      cluster: defineCluster({
        name: "swap-read",
        rpcUrl: config.rpcUrl.href,
        networkHash: networkHash(hashFromBase58(config.networkId)),
        capabilities: [] as const,
      }),
      transport: readTransport(config, signal),
    });
  } catch (error) {
    if (error instanceof ClientNetworkMismatchError)
      throw new NetworkMismatchError();
    throw error;
  }
}

function readTransport(
  config: Pick<GlobalConfig, "rpcUrl">,
  signal?: AbortSignal,
) {
  return new HttpTransport(config.rpcUrl.href, {
    fetch: (input, init) => {
      const combinedSignal = combineSignals(signal, init?.signal);
      return globalThis.fetch(
        input,
        combinedSignal === undefined
          ? init
          : { ...init, signal: combinedSignal },
      );
    },
    timeoutMs: 10_000,
  });
}

export class NetworkMismatchError extends Error {
  constructor() {
    super(
      "The RPC endpoint belongs to a different Thruput network. Check the connection and retry.",
    );
    this.name = "NetworkMismatchError";
  }
}

export async function verifyReadNetwork(
  client: Pick<ThruputClient, "getNetworkInfo">,
  config: Pick<GlobalConfig, "networkId">,
): Promise<void> {
  const observed = await client.getNetworkInfo();
  if (toBase58(observed.networkHash) !== config.networkId) {
    throw new NetworkMismatchError();
  }
}

function combineSignals(
  lifecycleSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | null | undefined,
): AbortSignal | undefined {
  if (lifecycleSignal === undefined) return requestSignal ?? undefined;
  if (requestSignal === undefined || requestSignal === null) {
    return lifecycleSignal;
  }
  return AbortSignal.any([lifecycleSignal, requestSignal]);
}
