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
  toBase58,
  type TransactionReceipt,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { Airdrop } from "./contracts/generated/airdrop";
import type { PublicConfig } from "../shared/config";
import { EXPIRY_BLOCKS, readSavedOutcome } from "./saved-outcome";

export const GAS = gasAmount(20_000_000n);

/**
 * The claim saved before broadcast. The Voting app explains the pattern:
 * `expiresAt` is the last block that can include the transaction.
 */
export interface PendingClaim {
  hash: string;
  expiresAt: string;
}

const fields = ["hash", "expiresAt"] as const;

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
 * new claim on its own. "Check again" looks the hash up.
 */
export function useClaim(config: PublicConfig) {
  const client = useClient();
  const wallet = useWallet();
  const execute = useExecute();
  const queries = useQueryClient();
  // One record per account: another account is not blocked by this one's.
  const key = `airdrop:pending:${config.networkId}:${config.anchorHash}:${config.address}:${wallet.address ?? "none"}`;
  const [pending, setPending] = useState(() => readPending(key));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // A ref, not state: a second click before the next render must see it.
  const sending = useRef(false);
  // The hash already reported: the receipt arrives from `send` and from the
  // receipt query.
  const reported = useRef<string | null>(null);
  // The account whose claim the page shows now. A claim can finish after the
  // user switched accounts.
  const shownKey = useRef(key);
  shownKey.current = key;
  const receipt = useWaitForTransactionReceipt({ hash: pending?.hash ?? null });

  useEffect(() => setPending(readPending(key)), [key]);

  /** Clear one record, and the page only if it still shows that record. */
  function forget(savedKey: string, saved: PendingClaim) {
    localStorage.removeItem(savedKey);
    setPending((shown) => (shown?.hash === saved.hash ? null : shown));
  }

  function finish(
    savedKey: string,
    saved: PendingClaim,
    transactionReceipt: TransactionReceipt,
  ) {
    if (reported.current === saved.hash) return;
    reported.current = saved.hash;
    forget(savedKey, saved);
    void queries.invalidateQueries({ queryKey: ["airdrop"] });
    if (savedKey !== shownKey.current) return;
    const execution = transactionReceipt.execution;
    setMessage(
      "result" in execution && execution.result === "return"
        ? "Claim confirmed."
        : "The claim committed, but execution failed. No tokens moved.",
    );
  }

  useEffect(() => {
    if (pending && receipt.data) finish(key, pending, receipt.data);
  }, [receipt.data]);

  async function send() {
    if (sending.current || pending) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    let saved: PendingClaim | null = null;
    // The account that signs. The user can switch before the receipt arrives.
    const savedKey = key;
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
      const result = await execute.mutateAsync({
        request: {
          invocation: Airdrop.v0_1.claim.invocation(
            addressFromBase58(config.address),
            GAS,
          ),
          gasLimit: GAS,
          expiryBlocks: EXPIRY_BLOCKS,
        },
        options: {
          wait: { timeoutMs: 30_000 },
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            saved = { hash, expiresAt: String(block_expiry_height) };
            localStorage.setItem(savedKey, JSON.stringify(saved));
            setPending(saved);
          },
        },
      });
      if (saved) finish(savedKey, saved, result.receipt);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Claim failed.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  /**
   * Look the saved hash up. Never sends anything. The Voting app's
   * `checkAgain` and `readSavedOutcome` explain the order of the reads.
   */
  async function checkAgain() {
    if (!pending) return;
    setError("");
    try {
      const expiresAt = BigInt(pending.expiresAt);
      const outcome = await readSavedOutcome(client, pending.hash, expiresAt);
      if (outcome === "observe") {
        await receipt.refetch();
        return;
      }
      if (outcome === "notIndexed") {
        setMessage(
          `The node has not indexed block ${expiresAt} yet, so it cannot tell whether the claim committed. Check again shortly.`,
        );
        return;
      }
      forget(key, pending);
      setMessage(
        outcome === "expired"
          ? `The claim expired without committing (${pending.hash}). You can claim again.`
          : `The node no longer keeps the blocks that could hold the claim (${pending.hash}). Look it up in an explorer before you claim again.`,
      );
      void queries.invalidateQueries({ queryKey: ["airdrop"] });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check failed.");
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
  };
}
