import type { TransactionStatus } from "@groundhogchain/client";
import { ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { outcomeFromReceipt, outcomeFromStatus } from "./outcome";

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
      const value: TransactionStatus =
        status === "recentFailure"
          ? {
              status,
              attemptHeight: 1n,
              cause: { kind: "other" },
            }
          : { status };
      expect(outcomeFromStatus(value)).toMatchObject({
        kind: "indeterminate",
      });
    },
  );

  it("waits for a receipt when commitment height is unavailable", () => {
    expect(outcomeFromStatus({ status: "committed" })).toEqual({
      kind: "awaitingReceipt",
    });
  });

  it("keeps scheduler retries pending and drops non-resubmittable", () => {
    const error = { source: "scheduler" as const, code: 1 };
    expect(outcomeFromStatus({ status: "retry", error })).toEqual({
      kind: "pending",
    });
    expect(outcomeFromStatus({ status: "dropped", error })).toEqual({
      kind: "indeterminate",
      reason: "dropped",
    });
  });

  it("allows retry after authoritative invalid status", () => {
    expect(outcomeFromStatus({ status: "invalid", reason: "expired" })).toEqual(
      {
        kind: "invalid",
        reason: "expired",
      },
    );
  });

  it("uses the committed receipt to determine execution success", () => {
    const receipt = {
      txHash: hash,
      height: 7n,
      execResult: ExecResult.ExecResultOK,
      gasUsed: 0n,
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
        gasUsed: 0n,
      }),
    ).toMatchObject({ kind: "committedFailure" });
  });
});
