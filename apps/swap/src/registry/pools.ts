import {
  addressFromHex,
  toHex0x,
  type CoreGroundhogClient,
} from "@groundhogchain/client";

import type { GlobalConfig } from "@/config";
import type { PoolDirectoryEntry } from "@/pools/pool-directory";
import { resolvePoolConfig } from "@/pools/pool-context";
import type { RegistryPool } from "@/registry/client";
import { createReadClient } from "@/groundhog/client";
import { createSnapshotReader } from "@/swap/snapshot";

export interface RegistryPoolEntry {
  record: RegistryPool;
  live: PoolDirectoryEntry | null;
  loading: boolean;
  readError: boolean;
}

type PoolReader = (
  config: GlobalConfig,
  pool: RegistryPool,
  signal?: AbortSignal,
) => Promise<PoolDirectoryEntry>;

export function registryPoolsToEntries(
  pools: readonly RegistryPool[],
): RegistryPoolEntry[] {
  return pools.map((record) => ({
    record,
    live: null,
    loading: true,
    readError: false,
  }));
}

export async function enrichRegistryPools(
  config: GlobalConfig,
  entries: readonly RegistryPoolEntry[],
  signal?: AbortSignal,
  readPool?: PoolReader,
  client?: Pick<CoreGroundhogClient, "view">,
): Promise<RegistryPoolEntry[]> {
  const enriched: RegistryPoolEntry[] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    throwIfAborted(signal);
    enriched.push(
      ...(await Promise.all(
        entries.slice(offset, offset + 4).map(async (entry) => {
          try {
            const live = await (readPool
              ? readPool(config, entry.record, signal)
              : defaultPoolReader(config, entry.record, signal, client));
            throwIfAborted(signal);
            if (
              toHex0x(live.config.liquidityTokenAddress) !==
                entry.record.liquidityTokenAddress ||
              toHex0x(live.config.handlerAddress) !==
                entry.record.handlerAddress ||
              toHex0x(live.config.driverAddress) !== entry.record.driverAddress
            )
              throw new Error(
                "Registry pool identity does not match factory state",
              );
            return { ...entry, live, loading: false };
          } catch (error) {
            if (signal?.aborted) throw error;
            return { ...entry, loading: false, readError: true };
          }
        }),
      )),
    );
  }
  return enriched;
}

async function defaultPoolReader(
  config: GlobalConfig,
  pool: RegistryPool,
  signal?: AbortSignal,
  suppliedClient?: Pick<CoreGroundhogClient, "view">,
): Promise<PoolDirectoryEntry> {
  const client = suppliedClient ?? createReadClient(config, signal);
  const poolConfig = await resolvePoolConfig(
    config,
    addressFromHex(pool.token0Address),
    addressFromHex(pool.token1Address),
    undefined,
    client,
  );
  return {
    config: poolConfig,
    snapshot: await createSnapshotReader(poolConfig, client)(),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}
