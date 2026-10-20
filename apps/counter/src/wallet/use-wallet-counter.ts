import { useEffect, useRef, useState } from "react";
import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
  TransactionExecutionError,
  type TransactionReceipt,
} from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { gasAmount } from "@thruputchain/protocol";
import {
  contractViewQueryOptions,
  transactionReceiptQueryOptions,
  useClient,
  useExecute,
  useWallet,
  useWalletClient,
  useWaitForTransactionReceipt,
} from "@thruputchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { Counter } from "../contracts/generated/counter";
import type { Direction } from "../transactions/engine";
import {
  loadPending,
  pendingKey,
  savePending,
  type PendingState,
} from "./pending";

export function useWalletCounter(address: string) {
  const client = useClient();
  const wallet = useWalletClient();
  const session = useWallet();
  const queries = useQueryClient();
  const execution = useExecute();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const network = toBase58(client.network.networkHash);
  const key = pendingKey(network, address);
  function readSaved(): PendingState {
    try {
      return loadPending(localStorage, key, network, address);
    } catch {
      return { record: null, error: "Browser storage is unavailable." };
    }
  }
  const [pending, setPending] = useState(readSaved);
  const receipt = useWaitForTransactionReceipt({
    hash: busy ? null : (pending.record?.hash ?? null),
  });
  const blocked =
    busy || execution.isPending || Boolean(pending.record || pending.error);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if ((event.key === key || event.key === null) && !lock.current)
        setPending(readSaved());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);

  function committed(value: TransactionReceipt) {
    queries.setQueryData(
      transactionReceiptQueryOptions({ client, hash: toBase58(value.txHash) })
        .queryKey,
      value,
    );
    void queries.invalidateQueries({
      queryKey: contractViewQueryOptions({
        client,
        method: Counter.v0_1.get,
        contract: addressFromBase58(address),
      }).queryKey,
    });
  }

  // A browser lock prevents two tabs from signing or replacing the one saved record.
  async function exclusive(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (!navigator.locks)
        throw new Error("Wallet updates require browser Web Locks support.");
      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (held) => {
          if (!held)
            throw new Error(
              "Another tab is handling this Counter wallet update.",
            );
          await action();
        },
      );
    } catch (error) {
      if (error instanceof TransactionExecutionError) committed(error.receipt);
      setMessage(
        error instanceof Error ? error.message : "Wallet update failed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function send(direction: Direction) {
    if (blocked) return;
    void exclusive(async () => {
      const saved = readSaved();
      if (saved.record || saved.error) {
        setPending(saved);
        return;
      }
      const result = await execution.mutateAsync({
        request: {
          invocation: Counter.v0_1[direction].invocation(
            addressFromBase58(address),
            gasAmount(500_000n),
            { amount: 1n },
          ),
          gasLimit: gasAmount(1_000_000n),
        },
        options: {
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
          onSigned: async (record) => {
            setPending({ record, error: null });
            try {
              savePending(localStorage, key, record);
            } catch {
              setPending({
                record,
                error:
                  "Cannot save the signed update. Submission was stopped. Retry storage before continuing.",
              });
              throw new Error("Cannot save the signed update.");
            }
          },
        },
      });
      committed(result.receipt);
    });
  }

  function retrySubmission() {
    void exclusive(async () => {
      const record = pending.record;
      if (!record || pending.error || !wallet)
        throw new Error(
          "Reconnect the original wallet account before retrying.",
        );
      if (
        session.address !== record.account.address ||
        session.session?.networkHash !== record.networkHash
      )
        throw new Error(
          "Select the original wallet account and network before retrying.",
        );
      const saved = readSaved();
      if (saved.error || saved.record?.hash !== record.hash)
        throw new Error(
          "Saved state changed. Retry storage before continuing.",
        );
      const existing = await client.getTransactionReceipt(
        hashFromBase58(record.hash),
      );
      if (existing) {
        if (toBase58(existing.txHash) !== record.hash)
          throw new Error("Receipt hash does not match the saved transaction.");
        committed(existing);
        return;
      }
      const signed = parseSignedTransactionHex(record.signedTransaction);
      if (
        (await client.getChainTip()).height >
        signed.tx.uniquifier.block_expiry_height
      )
        throw new Error(
          "The signed update has expired. Check its outcome or export and forget the record; a new transaction will not be created automatically.",
        );
      // Reapproval is explicit. Keep the original nonce, expiry, account and bytes.
      const approved = await wallet.signTransaction(signed.tx);
      if (
        approved.hash !== record.hash ||
        approved.signedTransaction !== record.signedTransaction
      )
        throw new Error("Wallet reapproval changed the original transaction.");
      await wallet.submitTransaction(approved);
      committed(
        await client.waitForTransactionReceipt(hashFromBase58(record.hash), {
          timeoutMs: 20_000,
        }),
      );
    });
  }

  function retryStorage() {
    void exclusive(async () => {
      if (pending.record && pending.error)
        savePending(localStorage, key, pending.record);
      setPending(readSaved());
    });
  }
  function clearRecord() {
    void exclusive(async () => {
      const saved = readSaved();
      if (saved.record && saved.record.hash !== pending.record?.hash) {
        setPending(saved);
        throw new Error(
          "Another transaction is saved. Review it before removing it.",
        );
      }
      localStorage.removeItem(key);
      setPending({ record: null, error: null });
      execution.reset();
    });
  }
  return {
    blocked,
    busy,
    send,
    retrySubmission,
    retryStorage,
    clearRecord,
    pending,
    receipt,
    execution,
    message,
  };
}
