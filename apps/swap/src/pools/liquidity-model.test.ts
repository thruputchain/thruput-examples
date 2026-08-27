import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import type { PoolSnapshot } from "@/swap/snapshot";
import {
  deriveAddLiquidityQuote,
  deriveRemoveLiquidityQuote,
  liquidityPercentAmount,
} from "./liquidity-model";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("deriveAddLiquidityQuote", () => {
  it("lets either token drive canonical desired amounts", () => {
    expect(deriveAddLiquidityQuote(snapshot(), 0, "10", 100n)).toMatchObject({
      ok: true,
      amountsDesired: [10_000_000n, 20_000_000n],
      amountsMin: [9_900_000n, 19_800_000n],
      estimatedLiquidity: 10_000_000n,
    });
    expect(deriveAddLiquidityQuote(snapshot(), 1, "20", 100n)).toMatchObject({
      ok: true,
      amountsDesired: [10_000_000n, 20_000_000n],
    });
  });

  it("separates balance and handler allowance reservations", () => {
    const quote = deriveAddLiquidityQuote(
      snapshot(),
      0,
      "10",
      100n,
      [5_000_000n, 7_000_000n],
      [2_000_000n, 3_000_000n],
    );
    expect(quote).toMatchObject({
      ok: true,
      approvalDifferences: [12_000_000n, 23_000_000n],
    });
  });

  it("disables fee-on and insufficient-balance additions", () => {
    expect(deriveAddLiquidityQuote(
      snapshot({ feeTo: address(9) }),
      0,
      "1",
      100n,
    )).toEqual({ ok: false, error: "feeEnabled" });
    expect(deriveAddLiquidityQuote(
      snapshot(),
      0,
      "96",
      100n,
      [5_000_000n, 0n],
    )).toEqual({
      ok: false,
      error: "balance",
      amountsDesired: [96_000_000n, 192_000_000n],
      insufficientTokenIndexes: [0],
    });
  });
});

describe("deriveRemoveLiquidityQuote", () => {
  it("estimates canonical outputs with floor rounding and slippage", () => {
    expect(deriveRemoveLiquidityQuote(snapshot(), "10", 100n)).toEqual({
      ok: true,
      liquidity: 10_000_000n,
      amountsEstimated: [10_000_000n, 20_000_000n],
      amountsMin: [9_900_000n, 19_800_000n],
      approvalDifference: 10_000_000n,
    });
  });

  it("respects reserved LP and percentage controls", () => {
    expect(deriveRemoveLiquidityQuote(
      snapshot(),
      "90.000001",
      100n,
      10_000_000n,
    )).toEqual({ ok: false, error: "balance" });
    expect(liquidityPercentAmount(99n, 25)).toBe(24n);
    expect(liquidityPercentAmount(99n, 100)).toBe(99n);
  });
});

function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    tokenA: {
      address: address(1),
      name: "Token A",
      symbol: "A",
      decimals: 6,
      balance: 100_000_000n,
      allowance: 0n,
    },
    tokenB: {
      address: address(2),
      name: "Token B",
      symbol: "B",
      decimals: 6,
      balance: 200_000_000n,
      allowance: 0n,
    },
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    reserveTimestamp: 1n,
    liquidityTotalSupply: 1_000_000_000n,
    liquidityBalance: 100_000_000n,
    liquidityAllowance: 0n,
    liquidityTokenSymbol: "LP",
    liquidityTokenDecimals: 6,
    feeTo: null,
    chainHeight: 7n,
    readAt: 1,
    ...overrides,
  };
}
