import { contractAddress, contractEntrypointID, gasAmount, calldata } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { unavailableWriteBoundary } from "./write-boundary";

describe("unavailableWriteBoundary", () => {
  it("reports a retryable pre-submission failure", async () => {
    await expect(
      unavailableWriteBoundary.execute({
        invoked_address: contractAddress(new Uint8Array(32)),
        entrypoint: contractEntrypointID(new Uint8Array(8)),
        gas_limit: gasAmount(1n),
        calldata: calldata(new Uint8Array()),
      }),
    ).resolves.toMatchObject({ kind: "preSubmissionFailure", hash: null });
  });
});
