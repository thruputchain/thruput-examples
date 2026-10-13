import type { TransactionReceipt } from "@thruputchain/client";
import type { Invocation } from "@thruputchain/protocol";

export type WriteResult =
  | { kind: "preSubmissionFailure"; hash: null; message: string }
  | { kind: "invalid"; hash: string; reason: string }
  | { kind: "committedSuccess"; hash: string; receipt: TransactionReceipt }
  | { kind: "committedFailure"; hash: string; receipt: TransactionReceipt }
  | {
      kind: "indeterminate";
      hash: string | null;
      reason: "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
    };

export interface WriteBoundary {
  supportsBatch?(count: number): Promise<boolean>;
  executeBatch?(
    targets: readonly Invocation[],
    observer?: { onSigned: (hash: string) => void | Promise<void> },
  ): Promise<WriteResult>;
  execute(
    target: Invocation,
    observer?: { onSigned: (hash: string) => void | Promise<void> },
  ): Promise<WriteResult>;
  observe?(hash: string): Promise<WriteResult>;
}

export const unavailableWriteBoundary: WriteBoundary = {
  execute: async () => ({
    kind: "preSubmissionFailure",
    hash: null,
    message: "Connect a wallet to make changes",
  }),
};
