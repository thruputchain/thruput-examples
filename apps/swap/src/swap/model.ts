import { I128_MAX, allowanceDifference } from "@/domain/allowance";
import { formatAmount, parseAmount } from "@/domain/amount";
import { availableBalance } from "@/domain/reservations";
import {
  minimumAmountOut,
  QuoteArithmeticError,
  quoteExactInput,
} from "./quote";
import { orientReserves, orderTokens } from "@/domain/tokens";
import type { PoolSnapshot, TokenSnapshot } from "@/swap/snapshot";

export type SwapDirection = "aToB" | "bToA";

export type QuoteError =
  | "empty"
  | "malformed"
  | "precision"
  | "bounds"
  | "zero"
  | "balance"
  | "signedRange"
  | "emptyLiquidity"
  | "quoteBounds"
  | "zeroOutput"
  | "zeroMinimum";

export type SwapQuoteResult =
  | { ok: false; error: QuoteError }
  | {
      ok: true;
      amountIn: bigint;
      amountOut: bigint;
      amountOutMin: bigint;
      priceImpactBps: bigint | null;
      allowanceDifference: bigint;
      reserveIn: bigint;
      reserveOut: bigint;
    };

export type SlippageParseResult =
  | { ok: true; basisPoints: bigint }
  | { ok: false; error: "empty" | "malformed" | "range" };

export function tokensForDirection(
  snapshot: PoolSnapshot,
  direction: SwapDirection,
): { input: TokenSnapshot; output: TokenSnapshot } {
  return direction === "aToB"
    ? { input: snapshot.tokenA, output: snapshot.tokenB }
    : { input: snapshot.tokenB, output: snapshot.tokenA };
}

export function deriveSwapQuote(
  snapshot: PoolSnapshot,
  direction: SwapDirection,
  input: string,
  slippageBps: bigint,
  reservedInput = 0n,
  allowanceReservedInput = reservedInput,
): SwapQuoteResult {
  const tokens = tokensForDirection(snapshot, direction);
  const parsed = parseAmount(input, tokens.input.decimals);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value === 0n) return { ok: false, error: "zero" };
  if (parsed.value > availableBalance(tokens.input.balance, reservedInput)) {
    return { ok: false, error: "balance" };
  }
  if (parsed.value > I128_MAX) {
    return { ok: false, error: "signedRange" };
  }

  const difference = allowanceDifference(
    allowanceReservedInput + parsed.value,
    tokens.input.allowance,
  );
  if (
    !difference.ok
    && tokens.input.allowance < allowanceReservedInput + parsed.value
  ) {
    return { ok: false, error: "signedRange" };
  }

  const inputIndex = orderTokens(
    tokens.input.address,
    tokens.output.address,
  ).inputIndex;
  const reserves = orientReserves(
    [snapshot.reserve0, snapshot.reserve1],
    inputIndex,
  );
  if (reserves.reserveIn === 0n || reserves.reserveOut === 0n) {
    return { ok: false, error: "emptyLiquidity" };
  }

  let quote;
  try {
    quote = quoteExactInput(
      parsed.value,
      reserves.reserveIn,
      reserves.reserveOut,
    );
  } catch (error) {
    if (error instanceof QuoteArithmeticError) {
      return { ok: false, error: "quoteBounds" };
    }
    throw error;
  }
  if (quote.amountOut === 0n) return { ok: false, error: "zeroOutput" };

  const amountOutMin = minimumAmountOut(quote.amountOut, slippageBps);
  if (amountOutMin === 0n) return { ok: false, error: "zeroMinimum" };

  return {
    ok: true,
    amountIn: parsed.value,
    amountOut: quote.amountOut,
    amountOutMin,
    priceImpactBps: quote.priceImpactBps,
    allowanceDifference:
      difference.ok && difference.difference > 0n ? difference.difference : 0n,
    reserveIn: reserves.reserveIn,
    reserveOut: reserves.reserveOut,
  };
}

export function parseSlippagePercent(input: string): SlippageParseResult {
  if (input.length === 0) return { ok: false, error: "empty" };
  const match = /^(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/.exec(input);
  if (match === null) return { ok: false, error: "malformed" };

  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? match[3] ?? "").padEnd(2, "0");
  const basisPoints = whole * 100n + BigInt(fraction || "0");
  if (basisPoints <= 0n || basisPoints > 5_000n) {
    return { ok: false, error: "range" };
  }
  return { ok: true, basisPoints };
}

export function formatBasisPoints(basisPoints: bigint): string {
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

export function formatExchangeRate(params: {
  amountIn: bigint;
  inputDecimals: number;
  amountOut: bigint;
  outputDecimals: number;
  precision?: number;
}): string {
  const precision = params.precision ?? 6;
  if (params.amountIn <= 0n || params.amountOut <= 0n) return "0";

  const scale = 10n ** BigInt(precision);
  const scaled =
    (params.amountOut * 10n ** BigInt(params.inputDecimals) * scale) /
    (params.amountIn * 10n ** BigInt(params.outputDecimals));
  if (scaled === 0n) return `<${formatAmount(1n, precision)}`;
  return formatAmount(scaled, precision);
}

export function formatTokenAmount(
  value: bigint,
  decimals: number,
  maximumFractionDigits: number,
): string {
  const digits = Math.min(decimals, maximumFractionDigits);
  const formatted = formatAmount(value, decimals, digits);
  if (value > 0n && formatted === "0" && digits < decimals) {
    const threshold = 10n ** BigInt(decimals - digits);
    return `<${formatAmount(threshold, decimals, digits)}`;
  }
  return formatted;
}

export function formatSignedTokenAmount(
  value: bigint,
  decimals: number,
  maximumFractionDigits: number,
): string {
  if (value === 0n) return "0";
  const sign = value > 0n ? "+" : "−";
  const absolute = value > 0n ? value : -value;
  return `${sign}${formatTokenAmount(
    absolute,
    decimals,
    maximumFractionDigits,
  )}`;
}

export const quoteErrorMessages: Record<QuoteError, string> = {
  empty: "Enter an amount.",
  malformed: "Enter a valid decimal amount.",
  precision: "This token does not support that many decimal places.",
  bounds: "The amount exceeds the token contract range.",
  zero: "Amount must be greater than zero.",
  balance: "Amount exceeds your available balance.",
  signedRange: "The required allowance change exceeds the signed contract range.",
  emptyLiquidity: "This pool has no available liquidity.",
  quoteBounds: "This quote exceeds the contract arithmetic range.",
  zeroOutput: "This amount is too small to produce output.",
  zeroMinimum: "This amount is too small after the slippage floor.",
};
