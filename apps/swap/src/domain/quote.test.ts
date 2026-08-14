import { describe, expect, it } from "vitest";

import {
  minimumAmountOut,
  QuoteArithmeticError,
  quoteExactInput,
} from "./quote";

const U256_MAX = (1n << 256n) - 1n;

describe("quoteExactInput", () => {
  it("matches the constant-product exact-input formula", () => {
    expect(quoteExactInput(10_000n, 1_000_000_000n, 1_000_000_000n)).toEqual({
      amountOut: 9_969n,
      spotAmountOut: 10_000n,
      priceImpactBps: 31n,
    });
  });

  it("omits price impact when spot output rounds to zero", () => {
    expect(quoteExactInput(1n, 10n, 1n)).toEqual({
      amountOut: 0n,
      spotAmountOut: 0n,
      priceImpactBps: null,
    });
  });

  it("rejects U256 intermediate overflow at the contract boundary", () => {
    const largestSafeReserveOut = U256_MAX / 997n;

    expect(() => quoteExactInput(1n, 1n, largestSafeReserveOut)).not.toThrow();
    expect(() =>
      quoteExactInput(1n, 1n, largestSafeReserveOut + 1n),
    ).toThrow(QuoteArithmeticError);
    expect(() => quoteExactInput(U256_MAX, 1n, 1n)).toThrow(
      QuoteArithmeticError,
    );
  });
});

describe("minimumAmountOut", () => {
  it("rounds down with integer arithmetic", () => {
    expect(minimumAmountOut(9_969n, 50n)).toBe(9_919n);
  });

  it("rejects slippage outside the configured range", () => {
    expect(() => minimumAmountOut(1n, 0n)).toThrow();
    expect(() => minimumAmountOut(1n, 5_001n)).toThrow();
  });
});
