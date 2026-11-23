import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useClient,
  useWaitForTransactionReceipt,
  useWalletClient,
} from "@thruputchain/react";
import {
  hashFromBase58,
  TransactionExecutionError,
  type TransactionReceipt,
} from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import type { ContractCall } from "@thruputchain/client/contract";
import type { GasAmount } from "@thruputchain/protocol";
import { errorMessage, type AppConfig } from "../config";
import { describeFailure } from "../contracts/drops";

/**
 * One wallet transaction at a time:
 *
 * 1. Build the calls with the generated bindings.
 * 2. In `onSigned`, save the hash and the signed expiry height before the
 *    wallet broadcasts. If saving fails, the wallet does not broadcast.
 * 3. Observe the saved hash, also after a reload. Never resubmit it.
 * 4. Once the chain passes the expiry height without a receipt, the
 *    transaction can never commit: report that and clear the record.
 */
export interface Pending {
  hash: string;
  label: string;
  /** The address the transaction acts on, such as the drop it mints from. */
  target: string;
  /** The last block height at which the transaction can commit. */
  expiry: string;
}

export interface Completed {
  label: string;
  hash: string;
  target: string;
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
      typeof data.label === "string" &&
      "target" in data &&
      typeof data.target === "string" &&
      "expiry" in data &&
      typeof data.expiry === "string" &&
      /^\d+$/.test(data.expiry)
    )
      return {
        kind: "pending",
        pending: {
          hash: data.hash,
          label: data.label,
          target: data.target,
          expiry: data.expiry,
        },
      };
  } catch {
    // Shown to the user below, so they can keep the hash before clearing it.
  }
  return { kind: "unreadable", raw };
}

export function useTransaction(config: AppConfig) {
  const wallet = useWalletClient();
  const client = useClient();
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
  // While a saved transaction has no receipt, watch for its expiry. Past
  // expiry, the receipt read is final: a missing one can never appear.
  const final = useQuery({
    queryKey: ["nft-drop", "expiry", pending?.hash],
    enabled: Boolean(pending) && !busy && !receipt.data,
    refetchInterval: 5_000,
    queryFn: async () => {
      const tip = await client.getChainTip();
      if (tip.blockHeight <= BigInt(pending!.expiry)) return null;
      const receipt = await client.getTransactionReceipt({
        transactionHash: hashFromBase58(pending!.hash),
      });
      return { receipt };
    },
  });

  function finish(
    record: Pending,
    outcome: TransactionReceipt,
    values: unknown[] = [],
  ) {
    localStorage.removeItem(key);
    setSaved({ kind: "none" });
    setMessage(null);
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

  // After a reload or a timeout: settle the saved transaction once its
  // receipt arrives, or once it has expired without one.
  useEffect(() => {
    if (pending && receipt.data) finish(pending, receipt.data);
  }, [receipt.data]);
  useEffect(() => {
    if (!pending || !final.data) return;
    if (final.data.receipt) {
      finish(pending, final.data.receipt);
      return;
    }
    localStorage.removeItem(key);
    setSaved({ kind: "none" });
    setMessage(null);
    setCompleted({
      ...pending,
      ok: false,
      message: `It expired at block ${pending.expiry} without committing. Nothing was sent again.`,
      values: [],
    });
  }, [final.data]);

  async function send(
    label: string,
    target: string,
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
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            const next = {
              hash,
              label,
              target,
              expiry: block_expiry_height.toString(),
            };
            localStorage.setItem(key, JSON.stringify(next));
            // Set only once saved: a failed save means nothing is sent.
            record = next;
            setSaved({ kind: "pending", pending: next });
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
