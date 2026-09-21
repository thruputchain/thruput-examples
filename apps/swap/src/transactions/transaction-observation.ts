import {
  hashFromHex,
  toHex0x,
  TransactionReceiptTimeoutError,
  TransactionRejectedError,
  type CoreGroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
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

// These errors carry evidence that submission was attempted or commitment occurred.
export function executionFailure(error: unknown): WriteResult | undefined {
  if (error instanceof TransactionExecutionError)
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
