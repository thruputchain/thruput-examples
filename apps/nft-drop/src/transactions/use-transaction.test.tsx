// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contractAddress } from "@thruputchain/protocol";
import { toBase58, type TransactionReceipt } from "@thruputchain/client";
import type { ReactNode } from "react";
import { useTransaction } from "./use-transaction";

const mocks = vi.hoisted(() => ({
  getChainTip: vi.fn(),
  getTransactionReceipt: vi.fn(),
  receipt: undefined as TransactionReceipt | undefined,
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => mocks,
  useWalletClient: () => null,
  useWaitForTransactionReceipt: () => ({ data: mocks.receipt }),
}));

const config = {
  networkId: toBase58(new Uint8Array(32)),
  factory: contractAddress(new Uint8Array(32).fill(2)),
  crowdSize: 0,
};
const key = `nft-drop:${config.networkId}:pending`;
const saved = {
  hash: toBase58(new Uint8Array(32).fill(7)),
  label: "Mint",
  target: "drop",
  expiry: "10",
};
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queries}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.setItem(key, JSON.stringify(saved));
  mocks.receipt = undefined;
  mocks.getTransactionReceipt.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it("reports a saved transaction that expired without committing, and clears it", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 11n });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(result.current.completed).toMatchObject({
    label: "Mint",
    target: "drop",
    ok: false,
  });
  expect(result.current.completed?.message).toMatch(/expired at block 10/);
  expect(result.current.pending).toBeNull();
  expect(result.current.blocked).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
});

it("keeps waiting until the expiry height has passed", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 10n });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(mocks.getChainTip).toHaveBeenCalled());
  expect(mocks.getTransactionReceipt).not.toHaveBeenCalled();
  expect(result.current.pending).toEqual(saved);
  expect(result.current.blocked).toBe(true);
});

it("settles with a receipt found after expiry", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 11n });
  mocks.getTransactionReceipt.mockResolvedValue({
    blockHeight: 9n,
    execution: { result: "return" },
  });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(result.current.completed).toMatchObject({ ok: true, target: "drop" });
  expect(localStorage.getItem(key)).toBeNull();
});
