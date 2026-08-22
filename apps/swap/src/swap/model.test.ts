import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { I128_MAX } from "@/domain/allowance";
import type { PoolSnapshot } from "@/swap/snapshot";

import {
  deriveSwapQuote,
  formatBasisPoints,
  formatExchangeRate,
  formatSignedTokenAmount,
  formatTokenAmount,
  parseSlippagePercent,
  tokensForDirection,
} from "./model";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    tokenA: {
      address: address(1),
      name: "Groundhog USD",
      symbol: "gUSD",
      decimals: 6,
      balance: 100_000_000n,
      allowance: 0n,
    },
    tokenB: {
      address: address(2),
      name: "Groundhog EUR",
      symbol: "gEUR",
      decimals: 6,
      balance: 50_000_000n,
      allowance: 0n,
    },
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    reserveTimestamp: 1n,
    liquidityTotalSupply: 1_000_000_000n,
    liquidityBalance: 100_000_000n,
    feeTo: null,
    chainHeight: 7n,
    readAt: 1,
    ...overrides,
  };
}

describe("parseSlippagePercent", () => {
  it.each([
    ["0.1", 10n],
    [".5", 50n],
    ["1", 100n],
    ["50.00", 5_000n],
  ])("parses %s without floating point", (input, expected) => {
    expect(parseSlippagePercent(input)).toEqual({
      ok: true,
      basisPoints: expected,
    });
  });

  it.each(["", "0", "0.001", "50.01", "1e2", "-1"])(
    "rejects %j",
    (input) => {
      expect(parseSlippagePercent(input).ok).toBe(false);
    },
  );
});

describe("deriveSwapQuote", () => {
  it("quotes both directions with oriented reserves", () => {
    const pool = snapshot();
    const forward = deriveSwapQuote(pool, "aToB", "10", 50n);
    const reverse = deriveSwapQuote(pool, "bToA", "10", 50n);

    expect(forward).toMatchObject({
      ok: true,
      reserveIn: 1_000_000_000n,
      reserveOut: 2_000_000_000n,
    });
    expect(reverse).toMatchObject({
      ok: true,
      reserveIn: 2_000_000_000n,
      reserveOut: 1_000_000_000n,
    });
    expect(tokensForDirection(pool, "bToA").input.symbol).toBe("gEUR");
  });

  it("validates balance and allowance against reserved input", () => {
    const pool = snapshot();
    const quote = deriveSwapQuote(pool, "aToB", "10", 50n, 20_000_000n);

    expect(quote).toMatchObject({
      ok: true,
      allowanceDifference: 30_000_000n,
    });
    expect(
      deriveSwapQuote(pool, "aToB", "81", 50n, 20_000_000n),
    ).toEqual({ ok: false, error: "balance" });
  });

  it("accepts safe excess allowance beyond the signed adjustment range", () => {
    const pool = snapshot({
      tokenA: {
        ...snapshot().tokenA,
        allowance: I128_MAX * 2n,
      },
    });

    expect(deriveSwapQuote(pool, "aToB", "10", 50n)).toMatchObject({
      ok: true,
      allowanceDifference: 0n,
    });
  });

  it.each([
    ["", "empty"],
    ["abc", "malformed"],
    ["0", "zero"],
    ["0.0000001", "precision"],
    ["101", "balance"],
  ] as const)("maps %j to %s", (input, error) => {
    expect(deriveSwapQuote(snapshot(), "aToB", input, 50n)).toEqual({
      ok: false,
      error,
    });
  });

  it("rejects empty liquidity and signed-range violations", () => {
    expect(
      deriveSwapQuote(snapshot({ reserve0: 0n }), "aToB", "1", 50n),
    ).toEqual({ ok: false, error: "emptyLiquidity" });

    const pool = snapshot({
      tokenA: {
        ...snapshot().tokenA,
        decimals: 0,
        balance: I128_MAX + 1n,
      },
    });
    expect(
      deriveSwapQuote(pool, "aToB", (I128_MAX + 1n).toString(), 50n),
    ).toEqual({ ok: false, error: "signedRange" });
  });

  it("rejects zero quoted and minimum output", () => {
    expect(
      deriveSwapQuote(
        snapshot({ reserve0: 1_000_000_000n, reserve1: 1n }),
        "aToB",
        "0.000001",
        50n,
      ),
    ).toEqual({ ok: false, error: "zeroOutput" });

    const tinyPool = snapshot({
      tokenA: { ...snapshot().tokenA, decimals: 0 },
      tokenB: { ...snapshot().tokenB, decimals: 0 },
      reserve0: 100n,
      reserve1: 102n,
    });
    expect(deriveSwapQuote(tinyPool, "aToB", "1", 50n)).toEqual({
      ok: false,
      error: "zeroMinimum",
    });
  });

  it("maps contract U256 overflow to a quote error", () => {
    const amountIn = I128_MAX;
    const pool = snapshot({
      tokenA: {
        ...snapshot().tokenA,
        decimals: 0,
        balance: amountIn,
      },
      reserve0: 1n,
      reserve1: (1n << 128n) - 1n,
    });

    expect(
      deriveSwapQuote(pool, "aToB", amountIn.toString(), 50n),
    ).toEqual({ ok: false, error: "quoteBounds" });
  });
});

describe("display math", () => {
  it("formats basis points and exchange rates with bigint only", () => {
    expect(formatBasisPoints(10n)).toBe("0.1");
    expect(formatBasisPoints(50n)).toBe("0.5");
    expect(formatBasisPoints(525n)).toBe("5.25");
    expect(
      formatExchangeRate({
        amountIn: 2_000_000n,
        inputDecimals: 6,
        amountOut: 5_000_000_000_000_000_000n,
        outputDecimals: 18,
      }),
    ).toBe("2.5");
    expect(formatTokenAmount(1n, 18, 8)).toBe("<0.00000001");
    expect(formatSignedTokenAmount(-1n, 18, 8)).toBe("−<0.00000001");
  });
});
