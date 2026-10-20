import { addressFromBase58, toBase58 } from "@thruputchain/client";

/** The all-zero address in canonical base58. */
export const ZERO_ADDRESS = toBase58(new Uint8Array(32));

/**
 * Pools order their tokens by address bytes: token0 sorts below token1. Base58
 * text order differs (a leading zero byte shortens the text), so decode first.
 */
export function inCanonicalTokenOrder(token0: string, token1: string): boolean {
  const left = addressFromBase58(token0);
  const right = addressFromBase58(token1);
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference < 0;
  }
  return false;
}

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

export const REGISTRY_SYNC_STATES = [
  "idle",
  "syncing",
  "retrying",
  "integrityFault",
] as const;
export type RegistrySyncState = (typeof REGISTRY_SYNC_STATES)[number];

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
