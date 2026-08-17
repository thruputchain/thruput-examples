import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { buildProcessRequestsTarget } from "./driver-target";

describe("buildProcessRequestsTarget", () => {
  it("builds the typed driver queue-processing invocation", () => {
    const driver = contractAddress(new Uint8Array(32).fill(5));

    const target = buildProcessRequestsTarget(driver);

    expect(target.invoked_address).toEqual(driver);
    expect(target.gas_limit).toBe(10_000_000n);
    expect(target.calldata).toEqual(new Uint8Array());
  });
});
