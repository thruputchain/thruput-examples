import {
  hashFromHex,
  toHex0x,
  TransactionProcessingError,
  TransactionReceiptTimeoutError,
  TransactionRejectedError,
  type CoreGroundhogClient,
  type SchedulerTransactionError,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  TransactionExecutionError,
  TransactionObservationError,
} from "@groundhogchain/client/wallet";
import { ExecResult, networkHash } from "@groundhogchain/protocol";
import type { WriteResult } from "./write-boundary";

export function receiptResult(receipt: TransactionReceipt): WriteResult {
  return {
    kind:
      receipt.execResult === ExecResult.ExecResultOK
        ? "committedSuccess"
        : "committedFailure",
    hash: toHex0x(receipt.txHash),
    receipt,
  };
}

// Scheduler processing ended without a receipt. The node keeps no copy to try
// again, and this app never resubmits, so the transaction cannot commit.
export function processingFailureReason(
  status: "retry" | "dropped",
  error: SchedulerTransactionError,
): string {
  const detail = `${error.source} error ${error.code}`;
  return status === "retry"
    ? `The network could not process the transaction (${detail}); it was not applied and may be submitted again`
    : `The network dropped the transaction (${detail}); it was not applied`;
}

export function observationFailure(hash: string, error: unknown): WriteResult {
  if (error instanceof TransactionRejectedError)
    return { kind: "invalid", hash, reason: error.reason };
  if (error instanceof TransactionProcessingError)
    return {
      kind: "invalid",
      hash,
      reason: processingFailureReason(error.status, error.error),
    };
  if (error instanceof TransactionReceiptTimeoutError) {
    const status = error.lastStatus?.status;
    return {
      kind: "indeterminate",
      hash,
      reason: error.cause
        ? "disconnect"
        : status === "unknown" ||
            status === "recentFailure" ||
            status === "other"
          ? status
          : "timeout",
    };
  }
  return {
    kind: "indeterminate",
    hash,
    reason: error instanceof TypeError ? "disconnect" : "other",
  };
}

// Decoding failure must preserve commitment; the workflow verifies the original receipt.
export function executionFailure(error: unknown): WriteResult | undefined {
  if (
    error instanceof TransactionExecutionError ||
    error instanceof ExecutionDecodeError ||
    error instanceof ExecutionReturnUnavailableError
  )
    return receiptResult(error.receipt);
  if (error instanceof TransactionObservationError)
    return observationFailure(toHex0x(error.txHash), error.cause);
}

// Public observation remains available after the signing wallet is disposed.
export function createTransactionObserver(
  config: { networkIdHex: string },
  client: Pick<CoreGroundhogClient, "waitForTransactionReceipt">,
): (hash: string) => Promise<WriteResult> {
  return async (hash) => {
    if (!/^0x[0-9a-f]{64}$/.test(hash))
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "The stored transaction hash is invalid",
      };
    try {
      return receiptResult(
        await client.waitForTransactionReceipt(hashFromHex(hash), {
          expectedNetworkHash: networkHash(
            hashFromHex(`0x${config.networkIdHex}`),
          ),
          timeoutMs: 20_000,
          pollingIntervalMs: 500,
        }),
      );
    } catch (error) {
      return observationFailure(hash, error);
    }
  };
}
