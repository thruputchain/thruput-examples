import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { buildAddLiquidityTarget, buildExactInputSwapTarget } from "./router-target";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("buildExactInputSwapTarget", () => {
  it("builds only the typed router target invocation", () => {
    const router = address(1);
    const target = buildExactInputSwapTarget(router, {
      amountIn: 10n,
      amountOutMin: 9n,
      tokenIn: address(2),
      tokenOut: address(3),
      recipient: address(4),
    });

    expect(target.invoked_address).toEqual(router);
    expect(target.calldata.length).toBeGreaterThan(0);
  });
});

describe("buildAddLiquidityTarget", () => {
  it("builds canonical desired and minimum arrays", () => {
    const router = address(1);
    const target = buildAddLiquidityTarget(router, {
      token0: address(2),
      token1: address(3),
      amountsDesired: [10n, 20n],
      amountsMin: [10n, 20n],
      recipient: address(4),
    });

    expect(target.invoked_address).toEqual(router);
    expect(target.calldata.length).toBeGreaterThan(0);
  });

  it("rejects zero or excessive minimums", () => {
    expect(() => buildAddLiquidityTarget(address(1), {
      token0: address(2),
      token1: address(3),
      amountsDesired: [10n, 20n],
      amountsMin: [0n, 21n],
      recipient: address(4),
    })).toThrow("positive and bounded");
  });
});
