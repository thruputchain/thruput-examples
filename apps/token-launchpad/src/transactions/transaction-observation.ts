import {
  hashFromBase58,
  toBase58,
  TransactionReceiptTimeoutError,
  NativeRpcError,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  TransactionExecutionError,
  TransactionObservationError,
} from "@thruputchain/client/wallet";
import { networkHash } from "@thruputchain/protocol";
import type { WriteResult } from "./write-boundary";

export function receiptResult(receipt: TransactionReceipt): WriteResult {
  if (!("result" in receipt.execution))
    return {
      kind: "indeterminate",
      hash: toBase58(receipt.transactionHash),
      reason: "other",
    };
  return {
    kind:
      receipt.execution.result === "return"
        ? "committedSuccess"
        : "committedFailure",
    hash: toBase58(receipt.transactionHash),
    receipt,
  };
}

export function observationFailure(hash: string, error: unknown): WriteResult {
  if (
    error instanceof NativeRpcError &&
    error.decoded.classification === "known" &&
    error.decoded.data.kind === "transactionInvalid"
  )
    return { kind: "invalid", hash, reason: error.rpcMessage };
  if (error instanceof TransactionReceiptTimeoutError) {
    const status =
      error.lastStatus && "status" in error.lastStatus
        ? error.lastStatus.status
        : undefined;
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
    return observationFailure(toBase58(error.transactionHash), error.cause);
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
