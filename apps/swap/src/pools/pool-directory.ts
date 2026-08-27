import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig, GlobalConfig } from "@/config";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";
import { resolvePoolConfig } from "@/pools/pool-context";
import { createSnapshotReader, type PoolSnapshot } from "@/swap/snapshot";

export interface PoolDirectoryEntry {
  config: AppConfig;
  snapshot: PoolSnapshot;
}

export interface PoolDirectoryResult {
  entries: PoolDirectoryEntry[];
  invalidEntryCount: number;
}

interface DirectoryDependencies {
  loadPool?: (
    token0: ContractAddress,
    token1: ContractAddress,
  ) => Promise<PoolDirectoryEntry>;
}

export async function readPoolDirectory(
  config: GlobalConfig,
  dependencies: DirectoryDependencies = {},
): Promise<PoolDirectoryResult> {
  const client = createReadClient(config);
  const factory = createSwapFactoryReadAdapter({
    client,
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });
  const lengthView = await factory.allPairsLength();
  if (lengthView.value > 100n) {
    throw new Error("The pool registry is too large for this local application");
  }
  const pairs = await Promise.all(
    Array.from({ length: Number(lengthView.value) }, (_, index) =>
      factory.pairAt(BigInt(index))
    ),
  );
  const loadPool = dependencies.loadPool ?? (async (token0, token1) => {
    const poolConfig = await resolvePoolConfig(config, token0, token1);
    return {
      config: poolConfig,
      snapshot: await createSnapshotReader(poolConfig)(),
    };
  });
  const loaded = await Promise.allSettled(
    pairs.map((pair) => {
      if (pair.value === null) {
        return Promise.reject(new Error("Factory returned an empty registry entry"));
      }
      return loadPool(pair.value[0], pair.value[1]);
    }),
  );
  return {
    entries: loaded.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    ),
    invalidEntryCount: loaded.filter(({ status }) => status === "rejected").length,
  };
}
