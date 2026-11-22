import { useQuery } from "@tanstack/react-query";
import { useClient, useWallet } from "@thruputchain/react";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import {
  readPool,
  readPoolState,
  type Pool,
  type Reader,
} from "@/contracts/swap";

/** Public views need a caller, not a connected wallet. */
export const READ_ONLY_CALLER = addressFromBase58(toBase58(new Uint8Array(32)));

/** The connected account, or the read-only caller, and a reader for views. */
export function useReader(config: AppConfig): {
  reader: Reader;
  account: ContractAddress;
  connected: boolean;
} {
  const client = useClient();
  const wallet = useWallet();
  const connected = wallet.status === "connected" && wallet.address !== null;
  const account =
    connected && wallet.address
      ? addressFromBase58(wallet.address)
      : READ_ONLY_CALLER;
  return {
    reader: { client, factory: config.factoryAddress, caller: account },
    account,
    connected,
  };
}

export function usePool(
  reader: Reader,
  tokenA: ContractAddress | null,
  tokenB: ContractAddress | null,
) {
  return useQuery({
    queryKey: ["pool", tokenA && toBase58(tokenA), tokenB && toBase58(tokenB)],
    queryFn: () => readPool(reader, tokenA!, tokenB!),
    enabled: tokenA !== null && tokenB !== null,
  });
}

export function usePoolState(reader: Reader, pool: Pool | null | undefined) {
  return useQuery({
    queryKey: [
      "pool-state",
      pool && toBase58(pool.handler),
      toBase58(reader.caller),
    ],
    queryFn: () => readPoolState(reader, pool!),
    enabled: Boolean(pool),
    refetchInterval: 5_000,
  });
}
