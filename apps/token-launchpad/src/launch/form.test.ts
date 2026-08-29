import { describe, expect, it } from "vitest";

import { formatUnits, parseTokenDraft } from "@/launch/form";

describe("parseTokenDraft", () => {
  it("trims metadata and converts decimal supply to base units", () => {
    expect(
      parseTokenDraft({
        name: "  Acorn  ",
        symbol: " NUT ",
        decimals: "3",
        supply: "12.04",
      }),
    ).toEqual({
      value: {
        name: "Acorn",
        symbol: "NUT",
        decimals: 3,
        initialSupply: 12_040n,
      },
      errors: {},
    });
  });

  it("measures metadata as UTF-8 bytes", () => {
    const result = parseTokenDraft({
      name: "é".repeat(51),
      symbol: "TOKEN",
      decimals: "7",
      supply: "0",
    });
    expect(result.errors.name).toMatch(/100 UTF-8 bytes/);
    expect(
      parseTokenDraft({
        name: "é".repeat(50),
        symbol: "é".repeat(5),
        decimals: "7",
        supply: "0",
      }).errors,
    ).toEqual({});
    expect(
      parseTokenDraft({
        name: "Token",
        symbol: "é".repeat(6),
        decimals: "7",
        supply: "0",
      }).errors.symbol,
    ).toMatch(/10 UTF-8 bytes/);
  });

  it("rejects excess precision and values above i128 max", () => {
    expect(
      parseTokenDraft({
        name: "Token",
        symbol: "TOK",
        decimals: "2",
        supply: "1.001",
      }).errors.supply,
    ).toMatch(/2 decimal places/);
    expect(
      parseTokenDraft({
        name: "Token",
        symbol: "TOK",
        decimals: "0",
        supply: (1n << 127n).toString(),
      }).errors.supply,
    ).toMatch(/128-bit/);
  });

  it("accepts zero and the exact signed 128-bit maximum", () => {
    expect(
      parseTokenDraft({
        name: "Token",
        symbol: "TOK",
        decimals: "0",
        supply: "0",
      }).value?.initialSupply,
    ).toBe(0n);
    expect(
      parseTokenDraft({
        name: "Token",
        symbol: "TOK",
        decimals: "0",
        supply: ((1n << 127n) - 1n).toString(),
      }).value?.initialSupply,
    ).toBe((1n << 127n) - 1n);
  });

  it("rejects empty metadata and malformed decimals", () => {
    for (const decimals of ["-1", "1.5", "19", ""]) {
      const result = parseTokenDraft({
        name: " ",
        symbol: " ",
        decimals,
        supply: "1",
      });
      expect(result.errors.name).toBeDefined();
      expect(result.errors.symbol).toBeDefined();
      expect(result.errors.decimals).toBeDefined();
    }
  });
});

describe("formatUnits", () => {
  it("formats fractional and whole values without trailing zeroes", () => {
    expect(formatUnits(12_040n, 3)).toBe("12.04");
    expect(formatUnits(1_000n, 3)).toBe("1");
    expect(formatUnits(7n, 0)).toBe("7");
  });
});
