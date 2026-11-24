// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import {
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
  gasAmount,
  networkHash,
  sha256Hash,
} from "@thruputchain/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ERC20 } from "@/contracts/generated/erc20";
import { useWalletTransaction } from "./use-wallet-transaction";

const mocks = vi.hoisted(() => ({
  executeCallsAndWait: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getChainTip: vi.fn(),
  getTransactionStatus: vi.fn(),
  getTransactionsByBlock: vi.fn(),
  refetch: vi.fn(),
  receipt: null as TransactionReceipt | null,
  receiptError: null as Error | null,
  address: "",
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => mocks,
  useWalletClient: () => ({ executeCallsAndWait: mocks.executeCallsAndWait }),
  useWaitForTransactionReceipt: () => ({
    data: mocks.receipt,
    error: mocks.receiptError,
    refetch: mocks.refetch,
  }),
}));

const key = "swap:pending:test";
const networkId = toBase58(new Uint8Array(32));
const call = ERC20.v0_1.transfer.call({
  address: contractAddress(new Uint8Array(32).fill(2)),
  gasLimit: gasAmount(1_000_000n),
  args: { receiver: contractAddress(new Uint8Array(32).fill(3)), amount: 1n },
});
let signed: Record<string, unknown>;

beforeEach(async () => {
  const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const transaction = await signTransaction(
    createTransaction({
      invocation: defaultWalletAdapter.createRootInvocation(account.address, {
        invocation: call.invocation,
        gasLimit: gasAmount(2_000_000n),
      }),
      auth_claim: account.authClaim,
      contracts_to_deploy: [],
      uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
    }),
    account.signers,
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  mocks.address = toBase58(account.address);
  signed = {
    hash: toBase58(hashSignedTransaction(transaction)),
    signedTransaction: toHex0x(serializeSignedTransaction(transaction)),
    account: { address: mocks.address },
    networkHash: networkId,
  };
  mocks.executeCallsAndWait.mockReset();
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
afterEach(() => localStorage.clear());

it("saves the record before broadcast, and reports the receipt once", async () => {
  let savedBeforeBroadcast: string | null = null;
  const receipt = { execution: { result: "return" } } as TransactionReceipt;
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    savedBeforeBroadcast = localStorage.getItem(key);
    return { receipt };
  });
  const onDone = vi.fn();
  const { result, rerender } = renderHook(() =>
    useWalletTransaction<{ symbol: string }>(key, onDone),
  );
  await act(() =>
    result.current.send("Swap", () => ({ calls: [call] }), { symbol: "ACRN" }),
  );
  expect(JSON.parse(savedBeforeBroadcast!)).toMatchObject({
    label: "Swap",
    hash: signed.hash,
    expiresAt: "100",
    context: { symbol: "ACRN" },
  });
  expect(result.current.completed).toMatchObject({
    succeeded: true,
    context: { symbol: "ACRN" },
  });
  expect(localStorage.getItem(key)).toBeNull();

  // The receipt query can report the same receipt later.
  mocks.receipt = receipt;
  rerender();
  await waitFor(() => expect(result.current.pending).toBeNull());
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("reports a receipt that arrives after a reload", async () => {
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    throw new Error("Timed out");
  });
  const first = renderHook(() => useWalletTransaction(key));
  await act(() => first.result.current.send("Swap", () => ({ calls: [call] }), {}));
  first.unmount();

  mocks.receipt = { execution: { result: "return" } } as TransactionReceipt;
  const { result } = renderHook(() => useWalletTransaction(key));
  await waitFor(() => expect(result.current.completed?.succeeded).toBe(true));
  expect(localStorage.getItem(key)).toBeNull();
});

it("after a reload, never signs again, and clears the record only after expiry", async () => {
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    throw new Error("Connection lost");
  });
  const first = renderHook(() => useWalletTransaction(key));
  await act(() => first.result.current.send("Swap", () => ({ calls: [call] }), {}));
  expect(first.result.current.message).toBe("Connection lost");
  first.unmount();

  const { result } = renderHook(() => useWalletTransaction(key));
  expect(result.current.pending?.hash).toBe(signed.hash);
  await act(() => result.current.send("Swap", () => ({ calls: [call] }), {}));
  expect(mocks.executeCallsAndWait).toHaveBeenCalledTimes(1);

  await act(() => result.current.checkAgain());
  expect(result.current.pending).not.toBeNull();
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toBeNull();
  expect(result.current.message).toMatch(/expired without committing/);
  expect(result.current.message).toContain(String(signed.hash));
});

it("keeps a transaction that committed before expiry, without its receipt indexed", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({ label: "Swap", hash: signed.hash, expiresAt: "100", context: {} }),
  );
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionStatus.mockResolvedValue({ status: "committed", blockHeight: 99n });
  const { result } = renderHook(() => useWalletTransaction(key));
  await act(() => result.current.checkAgain());
  expect(result.current.pending).not.toBeNull();
  expect(mocks.refetch).toHaveBeenCalled();
  // The tip is read first, so a commit between the two reads is not missed.
  expect(mocks.getChainTip.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getTransactionStatus.mock.invocationCallOrder[0]!,
  );
});

it("sends once when a second click comes while the first is still reading", async () => {
  let release!: () => void;
  const read = new Promise<void>((done) => (release = done));
  const build = vi.fn(async () => {
    await read;
    return { calls: [call] };
  });
  mocks.executeCallsAndWait.mockResolvedValue({ receipt: null });
  const { result } = renderHook(() => useWalletTransaction(key));
  // Both clicks use the same render, as two quick clicks do.
  const send = result.current.send;
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = send("Swap", build, {});
    second = send("Swap", build, {});
  });
  release();
  await act(() => Promise.all([first, second]));
  expect(build).toHaveBeenCalledTimes(1);
  expect(mocks.executeCallsAndWait).toHaveBeenCalledTimes(1);
});

it("keeps the saved transaction when its completion cannot be recorded", async () => {
  const receipt = { execution: { result: "return" } } as TransactionReceipt;
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    return { receipt };
  });
  const onDone = vi.fn(() => {
    throw new Error("Storage is full");
  });
  const { result } = renderHook(() => useWalletTransaction(key, onDone));
  await act(() => result.current.send("Swap", () => ({ calls: [call] }), {}));
  // Kept, so a reload observes the receipt and records the result again.
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(result.current.completed).toBeNull();
  expect(result.current.message).toBe("Storage is full");
});

it("keeps a transaction past expiry until the node has indexed its blocks", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({ label: "Swap", hash: signed.hash, expiresAt: "100", context: {} }),
  );
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 99n,
  });
  const { result } = renderHook(() => useWalletTransaction(key));
  await act(() => result.current.checkAgain());
  expect(result.current.pending).not.toBeNull();
  expect(result.current.message).toMatch(/has not indexed block 100/);
});

it("runs one check at a time, and a slow check does not clear a newer transaction", async () => {
  const record = (hash: string) =>
    JSON.stringify({ label: "Swap", hash, expiresAt: "100", context: {} });
  localStorage.setItem(key, record(String(signed.hash)));
  let tip!: (value: { blockHeight: bigint }) => void;
  mocks.getChainTip.mockReturnValueOnce(new Promise((done) => (tip = done)));
  const { result } = renderHook(() => useWalletTransaction(key));
  let first!: Promise<void>;
  act(() => {
    first = result.current.checkAgain();
    void result.current.checkAgain();
  });
  expect(mocks.getChainTip).toHaveBeenCalledTimes(1);

  // Meanwhile, the user signed a newer transaction.
  const newer = record("newer-hash");
  localStorage.setItem(key, newer);
  tip({ blockHeight: 101n });
  await act(() => first);
  expect(localStorage.getItem(key)).toBe(newer);
});

it("keeps a transaction whose outcome the node cannot tell, until the user forgets it", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({ label: "Swap", hash: signed.hash, expiresAt: "5000", context: {} }),
  );
  mocks.getChainTip.mockResolvedValue({ blockHeight: 9000n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 4500n,
    latestIndexedBlockHeight: 9000n,
  });
  const { result } = renderHook(() => useWalletTransaction(key));
  await act(() => result.current.checkAgain());
  // It may have committed, so the hash survives a reload.
  expect(result.current.pending).not.toBeNull();
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(result.current.unknownOutcome).toBe(true);
  expect(result.current.message).toContain(String(signed.hash));

  act(() => result.current.forgetUnknown());
  expect(result.current.pending).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it("reports a transaction once, also when another copy of the hook reported it first", async () => {
  const receipt = { execution: { result: "return" } } as TransactionReceipt;
  let reply!: () => void;
  const replied = new Promise<void>((done) => (reply = done));
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    await replied;
    return { receipt };
  });
  const firstDone = vi.fn();
  const first = renderHook(() => useWalletTransaction(key, firstDone));
  let sent!: Promise<void>;
  act(() => {
    sent = first.result.current.send("Swap", () => ({ calls: [call] }), {});
  });
  await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());

  // The page remounts (an account switch and back), and the new copy sees the receipt.
  mocks.receipt = receipt;
  const secondDone = vi.fn();
  renderHook(() => useWalletTransaction(key, secondDone));
  await waitFor(() => expect(secondDone).toHaveBeenCalledTimes(1));
  expect(localStorage.getItem(key)).toBeNull();

  // The first copy's wallet reply arrives late; it must not report again.
  reply();
  await act(() => sent);
  expect(firstDone).not.toHaveBeenCalled();
});

it("lets the page on screen report a transaction that an unmounted copy sent", async () => {
  const receipt = { execution: { result: "return" } } as TransactionReceipt;
  let sign!: () => void;
  let reply!: () => void;
  const signing = new Promise<void>((done) => (sign = done));
  const replied = new Promise<void>((done) => (reply = done));
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await signing;
    await options.onSigned(signed);
    await replied;
    return { receipt };
  });
  const firstDone = vi.fn();
  const first = renderHook(() => useWalletTransaction(key, firstDone));
  let sent!: Promise<void>;
  act(() => {
    sent = first.result.current.send("Swap", () => ({ calls: [call] }), {});
  });
  // The user switches accounts and back while the wallet is still signing.
  first.unmount();
  const secondDone = vi.fn();
  const second = renderHook(() => useWalletTransaction(key, secondDone));
  expect(second.result.current.pending).toBeNull();

  // The old copy saves the record; the page on screen shows it.
  await act(async () => sign());
  await waitFor(() => expect(second.result.current.pending?.hash).toBe(signed.hash));

  // The old copy's wallet call returns first. It is not on screen, so it
  // leaves the record for the page that is.
  reply();
  await act(() => sent);
  expect(firstDone).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();

  mocks.receipt = receipt;
  second.rerender();
  await waitFor(() => expect(secondDone).toHaveBeenCalledTimes(1));
  expect(second.result.current.completed?.succeeded).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});
