import { useState } from "react";
import { toHex0x } from "@groundhogchain/client";
import { getClientQueryKey, useClient } from "@groundhogchain/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@/config";
import type { PoolSnapshot, SnapshotReader } from "./snapshot";

export const SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;

export interface PoolSnapshotState {
  snapshot: PoolSnapshot | null;
  error: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isUserRefreshing: boolean;
  refresh(): void;
}

export function usePoolSnapshot(
  read: SnapshotReader,
  config: AppConfig,
): PoolSnapshotState {
  const client = useClient();
  const queries = useQueryClient();
  const [isUserRefreshing, setUserRefreshing] = useState(false);
  const queryKey = [
    ...getClientQueryKey(client),
    "pool-snapshot",
    {
      addresses: [
        config.accountAddress,
        config.factoryAddress,
        config.handlerAddress,
        config.driverAddress,
        config.liquidityTokenAddress,
        config.tokenAAddress,
        config.tokenBAddress,
      ].map(toHex0x),
      symbols: [config.tokenASymbol, config.tokenBSymbol],
      decimals: [config.tokenADecimals, config.tokenBDecimals],
    },
  ] as const;
  const result = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const snapshot = await read();
      signal.throwIfAborted();
      return snapshot;
    },
    refetchInterval: SNAPSHOT_REFRESH_INTERVAL_MS,
    retry: false,
  });
  return {
    snapshot: result.data ?? null,
    error: result.error
      ? `The configured RPC could not load the pool: ${result.error.message}`
      : null,
    isLoading: result.isPending,
    isRefreshing: result.isFetching && result.data !== undefined,
    isUserRefreshing,
    async refresh() {
      setUserRefreshing(true);
      try {
        await queries.cancelQueries({ queryKey, exact: true });
        await result.refetch();
      } finally {
        setUserRefreshing(false);
      }
    },
  };
}
