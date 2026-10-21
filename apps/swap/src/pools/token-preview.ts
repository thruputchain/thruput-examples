import {
  addressFromBase58,
  type ConnectedThruputClient,
  type CoreThruputClient,
  toBase58,
} from "@thruputchain/client";
import { useQuery, skipToken } from "@tanstack/react-query";
import { getClientQueryKey } from "@thruputchain/react";

import type { GlobalConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import { NetworkMismatchError, verifyReadNetwork } from "@/thruput/client";
import { tokenAddress } from "./creation-presets";

export async function readTokenPreview(
  config: GlobalConfig,
  address: string,
  signal: AbortSignal,
  client: Pick<CoreThruputClient, "simulateInvocation" | "getNetworkInfo">,
): Promise<TokenMetadata> {
  await verifyReadNetwork(client, config);
  signal.throwIfAborted();
  const metadata = await createErc20ReadAdapter({
    client,
    contract: addressFromBase58(address),
    caller: config.accountAddress,
  }).metadata();
  signal.throwIfAborted();
  return {
    name: metadata.name.value,
    symbol: metadata.symbol.value,
    decimals: metadata.decimals.value,
  };
}

type Preview =
  | { status: "pending" }
  | { status: "ready"; metadata: TokenMetadata }
  | { status: "unavailable"; networkMismatch: boolean };

export function useTokenPreview(
  config: GlobalConfig,
  value: string,
  client: ConnectedThruputClient,
) {
  const address = tokenAddress(value);
  const result = useQuery({
    queryKey: [
      ...getClientQueryKey(client),
      "token-preview",
      config.networkId,
      toBase58(config.accountAddress),
      address,
    ],
    queryFn:
      address === null
        ? skipToken
        : ({ signal }) => readTokenPreview(config, address, signal, client),
    retry: false,
  });
  const preview: Preview | null =
    address === null
      ? null
      : result.isError
        ? {
            status: "unavailable",
            networkMismatch: result.error instanceof NetworkMismatchError,
          }
        : result.data
          ? { status: "ready", metadata: result.data }
          : { status: "pending" };
  return {
    preview,
    retry: () => {
      void result.refetch();
    },
  };
}
