import { useEffect, useRef, useState } from "react";
import {
  useClient,
  useExecute,
  useWaitForTransactionReceipt,
  useWallet,
} from "@thruputchain/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import {
  parseSignTransactionResult,
  parseWalletAccount,
  parseWalletNetworkHash,
  parseSignedTransactionHex,
  parseWalletSession,
  parseSubmitTransactionResult,
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
  const wallet = useWallet();
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  const execute = useExecute();
  const queries = useQueryClient();
  const key = `airdrop:v1:${config.networkId}:${config.anchorHash}:${config.address}`;
  const [pending, setPending] = useState<PendingWalletTransaction | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
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
  async function recover(retry: boolean) {
    if (!pending || lock.current || !ready) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await navigator.locks.request(key, async () => {
        const saved = readPending(key, config.networkId);
        if (!saved || saved.hash !== pending.hash) {
          reload();
          return;
        }
        const anchor = await client.getBlockByHeight({
          blockHeight: BigInt(config.anchorHeight),
        });
        if (!anchor || toBase58(anchor.blockHash) !== config.anchorHash)
          throw new Error(
            "Chain checkpoint changed. Preserve the saved transaction.",
          );
        const signed = parseSignedTransactionHex(saved.signedTransaction);
        const tip = await client.getChainTip();
        if (
          await client.getTransactionReceipt({
            transactionHash: hashFromBase58(saved.hash),
          })
        ) {
          await receipt.refetch();
          return;
        }
        if (tip.blockHeight > signed.tx.uniquifier.block_expiry_height) {
          // A view at or beyond expiry establishes the final claim state even
          // when no receipt exists. Failed or lagging reads preserve evidence.
          const claimed = await Airdrop.v0_1.hasClaimed.view({
            client,
            address: addressFromBase58(config.address),
            args: { address: addressFromBase58(saved.account.address) },
            minStateBlockHeight: tip.blockHeight,
          });
          localStorage.removeItem(key);
          setPending(null);
          setRecoveryMessage(
            claimed.value
              ? "This wallet has already claimed. The expired transaction record is cleared."
              : "The transaction expired without a claim. You can submit a new claim.",
          );
          await queries.invalidateQueries({ queryKey: ["airdrop"] });
          return;
        }
        if (!retry)
          throw new Error(
            "The transaction has not expired. Check again later or retry the saved transaction.",
          );
        const selected = currentWallet.current;
        const provider = selected.provider;
        if (
          !provider ||
          selected.status !== "connected" ||
          selected.address !== saved.account.address
        )
          throw new Error("Connect the original claim's wallet account.");
        let changed = false;
        const unsubscribe = provider.on("change", () => {
          changed = true;
        });
        try {
          const session = parseWalletSession(
            await provider.request({ method: "getSession" }),
          );
          if (
            changed ||
            currentWallet.current.provider !== provider ||
            currentWallet.current.address !== saved.account.address ||
            currentWallet.current.status !== "connected" ||
            session.networkHash !== saved.networkHash ||
            !session.accounts.some(
              (a) =>
                a.address === saved.account.address &&
                a.publicKey === saved.account.publicKey &&
                a.nonce === saved.account.nonce,
            )
          )
            throw new Error("Select the original claim's account and network.");
          const result = parseSubmitTransactionResult(
            await provider.request({
              method: "submitTransaction",
              params: {
                account: saved.account.address,
                networkHash: saved.networkHash,
                signedTransaction: saved.signedTransaction,
              },
            }),
          );
          if (result.hash !== saved.hash)
            throw new Error(
              "Wallet returned a different hash. Preserve the saved transaction.",
            );
        } finally {
          unsubscribe();
        }
        await receipt.refetch();
      });
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not recover the claim.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
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
    recover,
    recoveryMessage,
  };
}
