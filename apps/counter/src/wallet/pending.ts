import {
  parseSignTransactionResult,
  parseWalletAccount,
  parseWalletNetworkHash,
} from "@groundhogchain/client/provider";
import type { PendingWalletTransaction } from "@groundhogchain/client/wallet";

export type PendingState = {
  record: PendingWalletTransaction | null;
  error: string | null;
};
export function pendingKey(network: string, contract: string) {
  return `counter-wallet:v1:${network}:${contract}`;
}

export function loadPending(
  storage: Pick<Storage, "getItem">,
  key: string,
  network: string,
): PendingState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { record: null, error: null };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object")
      throw new Error("Invalid saved transaction");
    const data = value as Record<string, unknown>;
    if (data.version !== 1)
      throw new Error("Unsupported saved transaction version");
    const signed = parseSignTransactionResult({
      signedTransaction: data.signedTransaction,
      hash: data.hash,
    });
    const account = parseWalletAccount(data.account);
    const networkHash = parseWalletNetworkHash(data.networkHash);
    if (networkHash !== network)
      throw new Error("Saved transaction belongs to another network");
    return { record: { ...signed, account, networkHash }, error: null };
  } catch (error) {
    return {
      record: null,
      error:
        error instanceof Error
          ? error.message
          : "Cannot read saved transaction",
    };
  }
}

export function savePending(
  storage: Pick<Storage, "setItem">,
  key: string,
  record: PendingWalletTransaction,
) {
  storage.setItem(key, JSON.stringify({ version: 1, ...record }));
}
