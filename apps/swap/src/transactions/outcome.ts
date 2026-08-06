import type {
  TransactionReceipt,
  TransactionStatus,
} from "@groundhogchain/client";
import { ExecResult } from "@groundhogchain/protocol";

export type TransactionOutcome =
  | { kind: "pending"; retryAllowed: false }
  | { kind: "awaitingReceipt"; height: bigint; retryAllowed: false }
  | { kind: "invalid"; reason: string; retryAllowed: true }
  | {
      kind: "committedSuccess";
      receipt: TransactionReceipt;
      retryAllowed: false;
    }
  | {
      kind: "committedFailure";
      receipt: TransactionReceipt;
      retryAllowed: false;
    }
  | {
      kind: "indeterminate";
      reason: "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
      retryAllowed: false;
    }
  | {
      kind: "preSubmissionFailure";
      message: string;
      retryAllowed: true;
    };

export function outcomeFromStatus(status: TransactionStatus): TransactionOutcome {
  switch (status.status) {
    case "pending":
      return { kind: "pending", retryAllowed: false };
    case "committed":
      return {
        kind: "awaitingReceipt",
        height: status.height,
        retryAllowed: false,
      };
    case "invalid":
      return { kind: "invalid", reason: status.reason, retryAllowed: true };
    case "recentFailure":
      return {
        kind: "indeterminate",
        reason: "recentFailure",
        retryAllowed: false,
      };
    case "unknown":
      return {
        kind: "indeterminate",
        reason: "unknown",
        retryAllowed: false,
      };
    case "other":
      return {
        kind: "indeterminate",
        reason: "other",
        retryAllowed: false,
      };
  }
}

export function outcomeFromReceipt(
  receipt: TransactionReceipt,
): TransactionOutcome {
  return receipt.execResult === ExecResult.ExecResultOK
    ? { kind: "committedSuccess", receipt, retryAllowed: false }
    : { kind: "committedFailure", receipt, retryAllowed: false };
}

export function indeterminateOutcome(
  reason: "timeout" | "disconnect",
): TransactionOutcome {
  return { kind: "indeterminate", reason, retryAllowed: false };
}

export function preSubmissionFailure(message: string): TransactionOutcome {
  return { kind: "preSubmissionFailure", message, retryAllowed: true };
}
