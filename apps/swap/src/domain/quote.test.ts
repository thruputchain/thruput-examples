import { expect, it } from "vitest";
import { quoteExactInput, quoteWithinRange } from "./quote";

it("quotes an amount, and returns null instead of throwing for one too large", () => {
  expect(quoteWithinRange(1_000n, 1_000_000n, 1_000_000n)).toEqual(
    quoteExactInput(1_000n, 1_000_000n, 1_000_000n),
  );
  // Within u128, but amountIn * 997 * reserveOut exceeds U256.
  const huge = (1n << 127n) - 1n;
  expect(() => quoteExactInput(huge, 1n, huge)).toThrow(/U256 range/);
  expect(quoteWithinRange(huge, 1n, huge)).toBeNull();
});
