import type {
  TransactionReceipt,
  TransactionStatus,
} from "@thruputchain/client";
import { ExecResult } from "@thruputchain/protocol";

export type TransactionOutcome =
  | { kind: "pending" }
  | { kind: "awaitingReceipt"; height?: bigint }
  | { kind: "invalid"; reason: string }
  | {
      kind: "committedSuccess";
      receipt: TransactionReceipt;
    }
  | {
      kind: "committedFailure";
      receipt: TransactionReceipt;
    }
  | {
      kind: "indeterminate";
      reason:
        | "recentFailure"
        | "unknown"
        | "other"
        | "timeout"
        | "disconnect"
        | "dropped";
    };

export function outcomeFromStatus(
  status: TransactionStatus,
): TransactionOutcome {
  switch (status.status) {
    case "retry":
    case "pending":
      return { kind: "pending" };
    case "committed":
      return {
        kind: "awaitingReceipt",
        ...(status.height === undefined ? {} : { height: status.height }),
      };
    case "invalid":
      return { kind: "invalid", reason: status.reason };
    case "dropped":
      return { kind: "indeterminate", reason: "dropped" };
    case "recentFailure":
      return {
        kind: "indeterminate",
        reason: "recentFailure",
      };
    case "unknown":
      return {
        kind: "indeterminate",
        reason: "unknown",
      };
    case "other":
      return {
        kind: "indeterminate",
        reason: "other",
      };
  }
}

export function outcomeFromReceipt(
  receipt: TransactionReceipt,
): TransactionOutcome {
  return receipt.execResult === ExecResult.ExecResultOK
    ? { kind: "committedSuccess", receipt }
    : { kind: "committedFailure", receipt };
}
