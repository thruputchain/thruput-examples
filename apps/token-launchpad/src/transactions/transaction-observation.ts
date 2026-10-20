import {
  hashFromBase58,
  toBase58,
  TransactionReceiptTimeoutError,
  TransactionRejectedError,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  TransactionExecutionError,
  TransactionObservationError,
} from "@thruputchain/client/wallet";
import { ExecResult, networkHash } from "@thruputchain/protocol";
import type { WriteResult } from "./write-boundary";

export function receiptResult(receipt: TransactionReceipt): WriteResult {
  return {
    kind:
      receipt.execResult === ExecResult.ExecResultOK
        ? "committedSuccess"
        : "committedFailure",
    hash: toBase58(receipt.txHash),
    receipt,
  };
}

export function observationFailure(hash: string, error: unknown): WriteResult {
  if (error instanceof TransactionRejectedError)
    return { kind: "invalid", hash, reason: error.reason };
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
    return observationFailure(toBase58(error.txHash), error.cause);
}

// Public observation remains available after the signing wallet is disposed.
export function createTransactionObserver(
  config: { networkId: string },
  client: Pick<CoreThruputClient, "waitForTransactionReceipt">,
): (hash: string) => Promise<WriteResult> {
  return async (hash) => {
    let txHash: ReturnType<typeof hashFromBase58> | null = null;
    try {
      txHash = hashFromBase58(hash);
    } catch {
      // Reported below.
    }
    if (txHash === null || toBase58(txHash) !== hash)
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "The stored transaction hash is invalid",
      };
    try {
      return receiptResult(
        await client.waitForTransactionReceipt(txHash, {
          expectedNetworkHash: networkHash(hashFromBase58(config.networkId)),
          timeoutMs: 20_000,
          pollingIntervalMs: 500,
        }),
      );
    } catch (error) {
      return observationFailure(hash, error);
    }
  };
}
