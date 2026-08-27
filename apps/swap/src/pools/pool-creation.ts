import { addressFromHex, toHex0x, type ContractView } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { GlobalConfig } from "@/config";
import {
  createErc20ReadAdapter,
  type Erc20ReadAdapter,
  type TokenMetadataViews,
} from "@/contracts/erc20-adapter";
import {
  createSwapFactoryReadAdapter,
  type PoolAddresses,
  type SwapFactoryReadAdapter,
} from "@/contracts/factory-adapter";
import { parseAmount } from "@/domain/amount";
import { orderTokens } from "@/domain/tokens";
import { createReadClient } from "@/groundhog/client";

const MINIMUM_LIQUIDITY = 1_000n;
const MAX_COHERENCE_ATTEMPTS = 3;

export interface PoolCreationToken {
  address: ContractAddress;
  addressHex: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  allowance: bigint;
  amount: bigint;
  approvalDifference: bigint;
}

export interface PoolCreationReview {
  token0: PoolCreationToken;
  token1: PoolCreationToken;
  pool: PoolAddresses;
  nativeHogBalance: bigint;
  fixedFundingPerContract: bigint;
  totalFixedFunding: bigint;
  initialLiquidity: bigint;
  readHeight: bigint;
}

export interface PoolCreationInput {
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
}

export class PoolCreationValidationError extends Error {
  constructor(
    public readonly code:
      | "tokenAddress"
      | "identicalTokens"
      | "poolExists"
      | "metadata"
      | "amount"
      | "minimumLiquidity"
      | "tokenBalance"
      | "hogBalance"
      | "staleReads",
    message: string,
  ) {
    super(message);
    this.name = "PoolCreationValidationError";
  }
}

export interface PoolCreationDependencies {
  factory?: SwapFactoryReadAdapter;
  token?: (address: ContractAddress) => Erc20ReadAdapter;
  requiredNativeHog?: bigint;
}

export async function preparePoolCreation(
  config: GlobalConfig,
  input: PoolCreationInput,
  reservedNativeHog = 0n,
  dependencies: PoolCreationDependencies = {},
): Promise<PoolCreationReview> {
  const [inputTokenA, inputTokenB] = parseTokenAddresses(input.tokenA, input.tokenB);
  const ordered = orderTokens(inputTokenA, inputTokenB);
  const token0AmountInput = ordered.inputIndex === 0 ? input.amountA : input.amountB;
  const token1AmountInput = ordered.inputIndex === 0 ? input.amountB : input.amountA;
  const client = createReadClient(config);
  const factory = dependencies.factory ?? createSwapFactoryReadAdapter({
    client,
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });
  const createToken = dependencies.token ?? ((address: ContractAddress) =>
    createErc20ReadAdapter({
      client,
      contract: address,
      caller: config.accountAddress,
    }));
  const token0 = createToken(ordered.token0);
  const token1 = createToken(ordered.token1);
  const nativeHog = createToken(config.nativeHogAddress);

  for (let attempt = 0; attempt < MAX_COHERENCE_ATTEMPTS; attempt += 1) {
    const [registered, predicted, metadata0, metadata1] = await Promise.all([
      factory.getPair(ordered.token0, ordered.token1),
      factory.poolAddresses(ordered.token0, ordered.token1),
      token0.metadata(),
      token1.metadata(),
    ]);
    if (registered.value !== null) {
      throw new PoolCreationValidationError(
        "poolExists",
        "A pool for these tokens already exists",
      );
    }
    const [balance0, balance1, allowance0, allowance1, hogBalance] = await Promise.all([
      token0.balanceOf(config.accountAddress),
      token1.balanceOf(config.accountAddress),
      token0.allowance(config.accountAddress, predicted.value.handler),
      token1.allowance(config.accountAddress, predicted.value.handler),
      nativeHog.balanceOf(config.accountAddress),
    ]);
    const heights = creationReadHeights(
      registered,
      predicted,
      metadata0,
      metadata1,
      balance0,
      balance1,
      allowance0,
      allowance1,
      hogBalance,
    );
    if (heights.some((height) => height !== heights[0])) continue;

    const details0 = tokenDetails(metadata0, ordered.token0);
    const details1 = tokenDetails(metadata1, ordered.token1);
    const amount0 = positiveAmount(token0AmountInput, details0.decimals, details0.symbol);
    const amount1 = positiveAmount(token1AmountInput, details1.decimals, details1.symbol);
    const initialLiquidity = integerSquareRoot(amount0 * amount1);
    if (initialLiquidity <= MINIMUM_LIQUIDITY) {
      throw new PoolCreationValidationError(
        "minimumLiquidity",
        "Initial liquidity must exceed the permanently locked 1,000 LP base units",
      );
    }
    if (balance0.value < amount0 || balance1.value < amount1) {
      throw new PoolCreationValidationError(
        "tokenBalance",
        "The account does not have enough of both tokens for the reviewed deposit",
      );
    }
    const totalFixedFunding = config.poolContractFunding * 4n;
    const requiredNativeHog = dependencies.requiredNativeHog ?? totalFixedFunding;
    const nativeHogHex = toHex0x(config.nativeHogAddress);
    const nativeLiquidity = (details0.addressHex === nativeHogHex ? amount0 : 0n)
      + (details1.addressHex === nativeHogHex ? amount1 : 0n);
    if (
      reservedNativeHog < 0n
      || requiredNativeHog < 0n
      || hogBalance.value < reservedNativeHog + requiredNativeHog + nativeLiquidity
    ) {
      throw new PoolCreationValidationError(
        "hogBalance",
        "The account does not have enough unreserved HOG for the fixed development storage reserve",
      );
    }
    return {
      token0: {
        ...details0,
        balance: balance0.value,
        allowance: allowance0.value,
        amount: amount0,
        approvalDifference: positiveDifference(amount0, allowance0.value),
      },
      token1: {
        ...details1,
        balance: balance1.value,
        allowance: allowance1.value,
        amount: amount1,
        approvalDifference: positiveDifference(amount1, allowance1.value),
      },
      pool: predicted.value,
      nativeHogBalance: hogBalance.value,
      fixedFundingPerContract: config.poolContractFunding,
      totalFixedFunding,
      initialLiquidity,
      readHeight: heights[0]!,
    };
  }
  throw new PoolCreationValidationError(
    "staleReads",
    "Unable to read a coherent creation review after three attempts",
  );
}

export function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new RangeError("Square root input cannot be negative");
  if (value < 2n) return value;
  let current = 1n << (BigInt(value.toString(2).length) + 1n >> 1n);
  for (;;) {
    const next = (current + value / current) >> 1n;
    if (next >= current) return current;
    current = next;
  }
}

function parseTokenAddresses(
  tokenA: string,
  tokenB: string,
): readonly [ContractAddress, ContractAddress] {
  let parsedA: ContractAddress;
  let parsedB: ContractAddress;
  try {
    parsedA = addressFromHex(tokenA);
    parsedB = addressFromHex(tokenB);
  } catch {
    throw new PoolCreationValidationError(
      "tokenAddress",
      "Enter two valid 32-byte token contract addresses",
    );
  }
  if (parsedA.every((byte) => byte === 0) || parsedB.every((byte) => byte === 0)) {
    throw new PoolCreationValidationError("tokenAddress", "Token addresses cannot be zero");
  }
  try {
    orderTokens(parsedA, parsedB);
  } catch {
    throw new PoolCreationValidationError(
      "identicalTokens",
      "Choose two different token contracts",
    );
  }
  return [parsedA, parsedB];
}

function tokenDetails(
  metadata: TokenMetadataViews,
  address: ContractAddress,
): Pick<PoolCreationToken, "address" | "addressHex" | "name" | "symbol" | "decimals"> {
  if (metadata.decimals.value === null) {
    throw new PoolCreationValidationError(
      "metadata",
      "Both tokens must expose their decimal precision",
    );
  }
  const addressHex = toHex0x(address);
  return {
    address,
    addressHex,
    name: metadata.name.value?.trim() || addressHex,
    symbol: metadata.symbol.value?.trim() || `${addressHex.slice(0, 8)}…`,
    decimals: metadata.decimals.value,
  };
}

function positiveAmount(input: string, decimals: number, symbol: string): bigint {
  const parsed = parseAmount(input, decimals);
  if (!parsed.ok || parsed.value === 0n) {
    throw new PoolCreationValidationError(
      "amount",
      `Enter a positive ${symbol} amount within the token's precision`,
    );
  }
  return parsed.value;
}

function positiveDifference(required: bigint, allowance: bigint): bigint {
  return allowance >= required ? 0n : required - allowance;
}

function creationReadHeights(
  registered: ContractView<ContractAddress | null>,
  predicted: ContractView<PoolAddresses>,
  metadata0: TokenMetadataViews,
  metadata1: TokenMetadataViews,
  ...views: readonly ContractView<bigint>[]
): bigint[] {
  return [
    registered.height,
    predicted.height,
    metadata0.name.height,
    metadata0.symbol.height,
    metadata0.decimals.height,
    metadata1.name.height,
    metadata1.symbol.height,
    metadata1.decimals.height,
    ...views.map(({ height }) => height),
  ];
}
