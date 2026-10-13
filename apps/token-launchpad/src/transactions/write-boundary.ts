import type { TransactionReceipt } from "@thruputchain/client";
import type { ContractCall } from "@thruputchain/client/contract";

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
  supportsBatch?(count: number): Promise<boolean>;
  executeBatch?(
    calls: readonly ContractCall[],
    observer: { onSigned: (hash: string) => void | Promise<void> },
  ): Promise<WriteResult>;
  execute(
    call: ContractCall,
    observer: { onSigned: (hash: string) => void | Promise<void> },
  ): Promise<WriteResult>;
  observe(hash: string): Promise<WriteResult>;
}
