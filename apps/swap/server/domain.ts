export const REGISTRY_SORTS = ["newest", "oldest", "token0", "token1"] as const;

export type RegistrySort = (typeof REGISTRY_SORTS)[number];

export interface RegistryScope {
  networkId: string;
  factoryAddress: string;
}

export interface RegistryPool extends RegistryScope {
  token0Address: string;
  token1Address: string;
  liquidityTokenAddress: string;
  handlerAddress: string;
  driverAddress: string;
  pairCount: string;
  transactionHash: string;
  eventSequence: string;
  createdBlock: string;
  indexedAt: string;
}

export interface RegistryScan {
  anchorBlock: string;
  targetBlock: string;
  nextCursor: string | null;
}

export type RegistrySyncState =
  "idle" | "syncing" | "retrying" | "integrityFault";

export interface RegistryStatus extends RegistryScope {
  indexedThroughBlock: string;
  poolCount: number;
  historyLimited: boolean;
  syncState: RegistrySyncState;
  syncing: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
}

export interface PoolQuery {
  q?: string;
  token?: string;
  sort: RegistrySort;
  limit: number;
  offset: number;
  asOfBlock?: string;
}

export interface PoolQueryResult extends RegistryScope {
  pools: RegistryPool[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  asOfBlock: string;
  historyLimited: boolean;
}

export interface CommitPageOptions {
  retentionGap?: boolean;
}

export interface SyncController {
  requestSync(): void;
}
