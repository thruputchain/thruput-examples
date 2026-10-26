import { useEffect, useRef, useState } from "react";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
} from "@thruputchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import {
  parseSignTransactionResult,
  parseWalletAccount,
  parseWalletNetworkHash,
} from "@thruputchain/client/provider";
import type { PendingWalletTransaction } from "@thruputchain/client/wallet";
import { Airdrop } from "./contracts/generated/airdrop";
import type { PublicConfig } from "../shared/config";

export const GAS = gasAmount(20_000_000n);
export function readPending(
  key: string,
  network: string,
): PendingWalletTransaction | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const saved = JSON.parse(raw) as PendingWalletTransaction;
  if (parseWalletNetworkHash(saved.networkHash) !== network)
    throw new Error("Saved claim belongs to another network.");
  return {
    ...parseSignTransactionResult({
      signedTransaction: saved.signedTransaction,
      hash: saved.hash,
    }),
    account: parseWalletAccount(saved.account),
    networkHash: saved.networkHash,
  };
}
export function useClaim(config: PublicConfig) {
  const client = useClient();
  const execute = useExecute();
  const queries = useQueryClient();
  const key = `airdrop:v1:${config.networkId}:${config.anchorHash}:${config.address}`;
  const [pending, setPending] = useState<PendingWalletTransaction | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  function reload() {
    try {
      setPending(readPending(key, config.networkId));
      setReady(true);
    } catch {
      setError(
        "Cannot read saved claim evidence. Restore browser storage before claiming.",
      );
      setReady(false);
    }
  }
  useEffect(() => {
    reload();
    const changed = (event: StorageEvent) => {
      if (!lock.current && (event.key === key || event.key === null)) reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  const receipt = useWaitForTransactionReceipt({ hash: pending?.hash ?? null });
  const settled =
    !!pending &&
    !!receipt.data &&
    toBase58(receipt.data.transactionHash) === pending.hash &&
    "result" in receipt.data.execution;
  useEffect(() => {
    if (settled) void queries.invalidateQueries({ queryKey: ["airdrop"] });
  }, [settled, queries]);
  async function send() {
    if (lock.current || pending || !ready) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!navigator.locks)
        throw new Error("Use a browser with Web Locks support.");
      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (held) => {
          if (!held) throw new Error("Another tab is handling a claim.");
          if (readPending(key, config.networkId)) {
            reload();
            return;
          }
          const anchor = await client.getBlockByHeight({
            blockHeight: BigInt(config.anchorHeight),
          });
          if (!anchor || toBase58(anchor.blockHash) !== config.anchorHash)
            throw new Error(
              "Chain checkpoint changed. Reload after updating the deployment.",
            );
          await execute.mutateAsync({
            request: {
              invocation: Airdrop.v0_1.claim.invocation(
                addressFromBase58(config.address),
                GAS,
              ),
              gasLimit: GAS,
            },
            options: {
              wait: { timeoutMs: 30_000 },
              onSigned(record) {
                // Failure to persist stops broadcast. Never replace uncertain claims.
                localStorage.setItem(key, JSON.stringify(record));
                setPending(record);
              },
            },
          });
          void queries.invalidateQueries({ queryKey: ["airdrop"] });
        },
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Claim failed. Check the original transaction.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function acknowledge() {
    if (!settled || !pending || lock.current) return;
    try {
      await navigator.locks.request(key, async () => {
        if (readPending(key, config.networkId)?.hash !== pending.hash) {
          reload();
          return;
        }
        localStorage.removeItem(key);
        setPending(null);
        setError("");
      });
    } catch {
      setError("Could not update saved claim evidence.");
    }
  }
  return {
    pending,
    error,
    busy,
    blocked: busy || !ready || !!pending,
    receipt,
    settled,
    send,
    acknowledge,
  };
}
