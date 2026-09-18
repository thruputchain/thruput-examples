import {
  createGroundhogClient,
  defineCluster,
  hashFromHex,
  HttpTransport,
  NetworkMismatchError as ClientNetworkMismatchError,
  toHex0x,
  type GroundhogClient,
  type ConnectedGroundhogClient,
} from "@groundhogchain/client";
import { networkHash } from "@groundhogchain/protocol";

import type { GlobalConfig } from "@/config";

export function createReadClient(
  config: Pick<GlobalConfig, "rpcUrl">,
  signal?: AbortSignal,
): GroundhogClient {
  return deferClient(
    createGroundhogClient({ transport: readTransport(config, signal) }),
  );
}

export async function createNetworkReadClient(
  config: GlobalConfig,
  signal?: AbortSignal,
): Promise<ConnectedGroundhogClient> {
  try {
    return await createGroundhogClient({
      cluster: defineCluster({
        name: "swap-read",
        rpcUrl: config.rpcUrl.href,
        networkHash: networkHash(hashFromHex(`0x${config.networkIdHex}`)),
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
  client: Pick<GroundhogClient, "getNetworkInfo">,
  config: Pick<GlobalConfig, "networkIdHex">,
): Promise<void> {
  const observed = await client.getNetworkInfo();
  if (toHex0x(observed.networkHash).slice(2) !== config.networkIdHex) {
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

function deferClient(clientPromise: Promise<GroundhogClient>): GroundhogClient {
  return new Proxy({} as GroundhogClient, {
    get(_target, property) {
      if (property === "then") return undefined;
      return (...args: unknown[]) =>
        clientPromise.then((client) => {
          const method = Reflect.get(client, property) as (
            ...values: unknown[]
          ) => unknown;
          return Reflect.apply(method, client, args);
        });
    },
  });
}
