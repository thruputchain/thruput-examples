// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  NativeRpcError,
  createPubkeyAccount,
  createTransaction,
  defaultWalletAdapter,
  Ed25519Signer,
  hashSignedTransaction,
  serializeSignedTransaction,
  signTransaction,
  toBase58,
  toHex0x,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  blockHeight,
  contractAddress,
  networkHash,
  sha256Hash,
} from "@thruputchain/protocol";
import type { ReactNode } from "react";
import { GAS, methods } from "../contracts/polls";
import { useTransaction } from "./use-transaction";
import { loadPending, savePending } from "./pending";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getChainTip: vi.fn(),
  getTransactionStatus: vi.fn(),
  getTransactionsByBlock: vi.fn(),
  refetch: vi.fn(),
  receipt: null as TransactionReceipt | null,
  receiptError: null as Error | null,
  wallet: {} as Record<string, unknown>,
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => ({ ...mocks, network: { networkHash: new Uint8Array(32) } }),
  useExecute: () => ({ mutateAsync: mocks.execute }),
  useWallet: () => mocks.wallet,
  useWaitForTransactionReceipt: () => ({
    data: mocks.receipt,
    error: mocks.receiptError,
    refetch: mocks.refetch,
  }),
}));

const config = {
  networkId: toBase58(new Uint8Array(32)),
  address: contractAddress(new Uint8Array(32).fill(2)),
};
const invocation = methods.vote.invocation(config.address, GAS, {
  id: 0n,
  question: 0n,
  option: 0n,
});
const signerAddress = toBase58(new Uint8Array(32).fill(7));
const key = `voting:pending:${config.networkId}:${toBase58(config.address)}:${signerAddress}`;
const saved = { label: "Submit answer", hash: "", expiresAt: "100" };
let signed: {
  signedTransaction: string;
  hash: string;
  account: { address: string };
  networkHash: string;
};
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queries}>{children}</QueryClientProvider>
);
const success = { execution: { result: "return" } } as TransactionReceipt;

beforeEach(async () => {
  const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const transaction = createTransaction({
    invocation: defaultWalletAdapter.createRootInvocation(account.address, {
      invocation,
      gasLimit: GAS,
    }),
    auth_claim: account.authClaim,
    contracts_to_deploy: [],
    uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
  });
  const transactionSigned = await signTransaction(
    transaction,
    account.signers,
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  signed = {
    signedTransaction: toHex0x(serializeSignedTransaction(transactionSigned)),
    hash: toBase58(hashSignedTransaction(transactionSigned)),
    account: { address: signerAddress },
    networkHash: config.networkId,
  };
  saved.hash = signed.hash;
  mocks.wallet = { address: signerAddress };
  queries = new QueryClient();
  mocks.execute.mockReset();
  mocks.getTransactionReceipt.mockReset().mockResolvedValue(null);
  mocks.getChainTip.mockReset().mockResolvedValue({ blockHeight: 50n });
  mocks.getTransactionStatus.mockReset().mockResolvedValue({ status: "unknown" });
  mocks.getTransactionsByBlock.mockReset().mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 200n,
  });
  mocks.refetch.mockReset().mockResolvedValue({});
  mocks.receipt = null;
  mocks.receiptError = null;
});
afterEach(() => {
  cleanup();
  queries.clear();
  localStorage.clear();
});

it("saves the hash before broadcast, and reports the receipt that send returns", async () => {
  let savedBeforeBroadcast: unknown;
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(signed);
    savedBeforeBroadcast = loadPending(key);
    return { receipt: success };
  });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.send("Submit answer", invocation));
  expect(savedBeforeBroadcast).toEqual(saved);
  expect(result.current.completed).toBe("Submit answer");
  expect(result.current.pending).toBeNull();
  expect(loadPending(key)).toBeNull();
});

it("reports a receipt that arrives after a reload", async () => {
  savePending(key, saved);
  mocks.receipt = success;
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.completed).toBe("Submit answer"));
  expect(loadPending(key)).toBeNull();
});

it("does not block another account with this account's saved transaction", async () => {
  savePending(key, saved);
  mocks.wallet = { address: toBase58(new Uint8Array(32).fill(8)) };
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  expect(result.current.pending).toBeNull();
  expect(result.current.blocked).toBe(false);
});

it("sends once when a second click comes before the next render", async () => {
  mocks.execute.mockResolvedValue({ receipt: success });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  const send = result.current.send;
  await act(() =>
    Promise.all([
      send("Submit answer", invocation),
      send("Submit answer", invocation),
    ]),
  );
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it("keeps a transaction that committed before expiry, without its receipt indexed", async () => {
  savePending(key, saved);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionStatus.mockResolvedValue({ status: "committed", blockHeight: 99n });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(saved);
  // The tip is read first, so a commit between the two reads is not missed.
  expect(mocks.getChainTip.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getTransactionStatus.mock.invocationCallOrder[0]!,
  );
});

it("observes a saved transaction after a reload instead of signing again", async () => {
  savePending(key, saved);
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  expect(result.current.pending).toEqual(saved);
  await act(() => result.current.send("Another answer", invocation));
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("keeps a timed-out transaction until the chain passes its expiry", async () => {
  savePending(key, saved);
  mocks.receiptError = new Error("Timed out");
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  expect(result.current.waitTimedOut).toBe(true);

  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(saved);
  expect(mocks.refetch).toHaveBeenCalled();

  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toBeNull();
  expect(result.current.message).toMatch(/expired without committing/);
  expect(result.current.message).toContain(saved.hash);
});

it("reports a committed transaction whose execution failed", async () => {
  savePending(key, saved);
  mocks.receipt = { execution: { result: "abort" } } as TransactionReceipt;
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.message).toMatch(/execution failed/));
  expect(result.current.completed).toBeNull();
  expect(loadPending(key)).toBeNull();
});

it("keeps a transaction past expiry until the node has indexed its blocks", async () => {
  savePending(key, saved);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 99n,
  });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(saved);
  expect(result.current.message).toMatch(/has not indexed block 100/);
  // The index range is read before the receipt, so a block indexed between
  // the two reads cannot hide a commit.
  expect(mocks.getTransactionsByBlock.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getTransactionReceipt.mock.invocationCallOrder[0]!,
  );
});

it("keeps a transaction whose outcome the node cannot tell, until the user forgets it", async () => {
  savePending(key, { ...saved, expiresAt: "5000" });
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 4500n,
    latestIndexedBlockHeight: 9000n,
  });
  const record = { ...saved, expiresAt: "5000" };
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  // It may have committed, so the hash survives a reload.
  expect(result.current.pending).toEqual(record);
  expect(loadPending(key)).toEqual(record);
  expect(result.current.unknownOutcome).toBe(true);
  expect(result.current.message).toMatch(/no longer keeps the blocks/);
  expect(result.current.message).toContain(saved.hash);

  act(() => result.current.forgetUnknown());
  expect(result.current.pending).toBeNull();
  expect(loadPending(key)).toBeNull();
});

it("runs one check at a time, and a slow check does not clear a newer transaction", async () => {
  savePending(key, saved);
  let tip!: (value: { blockHeight: bigint }) => void;
  mocks.getChainTip.mockReturnValueOnce(new Promise((done) => (tip = done)));
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  let first!: Promise<void>;
  act(() => {
    first = result.current.checkAgain();
    void result.current.checkAgain();
  });
  expect(mocks.getChainTip).toHaveBeenCalledTimes(1);
  const newer = { ...saved, hash: toBase58(new Uint8Array(32).fill(9)) };
  savePending(key, newer);
  tip({ blockHeight: 101n });
  await act(() => first);
  expect(loadPending(key)).toEqual(newer);
});

it("does not unblock another account when this account's transaction finishes", async () => {
  const other = toBase58(new Uint8Array(32).fill(8));
  const otherKey = key.replace(signerAddress, other);
  const otherSaved = { ...saved, label: "Close poll", hash: toBase58(new Uint8Array(32).fill(9)) };
  savePending(otherKey, otherSaved);
  let commit!: () => void;
  const committed = new Promise<void>((done) => (commit = done));
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(signed);
    await committed;
    return { receipt: success };
  });
  const { result, rerender } = renderHook(() => useTransaction(config), { wrapper });
  let sent!: Promise<void>;
  act(() => {
    sent = result.current.send("Submit answer", invocation);
  });
  // The user switches accounts while the first transaction is in flight.
  mocks.wallet = { address: other };
  rerender();
  await waitFor(() => expect(result.current.pending).toEqual(otherSaved));
  commit();
  await act(() => sent);
  expect(result.current.pending).toEqual(otherSaved);
  expect(loadPending(otherKey)).toEqual(otherSaved);
  expect(loadPending(key)).toBeNull();
  expect(result.current.completed).toBeNull();
});

it("does not offer to forget another account's transaction after an unknown result", async () => {
  savePending(key, { ...saved, expiresAt: "5000" });
  const other = toBase58(new Uint8Array(32).fill(8));
  const otherKey = key.replace(signerAddress, other);
  const otherSaved = { ...saved, hash: toBase58(new Uint8Array(32).fill(9)) };
  savePending(otherKey, otherSaved);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 4500n,
    latestIndexedBlockHeight: 9000n,
  });
  const { result, rerender } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.unknownOutcome).toBe(true);

  mocks.wallet = { address: other };
  rerender();
  await waitFor(() => expect(result.current.pending).toEqual(otherSaved));
  expect(result.current.unknownOutcome).toBe(false);
  act(() => result.current.forgetUnknown());
  expect(loadPending(otherKey)).toEqual(otherSaved);
});

it("does not call a transaction expired when its blocks are pruned during the check", async () => {
  const record = { ...saved, expiresAt: "5000" };
  savePending(key, record);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  const page = (oldest: bigint) => ({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: oldest,
    latestIndexedBlockHeight: 9000n,
  });
  // Every block that could hold it is kept at first, then pruned before the
  // receipt read can find it.
  mocks.getTransactionsByBlock
    .mockResolvedValueOnce(page(0n))
    .mockResolvedValueOnce(page(4500n));
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(record);
  expect(result.current.unknownOutcome).toBe(true);
  expect(mocks.getTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getTransactionsByBlock.mock.invocationCallOrder[1]!,
  );
});

it("does not call a transaction expired when the final history read gives no range", async () => {
  const record = { ...saved, expiresAt: "5000" };
  savePending(key, record);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  // The node reports unavailable history without saying which blocks it keeps.
  const noRange = Object.assign(Object.create(NativeRpcError.prototype), {
    decoded: { classification: "known", data: { kind: "historyUnavailable" } },
  });
  mocks.getTransactionsByBlock
    .mockResolvedValueOnce({
      transactions: [],
      nextCursor: null,
      oldestIndexedBlockHeight: 0n,
      latestIndexedBlockHeight: 9000n,
    })
    .mockRejectedValueOnce(noRange);
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(record);
  expect(result.current.unknownOutcome).toBe(true);
});

it("does not call a transaction expired when the final read is indexed less far", async () => {
  const record = { ...saved, expiresAt: "5000" };
  savePending(key, record);
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  const page = (latest: bigint) => ({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: latest,
  });
  mocks.getTransactionsByBlock
    .mockResolvedValueOnce(page(5004n))
    .mockResolvedValueOnce(page(4999n));
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toEqual(record);
  expect(result.current.message).toMatch(/has not indexed block 5000/);
});
