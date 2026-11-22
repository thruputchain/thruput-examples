import { useEffect, useState } from "react";
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
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { Airdrop } from "./contracts/generated/airdrop";
import type { PublicConfig } from "../shared/config";

export const GAS = gasAmount(20_000_000n);

/**
 * The claim saved before broadcast. The Voting app explains the pattern: the
 * same signed bytes can be sent again safely, and `expiresAt` is the last
 * block that can include the transaction.
 */
export interface PendingClaim {
  hash: string;
  expiresAt: string;
  signedTransaction: string;
  account: string;
  networkHash: string;
}

const fields = [
  "hash",
  "expiresAt",
  "signedTransaction",
  "account",
  "networkHash",
] as const;

export function readPending(key: string): PendingClaim | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
    if (saved && fields.every((field) => typeof saved[field] === "string"))
      return saved as unknown as PendingClaim;
  } catch {
    // Unreadable storage is treated as no saved claim.
  }
  return null;
}

/**
 * Claim once per wallet, and survive a reload.
 *
 * The hash is saved in `onSigned`, before the wallet broadcasts. After a
 * reload, the receipt query watches the same hash. The app never signs a
 * new claim on its own. "Check again" looks the hash up, and "Retry saved
 * transaction" sends the same signed bytes.
 */
export function useClaim(config: PublicConfig) {
  const client = useClient();
  const wallet = useWallet();
  const execute = useExecute();
  const queries = useQueryClient();
  const key = `airdrop:pending:${config.networkId}:${config.anchorHash}:${config.address}`;
  const [pending, setPending] = useState(() => readPending(key));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const receipt = useWaitForTransactionReceipt({ hash: pending?.hash ?? null });

  function forget() {
    localStorage.removeItem(key);
    setPending(null);
  }

  useEffect(() => {
    if (!pending || !receipt.data) return;
    forget();
    const execution = receipt.data.execution;
    setMessage(
      "result" in execution && execution.result === "return"
        ? "Claim confirmed."
        : "The claim committed, but execution failed. No tokens moved.",
    );
    void queries.invalidateQueries({ queryKey: ["airdrop"] });
  }, [receipt.data]);

  async function send() {
    if (busy || pending) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // The deployment is tied to one chain history. A reset devnet has a
      // different block at this height.
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
          onSigned: ({ hash, signedTransaction, account, networkHash }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            const saved: PendingClaim = {
              hash,
              expiresAt: String(block_expiry_height),
              signedTransaction,
              account: account.address,
              networkHash,
            };
            localStorage.setItem(key, JSON.stringify(saved));
            setPending(saved);
          },
        },
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!pending) return;
    setError("");
    try {
      const hash = hashFromBase58(pending.hash);
      if (await client.getTransactionReceipt({ transactionHash: hash })) {
        await receipt.refetch();
        return;
      }
      const tip = await client.getChainTip();
      if (tip.blockHeight > BigInt(pending.expiresAt)) {
        forget();
        setMessage("The claim expired without committing. You can claim again.");
        void queries.invalidateQueries({ queryKey: ["airdrop"] });
        return;
      }
      await receipt.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check failed.");
    }
  }

  async function retry() {
    if (!pending) return;
    setError("");
    try {
      if (!wallet.provider || wallet.address !== pending.account)
        throw new Error("Connect the wallet account that signed the claim.");
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
      setError(error instanceof Error ? error.message : "Retry failed.");
    }
  }

  return {
    pending,
    busy,
    error,
    message,
    waitTimedOut: Boolean(receipt.error),
    blocked: busy || Boolean(pending),
    send,
    checkAgain,
    retry,
  };
}
