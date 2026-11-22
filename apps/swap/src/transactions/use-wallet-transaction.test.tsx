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
  refetch: vi.fn(),
  request: vi.fn(),
  receipt: null as TransactionReceipt | null,
  receiptError: null as Error | null,
  address: "",
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => mocks,
  useWallet: () => ({
    provider: { request: mocks.request },
    address: mocks.address,
  }),
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
  mocks.refetch.mockReset().mockResolvedValue({});
  mocks.request.mockReset().mockResolvedValue({});
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
    result.current.send("Swap", { calls: [call] }, { symbol: "ACRN" }),
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
  await act(() => first.result.current.send("Swap", { calls: [call] }, {}));
  first.unmount();

  mocks.receipt = { execution: { result: "return" } } as TransactionReceipt;
  const { result } = renderHook(() => useWalletTransaction(key));
  await waitFor(() => expect(result.current.completed?.succeeded).toBe(true));
  expect(localStorage.getItem(key)).toBeNull();
});

it("after a reload, retries the same bytes and clears only after expiry", async () => {
  mocks.executeCallsAndWait.mockImplementation(async (_request, options) => {
    await options.onSigned(signed);
    throw new Error("Connection lost");
  });
  const first = renderHook(() => useWalletTransaction(key));
  await act(() => first.result.current.send("Swap", { calls: [call] }, {}));
  expect(first.result.current.message).toBe("Connection lost");
  first.unmount();

  const { result } = renderHook(() => useWalletTransaction(key));
  expect(result.current.pending?.hash).toBe(signed.hash);
  await act(() => result.current.retry());
  expect(mocks.request).toHaveBeenCalledWith({
    method: "submitTransaction",
    params: {
      account: mocks.address,
      networkHash: networkId,
      signedTransaction: signed.signedTransaction,
    },
  });
  expect(mocks.executeCallsAndWait).toHaveBeenCalledTimes(1);

  await act(() => result.current.checkAgain());
  expect(result.current.pending).not.toBeNull();
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  await act(() => result.current.checkAgain());
  expect(result.current.pending).toBeNull();
  expect(result.current.message).toMatch(/expired without committing/);
});
