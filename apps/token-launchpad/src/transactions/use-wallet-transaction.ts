import { useEffect, useState } from "react";
import {
  useClient,
  useWaitForTransactionReceipt,
  useWallet,
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
 * explains the pattern: after a reload, the app observes the same hash; the
 * same signed bytes can be sent again safely; and once the chain passes
 * `expiresAt` without a receipt, the transaction can never commit.
 */
export interface Pending<T> {
  label: string;
  hash: string;
  expiresAt: string;
  signedTransaction: string;
  account: string;
  networkHash: string;
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
    const fields = ["label", "hash", "expiresAt", "signedTransaction", "account", "networkHash"];
    if (saved && fields.every((field) => typeof saved[field] === "string"))
      return saved as unknown as Pending<T>;
  } catch {
    // Unreadable storage is treated as no saved transaction.
  }
  return null;
}

/**
 * Send one atomic batch of calls through the connected wallet, and survive a
 * reload. `key` names the saved record; use one key per account and network.
 */
export function useWalletTransaction<T>(key: string) {
  const client = useClient();
  const wallet = useWallet();
  const walletClient = useWalletClient();
  const [pending, setPending] = useState(() => load<T>(key));
  const [completed, setCompleted] = useState<Completed<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({
    hash: pending?.hash ?? null,
  });

  function forget() {
    localStorage.removeItem(key);
    setPending(null);
  }

  useEffect(() => {
    if (!pending || !receipt.data) return;
    forget();
    const execution = receipt.data.execution;
    setCompleted({
      label: pending.label,
      context: pending.context,
      receipt: receipt.data,
      succeeded: "result" in execution && execution.result === "return",
    });
  }, [receipt.data]);

  async function send(
    label: string,
    request: { calls: readonly ContractCall[]; contractsToDeploy?: Contract[] },
    context: T,
  ) {
    if (busy || pending) return;
    setBusy(true);
    setMessage(null);
    setCompleted(null);
    try {
      if (!walletClient) throw new Error("Connect a wallet to continue.");
      await walletClient.executeCallsAndWait(
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
          onSigned: ({ hash, signedTransaction, account, networkHash }) => {
            const { block_expiry_height } =
              parseSignedTransactionHex(signedTransaction).tx.uniquifier;
            const saved: Pending<T> = {
              label,
              hash,
              expiresAt: String(block_expiry_height),
              signedTransaction,
              account: account.address,
              networkHash,
              context,
            };
            localStorage.setItem(key, JSON.stringify(saved));
            setPending(saved);
          },
          wait: { timeoutMs: 30_000, pollingIntervalMs: 500 },
        },
      );
    } catch (error) {
      setMessage(userErrorMessage(error, `${label} failed.`));
    } finally {
      setBusy(false);
    }
  }

  /** Look the saved hash up. Never sends anything. */
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
          `${pending.label} expired without committing. You can try again.`,
        );
        return;
      }
      await receipt.refetch();
    } catch (error) {
      setMessage(userErrorMessage(error, "The check failed."));
    }
  }

  /** Send the same signed bytes again. They can commit at most once. */
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
      setMessage(userErrorMessage(error, "The retry failed."));
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
    retry,
    reset: () => {
      setCompleted(null);
      setMessage(null);
    },
  };
}
