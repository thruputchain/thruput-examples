const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1_000n;
const BASIS_POINTS = 10_000n;
const U256_MAX = (1n << 256n) - 1n;

export class QuoteArithmeticError extends RangeError {
  constructor() {
    super("Quote arithmetic exceeds the contract U256 range");
    this.name = "QuoteArithmeticError";
  }
}

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
  if (amountIn > U256_MAX || reserveIn > U256_MAX || reserveOut > U256_MAX) {
    throw new QuoteArithmeticError();
  }
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
    return { amountOut: 0n, spotAmountOut: 0n, priceImpactBps: null };
  }

  const amountInWithFee = checkedMultiply(amountIn, FEE_NUMERATOR);
  const numerator = checkedMultiply(amountInWithFee, reserveOut);
  const denominator = checkedAdd(
    checkedMultiply(reserveIn, FEE_DENOMINATOR),
    amountInWithFee,
  );
  const amountOut =
    numerator / denominator;
  const spotAmountOut = checkedMultiply(amountIn, reserveOut) / reserveIn;
  const priceImpactBps =
    spotAmountOut === 0n
      ? null
      : ((spotAmountOut - amountOut) * BASIS_POINTS) / spotAmountOut;

  return { amountOut, spotAmountOut, priceImpactBps };
}

function checkedMultiply(left: bigint, right: bigint): bigint {
  const result = left * right;
  if (result > U256_MAX) throw new QuoteArithmeticError();
  return result;
}

function checkedAdd(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result > U256_MAX) throw new QuoteArithmeticError();
  return result;
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
