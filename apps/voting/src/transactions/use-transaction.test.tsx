// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  refetch: vi.fn(),
  receipt: null as TransactionReceipt | null,
  receiptError: null as Error | null,
  request: vi.fn(),
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
const key = `voting:pending:${config.networkId}:${toBase58(config.address)}`;
const invocation = methods.vote.invocation(config.address, GAS, {
  id: 0n,
  question: 0n,
  option: 0n,
});
const signerAddress = toBase58(new Uint8Array(32).fill(7));
const saved = {
  label: "Submit answer",
  hash: "",
  expiresAt: "100",
  signedTransaction: "",
  account: signerAddress,
  networkHash: config.networkId,
};
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
  saved.signedTransaction = signed.signedTransaction;
  mocks.request.mockReset().mockResolvedValue({ hash: signed.hash });
  mocks.wallet = {
    provider: { request: mocks.request },
    address: signerAddress,
  };
  queries = new QueryClient();
  mocks.execute.mockReset();
  mocks.getTransactionReceipt.mockReset().mockResolvedValue(null);
  mocks.getChainTip.mockReset().mockResolvedValue({ blockHeight: 50n });
  mocks.refetch.mockReset().mockResolvedValue({});
  mocks.receipt = null;
  mocks.receiptError = null;
});
afterEach(() => {
  cleanup();
  queries.clear();
  localStorage.clear();
});

it("saves the hash before broadcast and clears it when the receipt arrives", async () => {
  let savedBeforeBroadcast: unknown;
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(signed);
    savedBeforeBroadcast = loadPending(key);
    return {};
  });
  const { result, rerender } = renderHook(() => useTransaction(config), {
    wrapper,
  });
  await act(() => result.current.send("Submit answer", invocation));
  expect(savedBeforeBroadcast).toEqual(saved);
  expect(result.current.pending).toEqual(saved);
  expect(result.current.blocked).toBe(true);

  mocks.receipt = success;
  rerender();
  await waitFor(() => expect(result.current.completed).toBe("Submit answer"));
  expect(result.current.pending).toBeNull();
  expect(loadPending(key)).toBeNull();
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
});

it("reports a committed transaction whose execution failed", async () => {
  savePending(key, saved);
  mocks.receipt = { execution: { result: "abort" } } as TransactionReceipt;
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.message).toMatch(/execution failed/));
  expect(result.current.completed).toBeNull();
  expect(loadPending(key)).toBeNull();
});

it("sends the same signed bytes again, and never signs a new transaction", async () => {
  savePending(key, saved);
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await act(() => result.current.retry());
  expect(mocks.request).toHaveBeenCalledWith({
    method: "submitTransaction",
    params: {
      account: signerAddress,
      networkHash: config.networkId,
      signedTransaction: saved.signedTransaction,
    },
  });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(result.current.pending).toEqual(saved);
});
