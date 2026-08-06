import { contractAddress, contractEntrypointID, gasAmount, calldata } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { unavailableWriteBoundary, WriteUnavailableError } from "./write-boundary";

describe("unavailableWriteBoundary", () => {
  it("keeps state-changing actions unavailable", async () => {
    await expect(
      unavailableWriteBoundary.submit({
        invoked_address: contractAddress(new Uint8Array(32)),
        entrypoint: contractEntrypointID(new Uint8Array(8)),
        gas_limit: gasAmount(1n),
        calldata: calldata(new Uint8Array()),
      }),
    ).rejects.toBeInstanceOf(WriteUnavailableError);
  });
});
