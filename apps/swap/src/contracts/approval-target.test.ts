import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { buildApprovalTarget } from "./approval-target";

describe("buildApprovalTarget", () => {
  it("builds a typed exact allowance adjustment", () => {
    const token = contractAddress(new Uint8Array(32).fill(1));
    const spender = contractAddress(new Uint8Array(32).fill(2));

    const target = buildApprovalTarget(token, spender, -25n);

    expect(target.invoked_address).toEqual(token);
    expect(target.gas_limit).toBe(10_000_000n);
    expect(target.calldata.length).toBeGreaterThan(0);
  });

  it("rejects a no-op adjustment", () => {
    expect(() =>
      buildApprovalTarget(
        contractAddress(new Uint8Array(32).fill(1)),
        contractAddress(new Uint8Array(32).fill(2)),
        0n,
      ),
    ).toThrow("must not be zero");
  });
});
