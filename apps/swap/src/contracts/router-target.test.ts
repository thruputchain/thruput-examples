import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { buildExactInputSwapTarget } from "./router-target";

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
