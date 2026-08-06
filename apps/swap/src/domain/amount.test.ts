import { describe, expect, it } from "vitest";

import { formatAmount, parseAmount, U128_MAX } from "./amount";

describe("parseAmount", () => {
  it.each([
    ["1", 6, 1_000_000n],
    ["1.25", 6, 1_250_000n],
    [".5", 6, 500_000n],
    ["0.000001", 6, 1n],
  ])("parses %s with %i decimals", (input, decimals, expected) => {
    expect(parseAmount(input, decimals)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["", "empty"],
    ["1e3", "malformed"],
    ["-1", "malformed"],
    ["1.2.3", "malformed"],
    [" 1", "malformed"],
    ["0.0000001", "precision"],
  ])("rejects %j", (input, error) => {
    expect(parseAmount(input, 6)).toEqual({ ok: false, error });
  });

  it("accepts the u128 maximum and rejects larger amounts", () => {
    expect(parseAmount(U128_MAX.toString(), 0)).toEqual({
      ok: true,
      value: U128_MAX,
    });
    expect(parseAmount((U128_MAX + 1n).toString(), 0)).toEqual({
      ok: false,
      error: "bounds",
    });
  });
});

describe("formatAmount", () => {
  it("formats without converting through number", () => {
    expect(formatAmount(123_456_789_012_345_678n, 6)).toBe(
      "123456789012.345678",
    );
  });

  it("trims zeroes and limits displayed precision", () => {
    expect(formatAmount(1_230_000n, 6)).toBe("1.23");
    expect(formatAmount(1_234_567n, 6, 2)).toBe("1.23");
  });
});
