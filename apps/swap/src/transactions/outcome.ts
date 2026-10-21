import type {
  TransactionReceipt,
  TransactionStatus,
} from "@thruputchain/client";

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
  if (!("status" in status)) return { kind: "indeterminate", reason: "other" };
  switch (status.status) {
    case "retry":
    case "pending":
      return { kind: "pending" };
    case "committed":
      return {
        kind: "awaitingReceipt",
        height: status.blockHeight,
      };
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
  if (!("result" in receipt.execution))
    return { kind: "indeterminate", reason: "other" };
  return "result" in receipt.execution && receipt.execution.result === "return"
    ? { kind: "committedSuccess", receipt }
    : { kind: "committedFailure", receipt };
}
