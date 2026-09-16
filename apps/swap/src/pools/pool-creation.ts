import { addressFromHex, bytesEqual, toHex0x, type ContractView, type GroundhogClient } from "@groundhogchain/client";
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
  type PoolFunding,
  type SwapFactoryReadAdapter,
} from "@/contracts/factory-adapter";
import { parseAmount } from "@/domain/amount";
import { orderTokens } from "@/domain/tokens";
import { createNetworkReadClient, NetworkMismatchError, verifyReadNetwork } from "@/groundhog/client";

const MINIMUM_LIQUIDITY = 1_000n;
const MAX_COHERENCE_ATTEMPTS = 3;
const U128_MAX = (1n << 128n) - 1n;

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
  pool: PoolAddresses | null;
  predictedPool?: PoolAddresses;
  nativeHogBalance: bigint;
  nativeHogAllowance: bigint;
  fundingMinimum: bigint;
  fundingPerContract: bigint;
  totalFunding: bigint;
  fundingApprovalDifference: bigint;
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
      | "poolIdentity"
      | "funding"
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
  client?: Pick<GroundhogClient, "view" | "getNetworkInfo">;
  factory?: SwapFactoryReadAdapter;
  token?: (address: ContractAddress) => Erc20ReadAdapter;
  requiredNativeHog?: bigint;
  existingPool?: PoolAddresses;
  predictPool?: boolean;
}

export class PoolCreationNetworkError extends Error {
  constructor(cause: unknown) {
    super("The RPC network could not be verified. Check the connection and retry.", { cause });
    this.name = "PoolCreationNetworkError";
  }
}

export async function preparePoolCreation(
  config: GlobalConfig,
  input: PoolCreationInput,
  reservedNativeHog = 0n,
  dependencies: PoolCreationDependencies = {},
): Promise<PoolCreationReview> {
  const [inputTokenA, inputTokenB] = parseTokenAddresses(input.tokenA, input.tokenB);
  const ordered = orderTokens(inputTokenA, inputTokenB);
  const token0Input = ordered.inputIndex === 0 ? input.amountA : input.amountB;
  const token1Input = ordered.inputIndex === 0 ? input.amountB : input.amountA;
  let client: NonNullable<PoolCreationDependencies["client"]>;
  try {
    client = dependencies.client ?? await createNetworkReadClient(config);
    await verifyReadNetwork(client, config);
  } catch (error) {
    if (error instanceof NetworkMismatchError) throw error;
    throw new PoolCreationNetworkError(error);
  }
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
    const [registered, funding, metadata0, metadata1] = await Promise.all([
      factory.getPair(ordered.token0, ordered.token1),
      factory.poolFunding(),
      token0.metadata(),
      token1.metadata(),
    ]);
    const pool = await resolvePool(factory, ordered.token0, ordered.token1, registered, dependencies.existingPool);
    const predicted = dependencies.predictPool && pool === null
      ? await factory.poolAddresses(ordered.token0, ordered.token1)
      : undefined;
    const handler = pool?.handler ?? predicted?.value.handler;
    const [balance0, balance1, allowance0, allowance1, hogBalance, hogAllowance] =
      await Promise.all([
        token0.balanceOf(config.accountAddress),
        token1.balanceOf(config.accountAddress),
        handler === undefined
          ? emptyView(registered.height)
          : token0.allowance(config.accountAddress, handler),
        handler === undefined
          ? emptyView(registered.height)
          : token1.allowance(config.accountAddress, handler),
        nativeHog.balanceOf(config.accountAddress),
        nativeHog.allowance(config.accountAddress, config.factoryAddress),
      ]);
    const heights = creationReadHeights(
      registered,
      funding,
      metadata0,
      metadata1,
      balance0,
      balance1,
      allowance0,
      allowance1,
      hogBalance,
      hogAllowance,
    );
    if (predicted) heights.push(predicted.height);
    if (heights.some((height) => height !== heights[0])) continue;

    validateFunding(funding.value);
    const totalFunding = checkedTriple(funding.value.recommended);
    const details0 = tokenDetails(metadata0, ordered.token0);
    const details1 = tokenDetails(metadata1, ordered.token1);
    const amount0 = positiveAmount(token0Input, details0.decimals, details0.symbol);
    const amount1 = positiveAmount(token1Input, details1.decimals, details1.symbol);
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
    const requiredNativeHog = dependencies.requiredNativeHog ?? totalFunding;
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
        "The account does not have enough unreserved HOG for pool creation",
      );
    }
    return {
      token0: creationToken(details0, balance0.value, allowance0.value, amount0),
      token1: creationToken(details1, balance1.value, allowance1.value, amount1),
      pool,
      ...(predicted ? { predictedPool: predicted.value } : {}),
      nativeHogBalance: hogBalance.value,
      nativeHogAllowance: hogAllowance.value,
      fundingMinimum: funding.value.min,
      fundingPerContract: funding.value.recommended,
      totalFunding,
      fundingApprovalDifference: positiveDifference(totalFunding, hogAllowance.value),
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

async function resolvePool(
  factory: SwapFactoryReadAdapter,
  token0: ContractAddress,
  token1: ContractAddress,
  registered: ContractView<ContractAddress | null>,
  expected: PoolAddresses | undefined,
): Promise<PoolAddresses | null> {
  if (registered.value === null) {
    if (expected !== undefined) {
      throw new PoolCreationValidationError("poolIdentity", "The created pool is not registered");
    }
    return null;
  }
  if (expected === undefined) {
    throw new PoolCreationValidationError("poolExists", "A pool for these tokens already exists");
  }
  const resolved = await factory.poolAddresses(token0, token1);
  if (
    resolved.height !== registered.height
    || !bytesEqual(registered.value, resolved.value.handler)
    || !samePool(expected, resolved.value)
  ) {
    throw new PoolCreationValidationError("poolIdentity", "The factory returned inconsistent pool addresses");
  }
  return resolved.value;
}

function validateFunding(funding: PoolFunding): void {
  if (funding.min <= 0n || funding.recommended < funding.min) {
    throw new PoolCreationValidationError("funding", "The factory returned an invalid funding policy");
  }
}

function checkedTriple(value: bigint): bigint {
  if (value > U128_MAX / 3n) {
    throw new PoolCreationValidationError("funding", "The factory funding requirement exceeds the native token range");
  }
  return value * 3n;
}

function emptyView(height: bigint): ContractView<bigint> {
  return { value: 0n, height, events: [] };
}

function creationToken(
  details: Pick<PoolCreationToken, "address" | "addressHex" | "name" | "symbol" | "decimals">,
  balance: bigint,
  allowance: bigint,
  amount: bigint,
): PoolCreationToken {
  return {
    ...details,
    balance,
    allowance,
    amount,
    approvalDifference: positiveDifference(amount, allowance),
  };
}

function samePool(left: PoolAddresses, right: PoolAddresses): boolean {
  return bytesEqual(left.liquidityToken, right.liquidityToken)
    && bytesEqual(left.handler, right.handler)
    && bytesEqual(left.driver, right.driver);
}

function parseTokenAddresses(tokenA: string, tokenB: string): readonly [ContractAddress, ContractAddress] {
  let parsedA: ContractAddress;
  let parsedB: ContractAddress;
  try {
    parsedA = addressFromHex(tokenA);
    parsedB = addressFromHex(tokenB);
  } catch {
    throw new PoolCreationValidationError("tokenAddress", "Enter two valid 32-byte token contract addresses");
  }
  if (parsedA.every((byte) => byte === 0) || parsedB.every((byte) => byte === 0)) {
    throw new PoolCreationValidationError("tokenAddress", "Token addresses cannot be zero");
  }
  try {
    orderTokens(parsedA, parsedB);
  } catch {
    throw new PoolCreationValidationError("identicalTokens", "Choose two different token contracts");
  }
  return [parsedA, parsedB];
}

function tokenDetails(
  metadata: TokenMetadataViews,
  address: ContractAddress,
): Pick<PoolCreationToken, "address" | "addressHex" | "name" | "symbol" | "decimals"> {
  if (metadata.decimals.value === null) {
    throw new PoolCreationValidationError("metadata", "Both tokens must expose their decimal precision");
  }
  const addressHex = toHex0x(address);
  return {
    address,
    addressHex,
    name: metadata.name.value?.trim() || addressHex,
    symbol: metadata.symbol.value?.trim() || `${addressHex.slice(0, 8)}...`,
    decimals: metadata.decimals.value,
  };
}

function positiveAmount(input: string, decimals: number, symbol: string): bigint {
  const parsed = parseAmount(input, decimals);
  if (!parsed.ok || parsed.value === 0n) {
    throw new PoolCreationValidationError("amount", `Enter a positive ${symbol} amount within the token's precision`);
  }
  return parsed.value;
}

function positiveDifference(required: bigint, allowance: bigint): bigint {
  return allowance >= required ? 0n : required - allowance;
}

function creationReadHeights(
  registered: ContractView<ContractAddress | null>,
  funding: ContractView<PoolFunding>,
  metadata0: TokenMetadataViews,
  metadata1: TokenMetadataViews,
  ...views: readonly ContractView<bigint>[]
): bigint[] {
  return [
    registered.height,
    funding.height,
    metadata0.name.height,
    metadata0.symbol.height,
    metadata0.decimals.height,
    metadata1.name.height,
    metadata1.symbol.height,
    metadata1.decimals.height,
    ...views.map(({ height }) => height),
  ];
}
