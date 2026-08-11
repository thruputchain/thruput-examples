import { ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import {
  outcomeFromReceipt,
  outcomeFromStatus,
} from "./outcome";

const hash = sha256Hash(new Uint8Array(32));

describe("transaction outcomes", () => {
  it("keeps pending and committed-without-receipt non-resubmittable", () => {
    expect(outcomeFromStatus({ status: "pending" })).toEqual({
      kind: "pending",
    });
    expect(outcomeFromStatus({ status: "committed", height: 7n })).toEqual({
      kind: "awaitingReceipt",
      height: 7n,
    });
  });

  it.each(["recentFailure", "unknown", "other"] as const)(
    "maps %s to an indeterminate non-retryable outcome",
    (status) => {
      const value =
        status === "recentFailure"
          ? {
              status,
              attemptHeight: 1n,
              conflict: {
                address: new Uint8Array(32),
                key: new Uint8Array(),
                code: "other" as const,
              },
            }
          : { status };
      expect(outcomeFromStatus(value as never)).toMatchObject({
        kind: "indeterminate",
      });
    },
  );

  it("allows retry after authoritative invalid status", () => {
    expect(outcomeFromStatus({ status: "invalid", reason: "expired" })).toEqual({
      kind: "invalid",
      reason: "expired",
    });
  });

  it("uses the committed receipt to determine execution success", () => {
    const receipt = {
      txHash: hash,
      height: 7n,
      execResult: ExecResult.ExecResultOK,
      events: [],
      returnData: null,
      abortData: null,
    };
    expect(outcomeFromReceipt(receipt)).toMatchObject({
      kind: "committedSuccess",
    });
    expect(
      outcomeFromReceipt({
        ...receipt,
        execResult: ExecResult.ExecResultTxRootFrameReverted,
      }),
    ).toMatchObject({ kind: "committedFailure" });
  });
});
