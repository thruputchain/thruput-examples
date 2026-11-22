/**
 * The record a page saves before the wallet broadcasts a transaction.
 *
 * After a reload, the app observes the same hash instead of signing again.
 * The signed bytes can be sent again safely: they have the same hash, so the
 * transaction commits at most once. `expiresAt` is the last block that can
 * include it: once the chain passes it without a receipt, it can never commit.
 */
export interface Pending {
  label: string;
  hash: string;
  expiresAt: string;
  signedTransaction: string;
  account: string;
  networkHash: string;
}

const fields = [
  "label",
  "hash",
  "expiresAt",
  "signedTransaction",
  "account",
  "networkHash",
] as const;

export function loadPending(key: string): Pending | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
    if (saved && fields.every((field) => typeof saved[field] === "string"))
      return saved as unknown as Pending;
  } catch {
    // Unreadable storage is treated as no saved transaction.
  }
  return null;
}

export function savePending(key: string, pending: Pending) {
  localStorage.setItem(key, JSON.stringify(pending));
}

export function clearPending(key: string) {
  localStorage.removeItem(key);
}
