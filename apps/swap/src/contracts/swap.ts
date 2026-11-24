/**
 * Every Thruput call the Swap app makes, in one place.
 *
 * Reads use contract views. Writes are typed `ContractCall`s, sent together in
 * one atomic batch by `src/transactions/use-wallet-transaction.ts`.
 *
 * A swap or liquidity change is a queued request:
 * 1. One transaction approves the exact amount and asks the router to queue
 *    the request. The driver returns a request ID and emits `RequestAccepted`.
 * 2. A later transaction "cranks" the queue: `process_requests` on the driver.
 *    Anyone can crank, and one crank handles many requests.
 * 3. The handler's event (`SwapEvent`, `LiquidityMintEvent`, or
 *    `LiquidityBurnEvent`) or the driver's `RequestFailed` event carries the
 *    request ID, and reports the outcome.
 */
import {
  bytesEqual,
  toBase58,
  type ContractCall,
  type CoreThruputClient,
  type FixedBytes,
  type TransactionReceipt,
} from "@thruputchain/client";
import { gasAmount, type ContractAddress } from "@thruputchain/protocol";

import { ERC20, ERC20Metadata } from "@/contracts/generated/erc20";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { SwapHandler, swap_if } from "@/contracts/generated/swap-handler";
import { SwapRouter } from "@/contracts/generated/swap-router";
import { SwapDriver, batch_driver } from "@/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "@/contracts/driver-target";

const CALL_GAS = gasAmount(10_000_000n);
/** LP tokens the pool locks forever when it is created. */
export const MINIMUM_LIQUIDITY = 1_000n;
const PAGE_SIZE = 12n;

const RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
const RequestFailed = batch_driver.v0_1.events.RequestFailed;
const SwapEvent = swap_if.v0_1.events.SwapEvent;
const MintEvent = swap_if.v0_1.events.LiquidityMintEvent;
const BurnEvent = swap_if.v0_1.events.LiquidityBurnEvent;

export type RequestId = FixedBytes<32>;

export interface Token {
  address: ContractAddress;
  symbol: string;
  name: string;
  decimals: number;
}

export interface PoolAddresses {
  handler: ContractAddress;
  driver: ContractAddress;
  liquidityToken: ContractAddress;
}

export interface Pool extends PoolAddresses {
  token0: Token;
  token1: Token;
  lpToken: Token;
}

export interface PoolState {
  reserves: readonly bigint[];
  totalLiquidity: bigint;
  /** The connected account's balances: token0, token1, then LP tokens. */
  balances: readonly [bigint, bigint, bigint];
}

export interface Reader {
  client: CoreThruputClient;
  factory: ContractAddress;
  caller: ContractAddress;
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Token metadata, with the address as a fallback for a missing symbol. */
export async function readToken(
  { client, caller }: Reader,
  address: ContractAddress,
): Promise<Token> {
  const views = { client, address, caller };
  const [name, symbol, decimals] = await Promise.all([
    ERC20Metadata.v0_1.name.view(views),
    ERC20Metadata.v0_1.symbol.view(views),
    ERC20Metadata.v0_1.decimals.view(views),
  ]);
  const unnamed = tokenByAddress(address);
  const symbolText = symbol.value ?? unnamed.symbol;
  // A token can declare any u32, but amounts here format at most 255 decimals.
  const places = decimals.value ?? 0n;
  if (places > MAX_DECIMALS)
    throw new Error(
      `${symbolText} declares ${places} decimals; this app supports at most ${MAX_DECIMALS}.`,
    );
  return {
    address,
    name: name.value ?? unnamed.name,
    symbol: symbolText,
    decimals: Number(places),
  };
}

/** The most decimals `formatAmount` and `parseAmount` take. */
const MAX_DECIMALS = 255n;

/** A token shown by its address, for one without readable metadata. */
export function tokenByAddress(address: ContractAddress): Token {
  const base58 = toBase58(address);
  return { address, name: base58, symbol: `${base58.slice(0, 4)}…`, decimals: 0 };
}

/** The handler, driver, and LP token addresses for a pair, created or not. */
export async function readPoolAddresses(
  { client, factory, caller }: Reader,
  tokenA: ContractAddress,
  tokenB: ContractAddress,
): Promise<PoolAddresses> {
  const { value } = await SwapFactory.v0_1.poolAddresses.view({
    client,
    address: factory,
    caller,
    args: { tokenA, tokenB },
  });
  return {
    handler: value.handler,
    driver: value.driver,
    liquidityToken: value.liquidity_token,
  };
}

/** The pool for two tokens, or null when the factory has not created it. */
export async function readPool(
  reader: Reader,
  tokenA: ContractAddress,
  tokenB: ContractAddress,
): Promise<Pool | null> {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const { value: handler } = await SwapFactory.v0_1.getPair.view({
    client: reader.client,
    address: reader.factory,
    caller: reader.caller,
    args: { tokenA: token0, tokenB: token1 },
  });
  if (handler === null) return null;
  const addresses = await readPoolAddresses(reader, token0, token1);
  const [first, second, lpToken] = await Promise.all([
    readToken(reader, token0),
    readToken(reader, token1),
    readToken(reader, addresses.liquidityToken),
  ]);
  return { ...addresses, token0: first, token1: second, lpToken };
}

/**
 * One page of pools, newest first. The factory keeps a list of every pair it
 * created, so no indexer is needed: read the count, then one page of
 * `pair_at` views in a single `readViews` request.
 */
export async function readPoolPage(
  reader: Reader,
  page: number,
): Promise<{ total: bigint; pairs: (readonly ContractAddress[])[] }> {
  const { client, factory, caller } = reader;
  const { value: total } = await SwapFactory.v0_1.allPairsLength.view({
    client,
    address: factory,
    caller,
  });
  const end = total - BigInt(page) * PAGE_SIZE;
  const count = end <= 0n ? 0n : end < PAGE_SIZE ? end : PAGE_SIZE;
  if (count === 0n) return { total, pairs: [] };
  const indexes = Array.from({ length: Number(count) }, (_, i) => end - 1n - BigInt(i));
  const { results } = await client.readViews({
    calls: indexes.map((index) =>
      SwapFactory.v0_1.pairAt.viewRequest({
        address: factory,
        caller,
        args: { index },
      }),
    ),
  });
  const pairs = results.flatMap((outcome) =>
    outcome.kind === "return" && outcome.value ? [outcome.value] : [],
  );
  return { total, pairs };
}

export const POOL_PAGE_SIZE = Number(PAGE_SIZE);

/** Reserves, LP supply, and the account's balances, from one snapshot. */
export async function readPoolState(
  { client, caller }: Reader,
  pool: Pool,
): Promise<PoolState> {
  const balance = (token: ContractAddress) =>
    ERC20.v0_1.getBalanceOf.viewRequest({
      address: token,
      caller,
      args: { addr: caller },
    });
  const { results } = await client.readViews({
    calls: [
      SwapHandler.v0_1.poolState.viewRequest({ address: pool.handler, caller }),
      balance(pool.token0.address),
      balance(pool.token1.address),
      balance(pool.liquidityToken),
    ],
  });
  const [state, balance0, balance1, balanceLp] = results.map((outcome) => {
    if (outcome.kind !== "return") throw new Error("The pool could not be read.");
    return outcome.value;
  }) as [
    SwapHandler.v0_1.PoolStateResult,
    bigint,
    bigint,
    bigint,
  ];
  return {
    reserves: state.reserves,
    totalLiquidity: state.liquidity,
    balances: [balance0, balance1, balanceLp],
  };
}

/** How much `spender` may take from `owner`. */
export async function readAllowance(
  { client, caller }: Reader,
  token: ContractAddress,
  spender: ContractAddress,
): Promise<bigint> {
  const { value } = await ERC20.v0_1.allowance.view({
    client,
    address: token,
    caller,
    args: { owner: caller, spender },
  });
  return value;
}

export async function readBalance(
  { client, caller }: Reader,
  token: ContractAddress,
): Promise<bigint> {
  const { value } = await ERC20.v0_1.getBalanceOf.view({
    client,
    address: token,
    caller,
    args: { addr: caller },
  });
  return value;
}

/** How much native token the factory needs for each contract of a new pool. */
export async function readPoolFunding({ client, factory, caller }: Reader) {
  const { value } = await SwapFactory.v0_1.poolFunding.view({
    client,
    address: factory,
    caller,
  });
  return value.recommended;
}

// ── Calls ────────────────────────────────────────────────────────────────

export function approve(
  token: ContractAddress,
  spender: ContractAddress,
  amount: bigint,
): ContractCall {
  return ERC20.v0_1.adjustAllowance.call({
    address: token,
    gasLimit: CALL_GAS,
    args: { spender, difference: amount },
  });
}

export function swapRequest(
  router: ContractAddress,
  args: SwapRouter.v0_1.SwapExactTokensForTokensArgs,
): ContractCall<RequestId> {
  return SwapRouter.v0_1.swapExactTokensForTokens.call({
    address: router,
    gasLimit: CALL_GAS,
    args,
  });
}

export function addLiquidityRequest(
  router: ContractAddress,
  args: SwapRouter.v0_1.AddLiquidityArgs,
): ContractCall<RequestId> {
  return SwapRouter.v0_1.addLiquidity.call({
    address: router,
    gasLimit: CALL_GAS,
    args,
  });
}

export function removeLiquidityRequest(
  router: ContractAddress,
  args: SwapRouter.v0_1.RemoveLiquidityArgs,
): ContractCall<RequestId> {
  return SwapRouter.v0_1.removeLiquidity.call({
    address: router,
    gasLimit: CALL_GAS,
    args,
  });
}

/**
 * Create a pair. The factory deploys three contracts (handler, driver, and LP
 * token), each funded with `funding` native tokens from the caller's
 * allowance. The LP token's code must be deployed in the same transaction.
 */
export function createPair(
  factory: ContractAddress,
  tokenA: ContractAddress,
  tokenB: ContractAddress,
  funding: bigint,
): ContractCall {
  return SwapFactory.v0_1.createPair.call({
    address: factory,
    gasLimit: CALL_GAS,
    args: { tokenA, tokenB, funding },
  });
}

/** Forward queued requests to the handler. Anyone can call it. */
export function crank(driver: ContractAddress): ContractCall {
  return SwapDriver.v0_1.processRequests.call({
    address: driver,
    gasLimit: gasAmount(CRANK_FRAME_GAS),
  });
}

// ── Request outcomes ─────────────────────────────────────────────────────

export type RequestOutcome =
  | { status: "done"; amounts: readonly bigint[] }
  | { status: "failed" };

/** The request ID that the driver accepted in this receipt. */
export function acceptedRequestId(
  receipt: TransactionReceipt,
  driver: ContractAddress,
): RequestId {
  const [accepted] = RequestAccepted.allFromReceipt(receipt, { address: driver });
  if (!accepted) throw new Error("The receipt does not contain a queued request.");
  return accepted.topics.request_id;
}

/**
 * Find a request's outcome in the pool's events, starting at the block that
 * queued it. Returns null while the request is still queued.
 */
export async function findRequestOutcome(
  client: CoreThruputClient,
  pool: Pick<PoolAddresses, "driver" | "handler">,
  requestId: RequestId,
  recipient: ContractAddress,
  fromBlock: bigint,
): Promise<RequestOutcome | null> {
  const query = {
    filters: [
      RequestFailed.filter({
        addresses: [pool.driver],
        topics: { request_id: requestId },
      }),
      SwapEvent.filter({ addresses: [pool.handler], topics: { recipient } }),
      MintEvent.filter({ addresses: [pool.handler], topics: { recipient } }),
      BurnEvent.filter({ addresses: [pool.handler], topics: { recipient } }),
    ],
    start: {
      order: "ascending" as const,
      anchor: { kind: "atHeight" as const, blockHeight: fromBlock },
    },
    limit: 200,
  };
  const matches = (id: RequestId | null) => id !== null && bytesEqual(id, requestId);
  for await (const page of client.iterateEventPages(query)) {
    for (const { event } of page.events) {
      if (RequestFailed.decode(event)) return { status: "failed" };
      const swap = SwapEvent.decode(event);
      if (swap && matches(swap.fields.request_id))
        return { status: "done", amounts: swap.fields.amounts_out };
      const mint = MintEvent.decode(event);
      if (mint && matches(mint.fields.request_id))
        return { status: "done", amounts: [mint.fields.amount_minted] };
      const burn = BurnEvent.decode(event);
      if (burn && matches(burn.fields.request_id))
        return { status: "done", amounts: burn.fields.amounts_redeemed };
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Pools order their tokens by address bytes. */
export function sortTokens(
  tokenA: ContractAddress,
  tokenB: ContractAddress,
): [ContractAddress, ContractAddress] {
  for (let i = 0; i < tokenA.length; i += 1) {
    if (tokenA[i] !== tokenB[i])
      return tokenA[i]! < tokenB[i]! ? [tokenA, tokenB] : [tokenB, tokenA];
  }
  throw new Error("Choose two different tokens.");
}
