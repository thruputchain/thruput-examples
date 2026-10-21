import { useEffect, useRef, useState } from "react";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
} from "@thruputchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { type Invocation } from "@thruputchain/protocol";
import {
  hashFromBase58,
  serializeSignedTransaction,
  toBase58,
} from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { GAS } from "../contracts/polls";
import { errorMessage, type AppConfig } from "../config";
import { loadPending, savePending, type Pending } from "./pending";

export function useTransaction(config: AppConfig) {
  const client = useClient();
  const execute = useExecute();
  const queries = useQueryClient();
  const key = `voting:v1:${config.networkId}:${toBase58(config.address)}`;
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<string | null>(null);
  const acknowledged = useRef<string | null>(null);
  const lock = useRef(false);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.record.hash ?? null,
  });
  const settled = Boolean(receipt.data && "result" in receipt.data.execution);
  useEffect(() => {
    if (
      busy ||
      storageError ||
      !pending ||
      !receipt.data ||
      !("result" in receipt.data.execution) ||
      receipt.data.execution.result !== "return" ||
      toBase58(receipt.data.transactionHash) !== pending.record.hash ||
      acknowledged.current === pending.record.hash
    )
      return;
    acknowledged.current = pending.record.hash;
    finish();
  }, [busy, storageError, pending, receipt.data]);

  function reload() {
    try {
      setPending(loadPending(localStorage, key, config.networkId));
      setStorageError(false);
    } catch (error) {
      setMessage(errorMessage(error));
      setStorageError(true);
    }
  }
  useEffect(() => {
    reload();
    const changed = (event: StorageEvent) => {
      if ((event.key === key || event.key === null) && !lock.current) reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  useEffect(() => {
    if (receipt.data) void queries.invalidateQueries({ queryKey: ["voting"] });
  }, [receipt.data, queries]);

  async function exclusive(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (!navigator.locks)
        throw new Error(
          "Use a browser with Web Locks support to submit transactions.",
        );
      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (held) => {
          if (!held)
            throw new Error("Another tab is handling a Voting transaction.");
          await action();
        },
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function send(label: string, invocation: Invocation) {
    if (busy || pending || storageError) return;
    setCompleted(null);
    void exclusive(async () => {
      if (loadPending(localStorage, key, config.networkId)) {
        reload();
        return;
      }
      if (toBase58(client.network.networkHash) !== config.networkId)
        throw new Error("Select the application's network.");
      await execute.mutateAsync({
        request: { invocation, gasLimit: GAS },
        options: {
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
          onSigned: (record) => {
            const saved: Pending = { version: 1, label, record };
            setPending(saved);
            try {
              savePending(localStorage, key, saved);
            } catch {
              setStorageError(true);
              throw new Error(
                "Cannot save the signed transaction. Submission stopped; retry storage.",
              );
            }
          },
        },
      });
      void queries.invalidateQueries({ queryKey: ["voting"] });
    });
  }

  function finish() {
    void exclusive(async () => {
      if (
        !settled ||
        !receipt.data ||
        !pending ||
        toBase58(receipt.data.transactionHash) !== pending.record.hash
      )
        return;
      const saved = loadPending(localStorage, key, config.networkId);
      if (saved?.record.hash !== pending.record.hash) {
        reload();
        return;
      }
      localStorage.removeItem(key);
      if (
        "result" in receipt.data.execution &&
        receipt.data.execution.result === "return"
      )
        setCompleted(pending.label);
      setPending(null);
      setStorageError(false);
      void queries.invalidateQueries({ queryKey: ["voting"] });
    });
  }

  function retrySubmission() {
    void exclusive(async () => {
      if (!pending || storageError) return;
      const saved = loadPending(localStorage, key, config.networkId);
      if (saved?.record.hash !== pending.record.hash) {
        reload();
        throw new Error(
          "Saved transaction changed. Check its status before continuing.",
        );
      }
      if (toBase58(client.network.networkHash) !== saved.record.networkHash)
        throw new Error("Select the original transaction's network.");
      const hash = hashFromBase58(saved.record.hash);
      if (await client.getTransactionReceipt({ transactionHash: hash })) {
        await receipt.refetch();
        return;
      }
      const signed = parseSignedTransactionHex(saved.record.signedTransaction);
      if (
        (await client.getChainTip()).blockHeight >
        signed.tx.uniquifier.block_expiry_height
      )
        throw new Error(
          "The signed transaction has expired. Export the record and check its outcome.",
        );
      // Submit only the saved bytes: no new signature, nonce, or expiry.
      await client.sendTransaction({
        signedTransaction: serializeSignedTransaction(signed),
      });
      await receipt.refetch();
    });
  }

  return {
    pending,
    completed,
    dismissConfirmation: () => setCompleted(null),
    busy,
    message,
    storageError,
    receipt,
    settled,
    send,
    finish,
    retrySubmission,
    blocked: busy || Boolean(pending) || storageError,
    confirmed: Boolean(
      receipt.data &&
      "result" in receipt.data.execution &&
      receipt.data.execution.result === "return",
    ),
    retryStorage: () => {
      void exclusive(async () => {
        const saved = loadPending(localStorage, key, config.networkId);
        if (pending && !saved) savePending(localStorage, key, pending);
        reload();
      });
    },
  };
}

export type Transaction = ReturnType<typeof useTransaction>;
