import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
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
  liquidityTotalSupply: bigint;
  liquidityBalance: bigint;
  liquidityAllowance: bigint;
  feeTo: ContractAddress | null;
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
  const liquidityToken = createErc20ReadAdapter({
    client,
    contract: config.liquidityTokenAddress,
    caller: config.accountAddress,
  });
  const pair = createSwapPairReadAdapter({
    client,
    contract: config.pairAddress,
    caller: config.accountAddress,
  });
  const factory = createSwapFactoryReadAdapter({
    client,
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });

  return async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [
        reserves,
        metadataA,
        metadataB,
        balanceA,
        balanceB,
        allowanceA,
        allowanceB,
        liquidityTotalSupply,
        liquidityBalance,
        liquidityAllowance,
        feeTo,
      ] = await Promise.all([
        pair.reserves(),
        tokenA.metadata(),
        tokenB.metadata(),
        tokenA.balanceOf(config.accountAddress),
        tokenB.balanceOf(config.accountAddress),
        tokenA.allowance(config.accountAddress, config.handlerAddress),
        tokenB.allowance(config.accountAddress, config.handlerAddress),
        pair.liquidity(),
        liquidityToken.balanceOf(config.accountAddress),
        liquidityToken.allowance(config.accountAddress, config.handlerAddress),
        factory.feeTo(),
      ]);

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
        liquidityTotalSupply.height,
        liquidityBalance.height,
        liquidityAllowance.height,
        feeTo.height,
      ];
      const readHeight = readHeights[0]!;
      if (readHeights.some((height) => height !== readHeight)) continue;

      return {
        tokenA: tokenSnapshot({
          address: config.tokenAAddress,
          metadata: metadataValues(metadataA),
          fallbackSymbol: config.tokenASymbol,
          fallbackDecimals: config.tokenADecimals,
          balance: balanceA.value,
          allowance: allowanceA.value,
        }),
        tokenB: tokenSnapshot({
          address: config.tokenBAddress,
          metadata: metadataValues(metadataB),
          fallbackSymbol: config.tokenBSymbol,
          fallbackDecimals: config.tokenBDecimals,
          balance: balanceB.value,
          allowance: allowanceB.value,
        }),
        reserve0: reserves.value.reserve0,
        reserve1: reserves.value.reserve1,
        reserveTimestamp: reserves.value.blockTimestamp,
        liquidityTotalSupply: liquidityTotalSupply.value,
        liquidityBalance: liquidityBalance.value,
        liquidityAllowance: liquidityAllowance.value,
        feeTo: feeTo.value,
        chainHeight: readHeight,
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
