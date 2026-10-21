import {
  parseSignTransactionResult,
  parseWalletAccount,
  parseWalletNetworkHash,
} from "@thruputchain/client/provider";
import type { PendingWalletTransaction } from "@thruputchain/client/wallet";

export interface Pending {
  version: 1;
  label: string;
  record: PendingWalletTransaction;
}

export function loadPending(
  storage: Pick<Storage, "getItem">,
  key: string,
  network: string,
): Pending | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const data = JSON.parse(raw) as Partial<Pending>;
  if (data.version !== 1 || typeof data.label !== "string" || !data.record)
    throw new Error(
      "The saved transaction record is invalid. Preserve it before repairing browser storage.",
    );
  const record = data.record;
  if (parseWalletNetworkHash(record.networkHash) !== network)
    throw new Error("The saved transaction belongs to a different network.");
  return {
    version: 1,
    label: data.label,
    record: {
      ...parseSignTransactionResult({
        signedTransaction: record.signedTransaction,
        hash: record.hash,
      }),
      account: parseWalletAccount(record.account),
      networkHash: record.networkHash,
    },
  };
}

export function savePending(
  storage: Pick<Storage, "setItem">,
  key: string,
  pending: Pending,
) {
  storage.setItem(key, JSON.stringify(pending));
}
