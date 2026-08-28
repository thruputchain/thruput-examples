import type {
  TransactionReceipt,
  TransactionStatus,
} from "@groundhogchain/client";
import { ExecResult } from "@groundhogchain/protocol";

export type TransactionOutcome =
  | { kind: "pending" }
  | { kind: "awaitingReceipt" }
  | { kind: "invalid"; reason: string }
  | { kind: "committedSuccess"; receipt: TransactionReceipt }
  | { kind: "committedFailure"; receipt: TransactionReceipt }
  | {
      kind: "indeterminate";
      reason: "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
    };

export function outcomeFromStatus(
  status: TransactionStatus,
): TransactionOutcome {
  switch (status.status) {
    case "pending":
      return { kind: "pending" };
    case "committed":
      return { kind: "awaitingReceipt" };
    case "invalid":
      return { kind: "invalid", reason: status.reason };
    case "recentFailure":
    case "unknown":
    case "other":
      return { kind: "indeterminate", reason: status.status };
  }
}

export function outcomeFromReceipt(
  receipt: TransactionReceipt,
): TransactionOutcome {
  return receipt.execResult === ExecResult.ExecResultOK
    ? { kind: "committedSuccess", receipt }
    : { kind: "committedFailure", receipt };
}
