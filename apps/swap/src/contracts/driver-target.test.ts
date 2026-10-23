import type { TransactionReceipt } from "@thruputchain/client";
import { contractAddress, sha256Hash } from "@thruputchain/protocol";
import { CxsWriter } from "@thruputchain/xdr";
import { describe, expect, it } from "vitest";

import { batch_driver } from "./generated/swap-driver";
import {
  buildProcessRequestsTarget,
  decodeRequestsProcessedSummary,
} from "./driver-target";

const RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;
type RequestsProcessed = batch_driver.v0_1.events.RequestsProcessed;

describe("buildProcessRequestsTarget", () => {
  it("builds the typed driver queue-processing invocation", () => {
    const driver = contractAddress(new Uint8Array(32).fill(5));

    const target = buildProcessRequestsTarget(driver);

    expect(target.invoked_address).toEqual(driver);
    // gas_for_batch(MIN_CRANK_BATCH); see driver-target.ts.
    expect(target.gas_limit).toBe(13_800_000n);
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
      transactionHash: sha256Hash(new Uint8Array(32).fill(1)),
      blockHeight: 2n,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events: [
        {
          address: driver,
          topics: [RequestsProcessed.signature],
          data: writer.finish(),
        },
      ],
    } satisfies TransactionReceipt;

    expect(decodeRequestsProcessedSummary(receipt, driver)).toEqual({
      processed: 3n,
      failed: 1n,
    });
  });
});
