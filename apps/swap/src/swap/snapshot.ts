import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import { createSwapPairReadAdapter } from "@/contracts/pair-adapter";
import { createReadClient, getValidatedChainTip } from "@/groundhog/client";

export interface TokenSnapshot {
  address: ContractAddress;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  allowance: bigint;
}

export interface PoolSnapshot {
  tokenA: TokenSnapshot;
  tokenB: TokenSnapshot;
  reserve0: bigint;
  reserve1: bigint;
  reserveTimestamp: bigint;
  chainHeight: bigint;
  readAt: number;
}

export type SnapshotReader = () => Promise<PoolSnapshot>;

export function createSnapshotReader(config: AppConfig): SnapshotReader {
  const client = createReadClient(config);
  const tokenA = createErc20ReadAdapter({
    client,
    contract: config.tokenAAddress,
    caller: config.accountAddress,
  });
  const tokenB = createErc20ReadAdapter({
    client,
    contract: config.tokenBAddress,
    caller: config.accountAddress,
  });
  const pair = createSwapPairReadAdapter({
    client,
    contract: config.pairAddress,
    caller: config.accountAddress,
  });

  return async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startTip = await getValidatedChainTip(client, config.networkId);
      const [
        reserves,
        metadataA,
        metadataB,
        balanceA,
        balanceB,
        allowanceA,
        allowanceB,
      ] = await Promise.all([
        pair.reserves(),
        tokenA.metadata(),
        tokenB.metadata(),
        tokenA.balanceOf(config.accountAddress),
        tokenB.balanceOf(config.accountAddress),
        tokenA.allowance(config.accountAddress, config.handlerAddress),
        tokenB.allowance(config.accountAddress, config.handlerAddress),
      ]);
      const endTip = await getValidatedChainTip(client, config.networkId);
      if (
        startTip.height !== endTip.height ||
        !bytesEqual(startTip.blockHash, endTip.blockHash)
      ) {
        continue;
      }

      const readHeights = [
        reserves.height,
        metadataA.name.height,
        metadataA.symbol.height,
        metadataA.decimals.height,
        metadataB.name.height,
        metadataB.symbol.height,
        metadataB.decimals.height,
        balanceA.height,
        balanceB.height,
        allowanceA.height,
        allowanceB.height,
      ];
      if (readHeights.some((height) => height !== endTip.height)) continue;

      return {
        tokenA: tokenSnapshot({
          address: config.tokenAAddress,
          metadata: metadataValues(metadataA),
          fallbackSymbol: config.tokenASymbol,
          fallbackDecimals: config.tokenDecimals,
          balance: balanceA.value,
          allowance: allowanceA.value,
        }),
        tokenB: tokenSnapshot({
          address: config.tokenBAddress,
          metadata: metadataValues(metadataB),
          fallbackSymbol: config.tokenBSymbol,
          fallbackDecimals: config.tokenDecimals,
          balance: balanceB.value,
          allowance: allowanceB.value,
        }),
        reserve0: reserves.value.reserve0,
        reserve1: reserves.value.reserve1,
        reserveTimestamp: reserves.value.blockTimestamp,
        chainHeight: endTip.height,
        readAt: Date.now(),
      };
    }
    throw new Error("Unable to read a consistent chain snapshot after three attempts");
  };
}

function metadataValues(metadata: {
  name: { value: string | null };
  symbol: { value: string | null };
  decimals: { value: number | null };
}): TokenMetadata {
  return {
    name: metadata.name.value,
    symbol: metadata.symbol.value,
    decimals: metadata.decimals.value,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function tokenSnapshot(params: {
  address: ContractAddress;
  metadata: TokenMetadata;
  fallbackSymbol: string;
  fallbackDecimals: number;
  balance: bigint;
  allowance: bigint;
}): TokenSnapshot {
  const symbol = params.metadata.symbol?.trim();
  const name = params.metadata.name?.trim();
  return {
    address: params.address,
    name: name || symbol || params.fallbackSymbol,
    symbol: symbol || params.fallbackSymbol,
    decimals: params.metadata.decimals ?? params.fallbackDecimals,
    balance: params.balance,
    allowance: params.allowance,
  };
}
