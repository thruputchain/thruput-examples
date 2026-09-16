import type { TransactionReceipt } from "@groundhogchain/client";
import {
  contractAddress,
  ExecResult,
  sha256Hash,
} from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it } from "vitest";

import { RequestsProcessed } from "./generated/swap-driver";
import {
  buildProcessRequestsTarget,
  decodeRequestsProcessedSummary,
} from "./driver-target";

describe("buildProcessRequestsTarget", () => {
  it("builds the typed driver queue-processing invocation", () => {
    const driver = contractAddress(new Uint8Array(32).fill(5));

    const target = buildProcessRequestsTarget(driver);

    expect(target.invoked_address).toEqual(driver);
    // gas_for_batch(MIN_CRANK_BATCH); see driver-target.ts.
    expect(target.gas_limit).toBe(13_700_000n);
    expect(target.calldata).toEqual(new Uint8Array());
  });
});

describe("decodeRequestsProcessedSummary", () => {
  it("decodes the driver summary from a committed receipt", () => {
    const driver = contractAddress(new Uint8Array(32).fill(5));
    const writer = new CxsWriter();
    writer.writeUint32(3n);
    writer.writeUint32(1n);
    const receipt = {
      txHash: sha256Hash(new Uint8Array(32).fill(1)),
      height: 2n,
      execResult: ExecResult.ExecResultOK,
      events: [{
        contractAddress: driver,
        topics: [RequestsProcessed.signature],
        data: writer.finish(),
      }],
      returnData: new Uint8Array(),
      abortData: null,
    } satisfies TransactionReceipt;

    expect(decodeRequestsProcessedSummary(receipt, driver)).toEqual({
      processed: 3n,
      failed: 1n,
    });
  });
});
