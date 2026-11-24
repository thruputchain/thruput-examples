import { useEffect, useRef, useState } from "react";
import {
  useClient,
  useWaitForTransactionReceipt,
  useWalletClient,
} from "@thruputchain/react";
import {
  hashFromBase58,
  type ContractCall,
  type TransactionReceipt,
} from "@thruputchain/client";
import { parseSignedTransactionHex } from "@thruputchain/client/provider";
import { walletGasLimit } from "@thruputchain/client/wallet";
import { gasAmount, type Contract } from "@thruputchain/protocol";
import { userErrorMessage } from "@/lib/errors";

/**
 * The record saved before the wallet broadcasts a transaction. The Voting app
 * explains the pattern: after a reload, the app observes the same hash, and
 * once the chain passes `expiresAt` without committing it, the transaction
 * never will.
 */
export interface Pending<T> {
  label: string;
  hash: string;
  expiresAt: string;
  /** What the page needs to show the result after a reload. */
  context: T;
}

export interface Completed<T> {
  label: string;
  context: T;
  receipt: TransactionReceipt;
  succeeded: boolean;
}

function load<T>(key: string): Pending<T> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
    const fields = ["label", "hash", "expiresAt"];
    if (saved && fields.every((field) => typeof saved[field] === "string"))
      return saved as unknown as Pending<T>;
  } catch {
    // Unreadable storage is treated as no saved transaction.
  }
  return null;
}

/** The calls of one atomic batch, and any contract code it deploys. */
export interface WalletRequest {
  calls: readonly ContractCall[];
  contractsToDeploy?: Contract[];
}

/**
 * Send one atomic batch of calls through the connected wallet, and survive a
 * reload. `key` names the saved record; use one key per account and network.
 * `onDone` runs once per transaction, when its receipt arrives.
 */
export function useWalletTransaction<T>(
  key: string,
  onDone?: (completed: Completed<T>) => void,
) {
  const client = useClient();
  const walletClient = useWalletClient();
  const [pending, setPending] = useState(() => load<T>(key));
  const [completed, setCompleted] = useState<Completed<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A ref, not state: a second click before the next render must see it.
  const sending = useRef(false);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });
  const done = useRef<{ hash: string | null; onDone: typeof onDone }>({
    hash: null,
    onDone,
  });
  done.current.onDone = onDone;

  function forget() {
    localStorage.removeItem(key);
    setPending(null);
  }

  // The same receipt can arrive from `send` and from the receipt query.
  function finish(saved: Pending<T>, transactionReceipt: TransactionReceipt) {
    if (done.current.hash === saved.hash) return;
    done.current.hash = saved.hash;
    forget();
    const execution = transactionReceipt.execution;
    const result: Completed<T> = {
      label: saved.label,
      context: saved.context,
      receipt: transactionReceipt,
      succeeded: "result" in execution && execution.result === "return",
    };
    setCompleted(result);
    done.current.onDone?.(result);
  }

  useEffect(() => {
    if (pending && receipt.data) finish(pending, receipt.data);
  }, [receipt.data]);

  /**
   * `build` returns the calls. It runs after the lock is taken, so reads it
   * makes (allowances, artifacts) cannot let a second click through.
   */
  async function send(
    label: string,
    build: () => WalletRequest | Promise<WalletRequest>,
    context: T,
  ) {
    if (sending.current || pending) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    let saved: Pending<T> | null = null;
    try {
      if (!walletClient) throw new Error("Connect a wallet to continue.");
      const request = await build();
      const result = await walletClient.executeCallsAndWait(
        {
          calls: request.calls,
          // The calls' own gas, plus the wallet's work around them.
          gasLimit: gasAmount(
            walletGasLimit(
              request.calls.map((call) => call.invocation),
              gasAmount(2_000_000n),
            ),
          ),
          expiryBlocks: 1_000n,
          ...(request.contractsToDeploy
            ? { contractsToDeploy: request.contractsToDeploy }
            : {}),
        },
        {
          // The SDK waits for this before the wallet broadcasts.
          onSigned: ({ hash, signedTransaction }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            saved = {
              label,
              hash,
              expiresAt: String(block_expiry_height),
              context,
            };
            localStorage.setItem(key, JSON.stringify(saved));
            setPending(saved);
          },
          wait: { timeoutMs: 30_000, pollingIntervalMs: 500 },
        },
      );
      if (saved) finish(saved, result.receipt);
    } catch (error) {
      setMessage(userErrorMessage(error, `${label} failed.`));
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
          `${pending.label} expired without committing (${pending.hash}). You can try again.`,
        );
        return;
      }
      await receipt.refetch();
    } catch (error) {
      setMessage(userErrorMessage(error, "The check failed."));
    }
  }

  return {
    pending,
    completed,
    busy,
    message,
    waitTimedOut: Boolean(receipt.error),
    blocked: busy || Boolean(pending),
    send,
    checkAgain,
    reset: () => {
      setCompleted(null);
      setMessage(null);
    },
  };
}
