import type { ThruputClient } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";

import type { AppConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type TokenMetadata,
} from "@/contracts/erc20-adapter";
import { createSwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { createSwapHandlerReadAdapter } from "@/contracts/handler-adapter";
import { FALLBACK_LIQUIDITY_TOKEN_DECIMALS } from "@/pools/liquidity-token";

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
  liquidityTokenSymbol: string;
  liquidityTokenDecimals: number;
  feeTo: ContractAddress | null;
  chainHeight: bigint;
  readAt: number;
}

export type SnapshotReader = () => Promise<PoolSnapshot>;

export function createSnapshotReader(
  config: AppConfig,
  client: Pick<ThruputClient, "simulateInvocation">,
): SnapshotReader {
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
  const handler = createSwapHandlerReadAdapter({
    client,
    contract: config.handlerAddress,
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
        poolState,
        metadataA,
        metadataB,
        liquidityMetadata,
        balanceA,
        balanceB,
        allowanceA,
        allowanceB,
        liquidityBalance,
        liquidityAllowance,
        feeTo,
        registeredHandler,
        poolAddresses,
      ] = await Promise.all([
        handler.poolState(),
        tokenA.metadata(),
        tokenB.metadata(),
        liquidityToken.metadata(),
        tokenA.balanceOf(config.accountAddress),
        tokenB.balanceOf(config.accountAddress),
        tokenA.allowance(config.accountAddress, config.handlerAddress),
        tokenB.allowance(config.accountAddress, config.handlerAddress),
        liquidityToken.balanceOf(config.accountAddress),
        liquidityToken.allowance(config.accountAddress, config.handlerAddress),
        factory.feeTo(),
        factory.getPair(config.tokenAAddress, config.tokenBAddress),
        factory.poolAddresses(config.tokenAAddress, config.tokenBAddress),
      ]);

      const readHeights = [
        poolState.stateBlockHeight,
        metadataA.name.stateBlockHeight,
        metadataA.symbol.stateBlockHeight,
        metadataA.decimals.stateBlockHeight,
        metadataB.name.stateBlockHeight,
        metadataB.symbol.stateBlockHeight,
        metadataB.decimals.stateBlockHeight,
        liquidityMetadata.name.stateBlockHeight,
        liquidityMetadata.symbol.stateBlockHeight,
        liquidityMetadata.decimals.stateBlockHeight,
        balanceA.stateBlockHeight,
        balanceB.stateBlockHeight,
        allowanceA.stateBlockHeight,
        allowanceB.stateBlockHeight,
        liquidityBalance.stateBlockHeight,
        liquidityAllowance.stateBlockHeight,
        feeTo.stateBlockHeight,
        registeredHandler.stateBlockHeight,
        poolAddresses.stateBlockHeight,
      ];
      const readHeight = readHeights[0]!;
      if (readHeights.some((height) => height !== readHeight)) continue;
      if (
        registeredHandler.value === null ||
        !sameAddress(registeredHandler.value, config.handlerAddress) ||
        !sameAddress(poolAddresses.value.handler, config.handlerAddress) ||
        !sameAddress(poolAddresses.value.driver, config.driverAddress) ||
        !sameAddress(
          poolAddresses.value.liquidityToken,
          config.liquidityTokenAddress,
        ) ||
        !sameAddress(
          poolState.value.liquidityToken,
          config.liquidityTokenAddress,
        )
      ) {
        throw new Error(
          "The factory and handler returned inconsistent pool addresses",
        );
      }
      const liquidityTokenMetadata = metadataValues(liquidityMetadata);

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
        reserve0: poolState.value.reserve0,
        reserve1: poolState.value.reserve1,
        reserveTimestamp: poolState.value.blockTimestamp,
        liquidityTotalSupply: poolState.value.liquidity,
        liquidityBalance: liquidityBalance.value,
        liquidityAllowance: liquidityAllowance.value,
        liquidityTokenSymbol: liquidityTokenMetadata.symbol?.trim() || "LP",
        liquidityTokenDecimals:
          liquidityTokenMetadata.decimals ?? FALLBACK_LIQUIDITY_TOKEN_DECIMALS,
        feeTo: feeTo.value,
        chainHeight: readHeight,
        readAt: Date.now(),
      };
    }
    throw new Error(
      "Unable to read a consistent chain snapshot after three attempts",
    );
  };
}

function sameAddress(left: ContractAddress, right: ContractAddress): boolean {
  return left.every((byte, index) => byte === right[index]);
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
