import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
  useWallet,
} from "@thruputchain/react";
import { toBase58, type TransactionReceipt } from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import type { Invocation } from "@thruputchain/protocol";
import { GAS } from "../contracts/polls";
import { errorMessage, type AppConfig } from "../config";
import { clearPending, loadPending, savePending, type Pending } from "./pending";
import { EXPIRY_BLOCKS, readSavedOutcome } from "./saved-outcome";

/**
 * Send one wallet transaction at a time, and survive a reload.
 *
 * 1. The wallet signs the invocation.
 * 2. `onSigned` saves the hash before the wallet broadcasts it.
 * 3. The receipt query watches that hash, also after a reload.
 * 4. When the receipt arrives, the saved record is cleared.
 *
 * A timeout does not mean the transaction failed, so the app never signs a
 * new one on its own. "Check again" looks the hash up. Once the chain passes
 * the transaction's expiry height without committing it, the user can send
 * again.
 */
export function useTransaction(config: AppConfig) {
  const client = useClient();
  const wallet = useWallet();
  const execute = useExecute();
  const queries = useQueryClient();
  // One record per account: another account is not blocked by this one's.
  const key = `voting:pending:${config.networkId}:${toBase58(config.address)}:${wallet.address ?? "none"}`;
  const [pending, setPending] = useState(() => loadPending(key));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  // Refs, not state: a second click before the next render must see them.
  const sending = useRef(false);
  const checking = useRef(false);
  // The node cannot tell whether the saved transaction committed.
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  // The hash already reported: the receipt arrives from `send` and from the
  // receipt query.
  const reported = useRef<string | null>(null);
  // The account whose record the page shows now. A transaction can finish
  // after the user switched accounts.
  const shownKey = useRef(key);
  shownKey.current = key;
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });

  useEffect(() => setPending(loadPending(key)), [key]);

  /**
   * Clear one record, and only that record: the user can switch accounts, or
   * sign a newer transaction, before a receipt or a slow check comes back.
   */
  function forget(savedKey: string, saved: Pending) {
    if (loadPending(savedKey)?.hash === saved.hash) clearPending(savedKey);
    setPending((shown) => (shown?.hash === saved.hash ? null : shown));
    setUnknownOutcome(false);
  }

  function finish(
    savedKey: string,
    saved: Pending,
    transactionReceipt: TransactionReceipt,
  ) {
    if (reported.current === saved.hash) return;
    reported.current = saved.hash;
    forget(savedKey, saved);
    void queries.invalidateQueries({ queryKey: ["voting"] });
    if (savedKey !== shownKey.current) return;
    const execution = transactionReceipt.execution;
    if ("result" in execution && execution.result === "return")
      setCompleted(saved.label);
    else
      setMessage(
        `${saved.label} committed, but execution failed. No changes were applied.`,
      );
  }

  useEffect(() => {
    if (pending && receipt.data) finish(key, pending, receipt.data);
  }, [receipt.data]);

  async function send(label: string, invocation: Invocation) {
    if (sending.current || pending) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    let saved: Pending | null = null;
    // The account that signs. The user can switch before the receipt arrives.
    const savedKey = key;
    try {
      if (toBase58(client.network.networkHash) !== config.networkId)
        throw new Error("Select the application's network.");
      const result = await execute.mutateAsync({
        request: { invocation, gasLimit: GAS, expiryBlocks: EXPIRY_BLOCKS },
        options: {
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            saved = { label, hash, expiresAt: String(block_expiry_height) };
            savePending(savedKey, saved);
            setPending(saved);
          },
        },
      });
      if (saved) finish(savedKey, saved, result.receipt);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  /** Look the saved hash up. Never sends anything. One check runs at a time. */
  async function checkAgain() {
    if (!pending || checking.current) return;
    checking.current = true;
    const checked = pending;
    const checkedKey = key;
    setMessage(null);
    try {
      const expiresAt = BigInt(checked.expiresAt);
      const outcome = await readSavedOutcome(client, checked.hash, expiresAt);
      if (outcome === "observe") {
        await receipt.refetch();
      } else if (outcome === "notIndexed") {
        setMessage(
          `The node has not indexed block ${expiresAt} yet, so it cannot tell whether ${checked.label} committed. Check again shortly.`,
        );
      } else if (outcome === "unknown") {
        // It may have committed: keep the record until the user decides.
        setUnknownOutcome(true);
        setMessage(
          `The node no longer keeps the blocks that could hold ${checked.label}, so it cannot tell whether it committed. Look up ${checked.hash} in an explorer. If it did not commit, forget it and send again.`,
        );
      } else {
        forget(checkedKey, checked);
        setMessage(
          `${checked.label} expired without committing (${checked.hash}). You can send it again.`,
        );
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      checking.current = false;
    }
  }

  /** Clear a record whose outcome the node cannot tell, after the user looked it up. */
  function forgetUnknown() {
    if (!pending || !unknownOutcome) return;
    forget(key, pending);
    setMessage(null);
  }

  return {
    pending,
    busy,
    message,
    completed,
    waitTimedOut: Boolean(receipt.error),
    blocked: busy || Boolean(pending),
    unknownOutcome,
    send,
    checkAgain,
    forgetUnknown,
    dismissConfirmation: () => setCompleted(null),
  };
}

export type Transaction = ReturnType<typeof useTransaction>;
