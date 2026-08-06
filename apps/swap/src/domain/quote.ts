const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1_000n;
const BASIS_POINTS = 10_000n;

export interface ExactInputQuote {
  amountOut: bigint;
  spotAmountOut: bigint;
  priceImpactBps: bigint | null;
}

export function quoteExactInput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): ExactInputQuote {
  if (amountIn < 0n || reserveIn < 0n || reserveOut < 0n) {
    throw new RangeError("Amounts and reserves cannot be negative");
  }
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
    return { amountOut: 0n, spotAmountOut: 0n, priceImpactBps: null };
  }

  const amountInWithFee = amountIn * FEE_NUMERATOR;
  const amountOut =
    (amountInWithFee * reserveOut) /
    (reserveIn * FEE_DENOMINATOR + amountInWithFee);
  const spotAmountOut = (amountIn * reserveOut) / reserveIn;
  const priceImpactBps =
    spotAmountOut === 0n
      ? null
      : ((spotAmountOut - amountOut) * BASIS_POINTS) / spotAmountOut;

  return { amountOut, spotAmountOut, priceImpactBps };
}

export function minimumAmountOut(amountOut: bigint, slippageBps: bigint): bigint {
  if (amountOut < 0n) {
    throw new RangeError("Output amount cannot be negative");
  }
  if (slippageBps <= 0n || slippageBps > 5_000n) {
    throw new RangeError("Slippage must be between 1 and 5000 basis points");
  }
  return (amountOut * (BASIS_POINTS - slippageBps)) / BASIS_POINTS;
}

export const SWAP_FEE_BPS = 30n;
