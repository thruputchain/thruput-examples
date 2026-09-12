export const REGISTRY_SORTS = ["newest", "oldest", "name", "symbol"] as const;

export type RegistrySort = (typeof REGISTRY_SORTS)[number];

export interface RegistryScope {
  networkId: string;
  factoryAddress: string;
  tokenCodeHash: string;
}

export interface RegistryToken {
  networkId: string;
  factoryAddress: string;
  tokenAddress: string;
  creatorAddress: string;
  administratorAddress: string;
  initialHolderAddress: string;
  initialSupply: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenCodeHash: string;
  transactionHash: string;
  eventSequence: number;
  blockHeight: string;
  indexedAt: string;
}

export interface RegistryScan {
  anchorBlock: string;
  targetBlock: string;
  nextCursor: string | null;
}

export type RegistrySyncState =
  "idle" | "syncing" | "retrying" | "integrityFault";

export interface RegistryStatus {
  networkId: string;
  factoryAddress: string;
  indexedThroughBlock: string;
  tokenCount: number;
  historyLimited: boolean;
  syncState: RegistrySyncState;
  syncing: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
}

export interface TokenQuery {
  tokenAddress?: string;
  q?: string;
  creator?: string;
  sort: RegistrySort;
  limit: number;
  offset: number;
  asOfBlock?: string;
}

export interface TokenQueryResult {
  tokens: RegistryToken[];
  total: number;
  limit: number;
  offset: number;
  asOfBlock: string;
  hasMore: boolean;
  historyLimited: boolean;
}

export interface SyncController {
  requestSync(): void;
}
