import type { TransactionReceipt } from "@groundhogchain/client";
import type { Invocation } from "@groundhogchain/protocol";

export type WriteResult =
  | { kind: "preSubmissionFailure"; hash: null; message: string }
  | { kind: "invalid"; hash: string; reason: string }
  | { kind: "committedSuccess"; hash: string; receipt: TransactionReceipt }
  | { kind: "committedFailure"; hash: string; receipt: TransactionReceipt }
  | {
      kind: "indeterminate";
      hash: string;
      reason: "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
    };

export interface WriteBoundary {
  execute(
    target: Invocation,
    observer: { onSigned: (hash: string) => void },
  ): Promise<WriteResult>;
  observe(hash: string): Promise<WriteResult>;
}

export const unavailableWriteBoundary: WriteBoundary = {
  execute: async () => ({
    kind: "preSubmissionFailure",
    hash: null,
    message: "State-changing actions require a configured development wallet",
  }),
  observe: async (hash) => ({ kind: "indeterminate", hash, reason: "other" }),
};
