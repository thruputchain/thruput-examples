import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
  useWallet,
} from "@thruputchain/react";
import { hashFromBase58, toBase58 } from "@thruputchain/client";
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
 * new one on its own. "Check again" looks the hash up. "Retry saved
 * transaction" sends the same signed bytes, which can commit at most once.
 */
export function useTransaction(config: AppConfig) {
  const client = useClient();
  const wallet = useWallet();
  const execute = useExecute();
  const queries = useQueryClient();
  const key = `voting:pending:${config.networkId}:${toBase58(config.address)}`;
  const [pending, setPending] = useState(() => loadPending(key));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });

  function forget() {
    clearPending(key);
    setPending(null);
  }

  useEffect(() => {
    if (!pending || !receipt.data) return;
    forget();
    const execution = receipt.data.execution;
    if ("result" in execution && execution.result === "return")
      setCompleted(pending.label);
    else
      setMessage(
        `${pending.label} committed, but execution failed. No changes were applied.`,
      );
    void queries.invalidateQueries({ queryKey: ["voting"] });
  }, [receipt.data]);

  async function send(label: string, invocation: Invocation) {
    if (busy || pending) return;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    try {
      if (toBase58(client.network.networkHash) !== config.networkId)
        throw new Error("Select the application's network.");
      await execute.mutateAsync({
        request: { invocation, gasLimit: GAS },
        options: {
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
          onSigned: ({ hash, signedTransaction, account, networkHash }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            const saved: Pending = {
              label,
              hash,
              expiresAt: String(block_expiry_height),
              signedTransaction,
              account: account.address,
              networkHash,
            };
            savePending(key, saved);
            setPending(saved);
          },
        },
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!pending) return;
    setMessage(null);
    try {
      const hash = hashFromBase58(pending.hash);
      if (await client.getTransactionReceipt({ transactionHash: hash })) {
        await receipt.refetch();
        return;
      }
      const tip = await client.getChainTip();
      if (tip.blockHeight > BigInt(pending.expiresAt)) {
        forget();
        setMessage(
          `${pending.label} expired without committing. You can send it again.`,
        );
        return;
      }
      await receipt.refetch();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function retry() {
    if (!pending) return;
    setMessage(null);
    try {
      if (!wallet.provider || wallet.address !== pending.account)
        throw new Error("Connect the wallet account that signed it.");
      await wallet.provider.request({
        method: "submitTransaction",
        params: {
          account: pending.account,
          networkHash: pending.networkHash,
          signedTransaction: pending.signedTransaction,
        },
      });
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
    retry,
    dismissConfirmation: () => setCompleted(null),
  };
}

export type Transaction = ReturnType<typeof useTransaction>;
