import { expect, it } from "vitest";
import type { Transaction } from "./engine";
import { mergeHistory } from "./history";

it("orders updates across signer switches and keeps recovered updates", () => {
  const transaction = (id: number, createdAt: number): Transaction => ({
    id,
    createdAt,
    direction: "increment",
    state: "confirmed",
    hash: null,
    message: null,
  });
  const wallet = [transaction(3, 40), transaction(2, 20), transaction(1, 0)];
  const development = [transaction(2, 30), transaction(1, 10)];
  const recent = mergeHistory(wallet, development);
  expect(recent.map(({ createdAt }) => createdAt)).toEqual([40, 30, 20, 10, 0]);
  expect(new Set(recent.map(({ id }) => id)).size).toBe(5);
  expect(wallet.map(({ id }) => id)).toEqual([3, 2, 1]);
  expect(development.map(({ id }) => id)).toEqual([2, 1]);
});
