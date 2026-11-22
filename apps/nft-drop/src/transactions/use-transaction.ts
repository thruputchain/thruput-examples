import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useWaitForTransactionReceipt,
  useWalletClient,
} from "@thruputchain/react";
import {
  TransactionExecutionError,
  type TransactionReceipt,
} from "@thruputchain/client";
import type { ContractCall } from "@thruputchain/client/contract";
import type { GasAmount } from "@thruputchain/protocol";
import { errorMessage, type AppConfig } from "../config";
import { describeFailure } from "../contracts/drops";

/**
 * One wallet transaction at a time:
 *
 * 1. Build the calls with the generated bindings.
 * 2. In `onSigned`, save `{ hash, label }` before the wallet broadcasts. If
 *    saving fails, the wallet does not broadcast.
 * 3. After a reload, observe the saved hash. Never resubmit it.
 */
export interface Pending {
  hash: string;
  label: string;
}

export interface Completed {
  label: string;
  hash: string;
  ok: boolean;
  message: string | null;
  values: unknown[];
}

type Saved =
  | { kind: "none" }
  | { kind: "pending"; pending: Pending }
  | { kind: "unreadable"; raw: string };

function load(key: string): Saved {
  const raw = localStorage.getItem(key);
  if (raw === null) return { kind: "none" };
  try {
    const data: unknown = JSON.parse(raw);
    if (
      data &&
      typeof data === "object" &&
      "hash" in data &&
      typeof data.hash === "string" &&
      "label" in data &&
      typeof data.label === "string"
    )
      return {
        kind: "pending",
        pending: { hash: data.hash, label: data.label },
      };
  } catch {
    // Shown to the user below, so they can keep the hash before clearing it.
  }
  return { kind: "unreadable", raw };
}

export function useTransaction(config: AppConfig) {
  const wallet = useWalletClient();
  const queries = useQueryClient();
  const key = `nft-drop:${config.networkId}:pending`;
  const [saved, setSaved] = useState<Saved>(() => load(key));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const pending = saved.kind === "pending" ? saved.pending : null;
  // While `send` waits for its own receipt, it settles the record itself.
  const receipt = useWaitForTransactionReceipt({
    hash: busy ? null : (pending?.hash ?? null),
  });

  function finish(
    record: Pending,
    outcome: TransactionReceipt,
    values: unknown[] = [],
  ) {
    localStorage.removeItem(key);
    setSaved({ kind: "none" });
    const ok =
      "result" in outcome.execution && outcome.execution.result === "return";
    setCompleted({
      ...record,
      ok,
      message: ok ? null : describeFailure(outcome),
      values,
    });
    void queries.invalidateQueries({ queryKey: ["nft-drop"] });
  }

  // After a reload: settle the saved transaction once its receipt arrives.
  useEffect(() => {
    if (pending && receipt.data) finish(pending, receipt.data);
  }, [receipt.data]);

  async function send(
    label: string,
    calls: readonly ContractCall[],
    gasLimit: GasAmount,
  ) {
    if (busy || saved.kind !== "none") return;
    if (!wallet) {
      setMessage("Connect a wallet first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    let record: Pending | null = null;
    try {
      const result = await wallet.executeCallsAndWait(
        { calls, gasLimit, expiryBlocks: 1_000n },
        {
          onSigned: ({ hash }) => {
            record = { hash, label };
            localStorage.setItem(key, JSON.stringify(record));
            setSaved({ kind: "pending", pending: record });
          },
          wait: { timeoutMs: 30_000, pollingIntervalMs: 500 },
        },
      );
      finish(record!, result.receipt, [...(result.values as unknown[])]);
    } catch (error) {
      if (record && error instanceof TransactionExecutionError)
        finish(record, error.receipt);
      else if (record)
        setMessage(
          "The outcome is not known yet. The app keeps checking the original transaction.",
        );
      else setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return {
    pending,
    unreadable: saved.kind === "unreadable" ? saved.raw : null,
    busy,
    message,
    completed,
    receipt,
    blocked: busy || saved.kind !== "none",
    send,
    dismiss: () => setCompleted(null),
    clearUnreadable: () => {
      localStorage.removeItem(key);
      setSaved({ kind: "none" });
    },
  };
}

export type Transaction = ReturnType<typeof useTransaction>;
