import type { Transaction } from "./engine";

export function mergeHistory(
  wallet: Transaction[],
  development: Transaction[],
): Transaction[] {
  return [
    ...wallet.map((transaction) => ({ ...transaction, id: -transaction.id })),
    ...development,
  ].sort((a, b) => b.createdAt - a.createdAt);
}
