import {
  hashFromBase58,
  toBase58,
  TransactionReceiptTimeoutError,
  NativeRpcError,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  TransactionExecutionError,
  TransactionObservationError,
} from "@thruputchain/client/wallet";
import { networkHash } from "@thruputchain/protocol";
import { isBase58Identifier } from "@/lib/address";
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

// These errors carry evidence that submission was attempted or commitment occurred.
export function executionFailure(error: unknown): WriteResult | undefined {
  if (error instanceof TransactionExecutionError)
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
    if (!isBase58Identifier(hash))
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "The stored transaction hash is invalid",
      };
    try {
      return receiptResult(
        await client.waitForTransactionReceipt(hashFromBase58(hash), {
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
