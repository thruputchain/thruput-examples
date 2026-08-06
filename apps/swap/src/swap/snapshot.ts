import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import { createSwapPairReadAdapter } from "@/contracts/pair-adapter";
import { createReadClient } from "@/groundhog/client";

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
    const [
      tip,
      reserves,
      metadataA,
      metadataB,
      balanceA,
      balanceB,
      allowanceA,
      allowanceB,
    ] = await Promise.all([
      client.getChainTip(),
      pair.reserves(),
      tokenA.metadata(),
      tokenB.metadata(),
      tokenA.balanceOf(config.accountAddress),
      tokenB.balanceOf(config.accountAddress),
      tokenA.allowance(config.accountAddress, config.handlerAddress),
      tokenB.allowance(config.accountAddress, config.handlerAddress),
    ]);

    return {
      tokenA: tokenSnapshot({
        address: config.tokenAAddress,
        metadata: metadataA,
        fallbackSymbol: config.tokenASymbol,
        fallbackDecimals: config.tokenDecimals,
        balance: balanceA,
        allowance: allowanceA,
      }),
      tokenB: tokenSnapshot({
        address: config.tokenBAddress,
        metadata: metadataB,
        fallbackSymbol: config.tokenBSymbol,
        fallbackDecimals: config.tokenDecimals,
        balance: balanceB,
        allowance: allowanceB,
      }),
      reserve0: reserves.reserve0,
      reserve1: reserves.reserve1,
      reserveTimestamp: reserves.blockTimestamp,
      chainHeight: tip.height,
      readAt: Date.now(),
    };
  };
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
