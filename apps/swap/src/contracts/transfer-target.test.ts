import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it } from "vitest";

import { buildTransferTarget } from "./transfer-target";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

describe("buildTransferTarget", () => {
  it("builds a positive ERC20 transfer", () => {
    const target = buildTransferTarget(address(1), address(2), 25n);

    expect(target.invoked_address).toEqual(address(1));
    expect(target.gas_limit).toBe(10_000_000n);
    expect(target.calldata.length).toBeGreaterThan(0);
  });

  it("rejects non-positive transfers", () => {
    expect(() => buildTransferTarget(address(1), address(2), 0n)).toThrow(
      "Transfer amount must be positive",
    );
  });
});
