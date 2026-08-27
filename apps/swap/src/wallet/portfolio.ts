import { toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { GlobalConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import {
  createSwapFactoryReadAdapter,
  type PoolAddresses,
  type SwapFactoryReadAdapter,
} from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";

export interface PortfolioToken {
  kind: "token";
  address: ContractAddress;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

export interface PortfolioLiquidityPosition {
  kind: "liquidity";
  address: ContractAddress;
  symbol: string;
  decimals: number;
  balance: bigint;
  poolSymbols: readonly [string, string];
}

export interface WalletPortfolio {
  tokens: PortfolioToken[];
  liquidityPositions: PortfolioLiquidityPosition[];
  invalidPoolCount: number;
  unavailableAssetCount: number;
  readAt: number;
}

export type WalletPortfolioReader = () => Promise<WalletPortfolio>;

interface PoolDefinition {
  token0: ContractAddress;
  token1: ContractAddress;
  addresses: PoolAddresses;
}

type AssetDefinition =
  | {
      kind: "token";
      address: ContractAddress;
      fallbackSymbol?: string;
      fallbackDecimals?: number;
      skipMetadata?: boolean;
    }
  | {
      kind: "liquidity";
      address: ContractAddress;
      poolTokens: readonly [ContractAddress, ContractAddress];
    };

interface ReadAsset {
  definition: AssetDefinition;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  balance: bigint;
}

export function createWalletPortfolioReader(
  config: GlobalConfig,
): WalletPortfolioReader {
  const client = createReadClient(config);
  const factory = createSwapFactoryReadAdapter({
    client,
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });

  return async () => {
    const { pools, invalidPoolCount } = await discoverPools(factory);
    const definitions = assetDefinitions(config.nativeHogAddress, pools);
    const assetResults = await Promise.allSettled(
      definitions.map(async (definition): Promise<ReadAsset> => {
        const token = createErc20ReadAdapter({
          client,
          contract: definition.address,
          caller: config.accountAddress,
        });
        const [metadata, balance] = await Promise.all([
          definition.kind === "token" && definition.skipMetadata
            ? null
            : token.metadata(),
          token.balanceOf(config.accountAddress),
        ]);
        const asset = {
          definition,
          name: metadata?.name.value ?? null,
          symbol: metadata?.symbol.value ?? null,
          decimals: metadata?.decimals.value ?? null,
          balance: balance.value,
        };
        if (definition.kind === "token" && asset.balance > 0n) {
          requiredDecimals(
            asset.decimals ?? definition.fallbackDecimals ?? null,
            definition.address,
          );
        }
        return asset;
      }),
    );
    const assets = assetResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (assets.length === 0) {
      const failure = assetResults.find(({ status }) => status === "rejected");
      throw failure?.status === "rejected"
        ? failure.reason
        : new Error("No known wallet assets could be read");
    }
    const regularAssets = new Map(
      assets
        .filter((asset) => asset.definition.kind === "token")
        .map((asset) => [addressKey(asset.definition.address), asset]),
    );

    return {
      tokens: assets
        .flatMap((asset) => {
          if (asset.definition.kind !== "token" || asset.balance === 0n)
            return [];
          const decimals = requiredDecimals(
            asset.decimals ?? asset.definition.fallbackDecimals ?? null,
            asset.definition.address,
          );
          const symbol = displaySymbol(
            asset.symbol,
            asset.definition.fallbackSymbol,
            asset.definition.address,
          );
          return [
            {
              kind: "token" as const,
              address: asset.definition.address,
              name: asset.name?.trim() || symbol,
              symbol,
              decimals,
              balance: asset.balance,
            },
          ];
        })
        .sort(compareSymbols),
      liquidityPositions: assets
        .flatMap((asset) => {
          if (asset.definition.kind !== "liquidity" || asset.balance === 0n)
            return [];
          const [token0, token1] = asset.definition.poolTokens.map(
            (address) => {
              const regular = regularAssets.get(addressKey(address));
              const fallback =
                regular?.definition.kind === "token"
                  ? regular.definition.fallbackSymbol
                  : undefined;
              return displaySymbol(regular?.symbol ?? null, fallback, address);
            },
          );
          return [
            {
              kind: "liquidity" as const,
              address: asset.definition.address,
              symbol: asset.symbol?.trim() || "LP",
              decimals: asset.decimals ?? 0,
              balance: asset.balance,
              poolSymbols: [token0, token1] as const,
            },
          ];
        })
        .sort((left, right) =>
          left.poolSymbols.join("/").localeCompare(right.poolSymbols.join("/")),
        ),
      invalidPoolCount,
      unavailableAssetCount: assetResults.filter(
        ({ status }) => status === "rejected",
      ).length,
      readAt: Date.now(),
    };
  };
}

async function discoverPools(factory: SwapFactoryReadAdapter): Promise<{
  pools: PoolDefinition[];
  invalidPoolCount: number;
}> {
  const length = await factory.allPairsLength();
  if (length.value > 100n) {
    throw new Error(
      "The pool registry is too large for this local application",
    );
  }
  const pairResults = await Promise.allSettled(
    Array.from({ length: Number(length.value) }, (_, index) =>
      factory.pairAt(BigInt(index)),
    ),
  );
  let invalidPoolCount = pairResults.filter(
    (result) => result.status === "rejected" || result.value.value === null,
  ).length;
  const pools = await Promise.allSettled(
    pairResults.flatMap((result) => {
      if (result.status === "rejected" || result.value.value === null)
        return [];
      const [token0, token1] = result.value.value;
      return [loadPool(factory, token0, token1)];
    }),
  );
  invalidPoolCount += pools.filter(
    ({ status }) => status === "rejected",
  ).length;
  return {
    pools: pools.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
    invalidPoolCount,
  };
}

async function loadPool(
  factory: SwapFactoryReadAdapter,
  token0: ContractAddress,
  token1: ContractAddress,
): Promise<PoolDefinition> {
  const [registered, addresses] = await Promise.all([
    factory.getPair(token0, token1),
    factory.poolAddresses(token0, token1),
  ]);
  if (
    registered.value === null ||
    addressKey(registered.value) !== addressKey(addresses.value.pair)
  ) {
    throw new Error("The factory returned inconsistent pool addresses");
  }
  return { token0, token1, addresses: addresses.value };
}

function assetDefinitions(
  nativeHogAddress: ContractAddress,
  pools: readonly PoolDefinition[],
): AssetDefinition[] {
  const definitions = new Map<string, AssetDefinition>();
  const add = (definition: AssetDefinition) => {
    const key = addressKey(definition.address);
    if (!definitions.has(key)) definitions.set(key, definition);
  };
  add({
    kind: "token",
    address: nativeHogAddress,
    fallbackSymbol: "HOG",
    fallbackDecimals: 0,
    skipMetadata: true,
  });
  for (const pool of pools) {
    add({ kind: "token", address: pool.token0 });
    add({ kind: "token", address: pool.token1 });
    add({
      kind: "liquidity",
      address: pool.addresses.liquidityToken,
      poolTokens: [pool.token0, pool.token1],
    });
  }
  return [...definitions.values()];
}

function displaySymbol(
  symbol: string | null,
  fallback: string | undefined,
  address: ContractAddress,
): string {
  return symbol?.trim() || fallback || `${addressKey(address).slice(0, 8)}...`;
}

function requiredDecimals(
  decimals: number | null,
  address: ContractAddress,
): number {
  if (decimals !== null) return decimals;
  throw new Error(`Token decimals are unavailable for ${addressKey(address)}`);
}

function compareSymbols(left: PortfolioToken, right: PortfolioToken): number {
  return left.symbol.localeCompare(right.symbol);
}

function addressKey(address: ContractAddress): string {
  return toHex0x(address);
}
