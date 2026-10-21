import {
  UnsupportedRpcValue,
  type TransactionStatus,
} from "@thruputchain/client";
import { sha256Hash } from "@thruputchain/protocol";
import { describe, expect, it } from "vitest";

import { outcomeFromReceipt, outcomeFromStatus } from "./outcome";

const hash = sha256Hash(new Uint8Array(32));

describe("transaction outcomes", () => {
  it("does not treat an unfamiliar execution as a confirmed failure", () => {
    expect(
      outcomeFromReceipt({
        transactionHash: hash,
        blockHeight: 7n,
        execution: new UnsupportedRpcValue({ result: "future" }),
        gasUsed: 0n,
        events: [],
      }),
    ).toEqual({ kind: "indeterminate", reason: "other" });
  });
  it("keeps pending and committed-without-receipt non-resubmittable", () => {
    expect(outcomeFromStatus({ status: "pending" })).toEqual({
      kind: "pending",
    });
    expect(outcomeFromStatus({ status: "committed", blockHeight: 7n })).toEqual(
      {
        kind: "awaitingReceipt",
        height: 7n,
      },
    );
  });

  it.each(["recentFailure", "unknown", "other"] as const)(
    "maps %s to an indeterminate non-retryable outcome",
    (status) => {
      const value: TransactionStatus =
        status === "recentFailure"
          ? {
              status,
              attemptBlockHeight: 1n,
              cause: { kind: "other" },
            }
          : { status };
      expect(outcomeFromStatus(value)).toMatchObject({
        kind: "indeterminate",
      });
    },
  );

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

  it("keeps unfamiliar statuses indeterminate", () => {
    expect(
      outcomeFromStatus(new UnsupportedRpcValue({ status: "future" })),
    ).toEqual({
      kind: "indeterminate",
      reason: "other",
    });
  });

  it("uses the committed receipt to determine execution success", () => {
    const receipt = {
      transactionHash: hash,
      blockHeight: 7n,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events: [],
    };
    expect(outcomeFromReceipt(receipt)).toMatchObject({
      kind: "committedSuccess",
    });
    expect(
      outcomeFromReceipt({
        ...receipt,
        execution: { result: "abort" as const, abortData: new Uint8Array() },
        gasUsed: 0n,
      }),
    ).toMatchObject({ kind: "committedFailure" });
  });
});
