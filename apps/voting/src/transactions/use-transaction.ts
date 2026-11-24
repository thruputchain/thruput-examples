import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
  useWallet,
} from "@thruputchain/react";
import {
  hashFromBase58,
  toBase58,
  type TransactionReceipt,
} from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import type { Invocation } from "@thruputchain/protocol";
import { GAS } from "../contracts/polls";
import { errorMessage, type AppConfig } from "../config";
import {
  clearPending,
  loadPending,
  savePending,
  type Pending,
} from "./pending";

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
  // A ref, not state: a second click before the next render must see it.
  const sending = useRef(false);
  // The hash already reported: the receipt arrives from `send` and from the
  // receipt query.
  const reported = useRef<string | null>(null);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });

  useEffect(() => setPending(loadPending(key)), [key]);

  function forget() {
    clearPending(key);
    setPending(null);
  }

  function finish(saved: Pending, transactionReceipt: TransactionReceipt) {
    if (reported.current === saved.hash) return;
    reported.current = saved.hash;
    forget();
    const execution = transactionReceipt.execution;
    if ("result" in execution && execution.result === "return")
      setCompleted(saved.label);
    else
      setMessage(
        `${saved.label} committed, but execution failed. No changes were applied.`,
      );
    void queries.invalidateQueries({ queryKey: ["voting"] });
  }

  useEffect(() => {
    if (pending && receipt.data) finish(pending, receipt.data);
  }, [receipt.data]);

  async function send(label: string, invocation: Invocation) {
    if (sending.current || pending) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    let saved: Pending | null = null;
    try {
      if (toBase58(client.network.networkHash) !== config.networkId)
        throw new Error("Select the application's network.");
      const result = await execute.mutateAsync({
        request: { invocation, gasLimit: GAS },
        options: {
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            saved = { label, hash, expiresAt: String(block_expiry_height) };
            savePending(key, saved);
            setPending(saved);
          },
        },
      });
      if (saved) finish(saved, result.receipt);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  /**
   * Look the saved hash up. Never sends anything.
   *
   * Read the tip first. The transaction cannot commit after `expiresAt`, so if
   * the tip is past it and the node then reports no commitment, it never will.
   * Read in the other order, a commit between the two reads looks like expiry.
   * The status reports a recent commit before its receipt is indexed; the
   * receipt covers an older one.
   */
  async function checkAgain() {
    if (!pending) return;
    setMessage(null);
    try {
      const transactionHash = hashFromBase58(pending.hash);
      const tip = await client.getChainTip();
      const status = await client.getTransactionStatus({ transactionHash });
      const committed =
        ("status" in status && status.status === "committed") ||
        (await client.getTransactionReceipt({ transactionHash })) !== null;
      if (!committed && tip.blockHeight > BigInt(pending.expiresAt)) {
        forget();
        setMessage(
          `${pending.label} expired without committing (${pending.hash}). You can send it again.`,
        );
        return;
      }
      await receipt.refetch();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return {
    pending,
    busy,
    message,
    completed,
    waitTimedOut: Boolean(receipt.error),
    blocked: busy || Boolean(pending),
    send,
    checkAgain,
    dismissConfirmation: () => setCompleted(null),
  };
}

export type Transaction = ReturnType<typeof useTransaction>;
