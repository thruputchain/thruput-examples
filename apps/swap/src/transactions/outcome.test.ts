import { ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import {
  indeterminateOutcome,
  outcomeFromReceipt,
  outcomeFromStatus,
  preSubmissionFailure,
} from "./outcome";

const hash = sha256Hash(new Uint8Array(32));

describe("transaction outcomes", () => {
  it("keeps pending and committed-without-receipt non-resubmittable", () => {
    expect(outcomeFromStatus({ status: "pending" })).toEqual({
      kind: "pending",
      retryAllowed: false,
    });
    expect(outcomeFromStatus({ status: "committed", height: 7n })).toEqual({
      kind: "awaitingReceipt",
      height: 7n,
      retryAllowed: false,
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
        retryAllowed: false,
      });
    },
  );

  it("allows retry after authoritative invalid status", () => {
    expect(outcomeFromStatus({ status: "invalid", reason: "expired" })).toEqual({
      kind: "invalid",
      reason: "expired",
      retryAllowed: true,
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
      retryAllowed: false,
    });
    expect(
      outcomeFromReceipt({
        ...receipt,
        execResult: ExecResult.ExecResultTxRootFrameReverted,
      }),
    ).toMatchObject({ kind: "committedFailure", retryAllowed: false });
  });

  it("only permits a fresh retry before submission or after invalid status", () => {
    expect(preSubmissionFailure("rejected").retryAllowed).toBe(true);
    expect(indeterminateOutcome("timeout").retryAllowed).toBe(false);
    expect(indeterminateOutcome("disconnect").retryAllowed).toBe(false);
  });
});
