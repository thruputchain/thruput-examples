/**
 * The record a page saves before the wallet broadcasts a transaction.
 *
 * After a reload, the app observes the same hash instead of signing again.
 * `expiresAt` is the last block that can include the transaction: once the
 * chain passes it without committing it, it never will.
 */
export interface Pending {
  label: string;
  hash: string;
  expiresAt: string;
}

const fields = ["label", "hash", "expiresAt"] as const;

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
