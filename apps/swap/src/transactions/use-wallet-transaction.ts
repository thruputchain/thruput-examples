import { useEffect, useRef, useState } from "react";
import {
  useClient,
  useWaitForTransactionReceipt,
  useWalletClient,
} from "@thruputchain/react";
import { type ContractCall, type TransactionReceipt } from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { walletGasLimit } from "@thruputchain/client/wallet";
import { gasAmount, type Contract } from "@thruputchain/protocol";
import { userErrorMessage } from "@/lib/errors";
import { EXPIRY_BLOCKS, readSavedOutcome } from "./saved-outcome";
import { readRecord, useRecord, writeRecord } from "./saved-record";

/**
 * The record saved before the wallet broadcasts a transaction. The Voting app
 * explains the pattern: after a reload, the app observes the same hash, and
 * once the chain passes `expiresAt` without committing it, the transaction
 * never will.
 */
export interface Pending<T> {
  label: string;
  hash: string;
  expiresAt: string;
  /** What the page needs to show the result after a reload. */
  context: T;
}

export interface Completed<T> {
  label: string;
  context: T;
  receipt: TransactionReceipt;
  succeeded: boolean;
}

function parsePending<T>(value: unknown): Pending<T> | null {
  const saved = value as Record<string, unknown> | null;
  const fields = ["label", "hash", "expiresAt"];
  return saved && fields.every((field) => typeof saved[field] === "string")
    ? (saved as unknown as Pending<T>)
    : null;
}

/** The calls of one atomic batch, and any contract code it deploys. */
export interface WalletRequest {
  calls: readonly ContractCall[];
  contractsToDeploy?: Contract[];
}

/**
 * Send one atomic batch of calls through the connected wallet, and survive a
 * reload. `key` names the saved record; use one key per account and network.
 * `onDone` runs once per transaction, when its receipt arrives.
 */
export function useWalletTransaction<T>(
  key: string,
  onDone?: (completed: Completed<T>) => void,
) {
  const client = useClient();
  const walletClient = useWalletClient();
  // Read from storage, so every copy of this hook shows the same record.
  const pending = useRecord(key, parsePending<T>);
  const [completed, setCompleted] = useState<Completed<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Refs, not state: a second click before the next render must see them.
  const sending = useRef(false);
  const checking = useRef(false);
  // The hash of a saved transaction whose outcome the node cannot tell. A
  // hash, not a flag, so it never applies to another record.
  const [unknownHash, setUnknownHash] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });
  const done = useRef<{ hash: string | null; onDone: typeof onDone }>({
    hash: null,
    onDone,
  });
  done.current.onDone = onDone;
  // Only the copy on screen reports a transaction. A copy unmounted by an
  // account switch leaves the record, and the copy on screen reports it from
  // its receipt.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Clear one record, and only that record: a slow check must not clear a
   * transaction the user signed after it started.
   */
  function forget(saved: Pending<T>) {
    if (parsePending<T>(readRecord(key))?.hash === saved.hash) writeRecord(key, null);
  }

  // The same receipt can arrive from `send` and from the receipt query. The
  // saved record says it is not reported yet: reporting clears it, and a
  // newer transaction replaces it.
  function finish(saved: Pending<T>, transactionReceipt: TransactionReceipt) {
    if (!mounted.current || done.current.hash === saved.hash) return;
    if (parsePending<T>(readRecord(key))?.hash !== saved.hash) return;
    const execution = transactionReceipt.execution;
    const result: Completed<T> = {
      label: saved.label,
      context: saved.context,
      receipt: transactionReceipt,
      succeeded: "result" in execution && execution.result === "return",
    };
    // Report first: `onDone` can save a record of its own, such as Swap's
    // queued request. If that fails, keep this one, so a reload can recover.
    try {
      done.current.onDone?.(result);
    } catch (error) {
      setMessage(userErrorMessage(error, `${saved.label} committed, but saving its result failed.`));
      return;
    }
    done.current.hash = saved.hash;
    forget(saved);
    setCompleted(result);
  }

  useEffect(() => {
    if (pending && receipt.data) finish(pending, receipt.data);
  }, [receipt.data]);

  /**
   * `build` returns the calls. It runs after the lock is taken, so reads it
   * makes (allowances, artifacts) cannot let a second click through.
   */
  async function send(
    label: string,
    build: () => WalletRequest | Promise<WalletRequest>,
    context: T,
  ) {
    if (sending.current || pending) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    let saved: Pending<T> | null = null;
    try {
      if (!walletClient) throw new Error("Connect a wallet to continue.");
      const request = await build();
      const result = await walletClient.executeCallsAndWait(
        {
          calls: request.calls,
          // The calls' own gas, plus the wallet's work around them.
          gasLimit: gasAmount(
            walletGasLimit(
              request.calls.map((call) => call.invocation),
              gasAmount(2_000_000n),
            ),
          ),
          expiryBlocks: EXPIRY_BLOCKS,
          ...(request.contractsToDeploy
            ? { contractsToDeploy: request.contractsToDeploy }
            : {}),
        },
        {
          // The SDK waits for this before the wallet broadcasts.
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            saved = {
              label,
              hash,
              expiresAt: String(block_expiry_height),
              context,
            };
            writeRecord(key, saved);
          },
          wait: { timeoutMs: 30_000, pollingIntervalMs: 500 },
        },
      );
      if (saved) finish(saved, result.receipt);
    } catch (error) {
      setMessage(userErrorMessage(error, `${label} failed.`));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  /**
   * Look the saved hash up. Never sends anything. The Voting app's
   * `checkAgain` and `readSavedOutcome` explain the order of the reads.
   */
  async function checkAgain() {
    if (!pending || checking.current) return;
    checking.current = true;
    const checked = pending;
    setMessage(null);
    try {
      const expiresAt = BigInt(checked.expiresAt);
      const outcome = await readSavedOutcome(client, checked.hash, expiresAt);
      // The page may show another record by now: report only on this one.
      if (parsePending<T>(readRecord(key))?.hash !== checked.hash) return;
      if (outcome === "observe") {
        await receipt.refetch();
      } else if (outcome === "notIndexed") {
        setMessage(
          `The node has not indexed block ${expiresAt} yet, so it cannot tell whether ${checked.label} committed. Check again shortly.`,
        );
      } else if (outcome === "unknown") {
        // It may have committed: keep the record until the user decides.
        setUnknownHash(checked.hash);
        setMessage(
          `The node no longer keeps the blocks that could hold ${checked.label}, so it cannot tell whether it committed. Look up ${checked.hash} in an explorer. If it did not commit, forget it and try again.`,
        );
      } else {
        forget(checked);
        setMessage(
          `${checked.label} expired without committing (${checked.hash}). You can try again.`,
        );
      }
    } catch (error) {
      setMessage(userErrorMessage(error, "The check failed."));
    } finally {
      checking.current = false;
    }
  }

  /** Clear a record whose outcome the node cannot tell, after the user looked it up. */
  function forgetUnknown() {
    if (!pending || pending.hash !== unknownHash) return;
    forget(pending);
    setMessage(null);
  }

  return {
    pending,
    completed,
    busy,
    message,
    waitTimedOut: Boolean(receipt.error),
    blocked: busy || Boolean(pending),
    unknownOutcome: pending !== null && pending.hash === unknownHash,
    send,
    checkAgain,
    forgetUnknown,
    reset: () => {
      setCompleted(null);
      setMessage(null);
    },
  };
}
