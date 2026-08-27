import { parseAmount } from "@/domain/amount";
import { availableBalance } from "@/domain/reservations";
import type { PoolSnapshot } from "@/swap/snapshot";

const BPS_SCALE = 10_000n;

export type LiquidityTokenIndex = 0 | 1;

export type AddLiquidityQuote =
  | {
      ok: true;
      amountsDesired: readonly [bigint, bigint];
      amountsMin: readonly [bigint, bigint];
      estimatedLiquidity: bigint;
      approvalDifferences: readonly [bigint, bigint];
    }
  | {
      ok: false;
      error: "balance";
      amountsDesired: readonly [bigint, bigint];
      insufficientTokenIndexes: readonly LiquidityTokenIndex[];
    }
  | { ok: false; error: Exclude<LiquidityQuoteError, "balance"> };

export type RemoveLiquidityQuote =
  | {
      ok: true;
      liquidity: bigint;
      amountsEstimated: readonly [bigint, bigint];
      amountsMin: readonly [bigint, bigint];
      approvalDifference: bigint;
    }
  | { ok: false; error: LiquidityQuoteError };

export type LiquidityQuoteError =
  | "amount"
  | "balance"
  | "emptyLiquidity"
  | "feeEnabled"
  | "minimum"
  | "slippage";

export function deriveAddLiquidityQuote(
  snapshot: PoolSnapshot,
  inputIndex: LiquidityTokenIndex,
  input: string,
  slippageBps: bigint,
  reservedBalances: readonly [bigint, bigint] = [0n, 0n],
  reservedAllowances: readonly [bigint, bigint] = reservedBalances,
): AddLiquidityQuote {
  if (snapshot.feeTo !== null) return { ok: false, error: "feeEnabled" };
  if (
    snapshot.reserve0 <= 0n
    || snapshot.reserve1 <= 0n
    || snapshot.liquidityTotalSupply <= 0n
  ) return { ok: false, error: "emptyLiquidity" };
  if (slippageBps <= 0n || slippageBps > 5_000n) {
    return { ok: false, error: "slippage" };
  }
  const token = inputIndex === 0 ? snapshot.tokenA : snapshot.tokenB;
  const parsed = parseAmount(input, token.decimals);
  if (!parsed.ok || parsed.value <= 0n) return { ok: false, error: "amount" };

  const counterpart = inputIndex === 0
    ? quoteProportional(parsed.value, snapshot.reserve0, snapshot.reserve1)
    : quoteProportional(parsed.value, snapshot.reserve1, snapshot.reserve0);
  if (counterpart <= 0n) return { ok: false, error: "minimum" };
  const amountsDesired: readonly [bigint, bigint] = inputIndex === 0
    ? [parsed.value, counterpart]
    : [counterpart, parsed.value];
  const balances: readonly [bigint, bigint] = [
    snapshot.tokenA.balance,
    snapshot.tokenB.balance,
  ];
  const insufficientTokenIndexes = amountsDesired.flatMap((amount, index) =>
    amount > availableBalance(balances[index]!, reservedBalances[index]!)
      ? [index as LiquidityTokenIndex]
      : []
  );
  if (insufficientTokenIndexes.length > 0) {
    return {
      ok: false,
      error: "balance",
      amountsDesired,
      insufficientTokenIndexes,
    };
  }

  const amountsMin = amountsDesired.map((amount) =>
    amount * (BPS_SCALE - slippageBps) / BPS_SCALE
  ) as unknown as readonly [bigint, bigint];
  if (amountsMin.some((amount) => amount <= 0n)) {
    return { ok: false, error: "minimum" };
  }
  const estimatedLiquidity = min(
    amountsDesired[0] * snapshot.liquidityTotalSupply / snapshot.reserve0,
    amountsDesired[1] * snapshot.liquidityTotalSupply / snapshot.reserve1,
  );
  if (estimatedLiquidity <= 0n) return { ok: false, error: "minimum" };
  const allowances: readonly [bigint, bigint] = [
    snapshot.tokenA.allowance,
    snapshot.tokenB.allowance,
  ];
  return {
    ok: true,
    amountsDesired,
    amountsMin,
    estimatedLiquidity,
    approvalDifferences: amountsDesired.map((amount, index) =>
      positiveDifference(amount + reservedAllowances[index]!, allowances[index]!)
    ) as unknown as readonly [bigint, bigint],
  };
}

export function deriveRemoveLiquidityQuote(
  snapshot: PoolSnapshot,
  input: string,
  slippageBps: bigint,
  reservedLiquidity = 0n,
  reservedAllowance = reservedLiquidity,
): RemoveLiquidityQuote {
  if (snapshot.feeTo !== null) return { ok: false, error: "feeEnabled" };
  if (
    snapshot.reserve0 <= 0n
    || snapshot.reserve1 <= 0n
    || snapshot.liquidityTotalSupply <= 0n
  ) return { ok: false, error: "emptyLiquidity" };
  if (slippageBps <= 0n || slippageBps > 5_000n) {
    return { ok: false, error: "slippage" };
  }
  const parsed = parseAmount(input, snapshot.liquidityTokenDecimals);
  if (!parsed.ok || parsed.value <= 0n) return { ok: false, error: "amount" };
  if (parsed.value > availableBalance(snapshot.liquidityBalance, reservedLiquidity)) {
    return { ok: false, error: "balance" };
  }
  const amountsEstimated: readonly [bigint, bigint] = [
    parsed.value * snapshot.reserve0 / snapshot.liquidityTotalSupply,
    parsed.value * snapshot.reserve1 / snapshot.liquidityTotalSupply,
  ];
  const amountsMin = amountsEstimated.map((amount) =>
    amount * (BPS_SCALE - slippageBps) / BPS_SCALE
  ) as unknown as readonly [bigint, bigint];
  if (amountsMin.some((amount) => amount <= 0n)) {
    return { ok: false, error: "minimum" };
  }
  return {
    ok: true,
    liquidity: parsed.value,
    amountsEstimated,
    amountsMin,
    approvalDifference: positiveDifference(
      parsed.value + reservedAllowance,
      snapshot.liquidityAllowance,
    ),
  };
}

export function liquidityPercentAmount(
  available: bigint,
  percentage: 25 | 50 | 75 | 100,
): bigint {
  if (available < 0n) throw new RangeError("Available liquidity cannot be negative");
  return available * BigInt(percentage) / 100n;
}

function quoteProportional(amount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return amount * reserveOut / reserveIn;
}

function positiveDifference(required: bigint, current: bigint): bigint {
  return current >= required ? 0n : required - current;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
