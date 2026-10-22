// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  createTransaction,
  defaultWalletAdapter,
  hashSignedTransaction,
  Ed25519Signer,
  serializeSignedTransaction,
  signTransaction,
  toBase58,
  toHex0x,
  type TransactionReceipt,
  hashFromBase58,
  UnsupportedRpcValue,
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
import { loadPending, savePending, type Pending } from "./pending";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getChainTip: vi.fn(),
  sendTransaction: vi.fn(),
  refetch: vi.fn(),
  receipt: null as TransactionReceipt | null,
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => ({ ...mocks, network: { networkHash: new Uint8Array(32) } }),
  useExecute: () => ({ mutateAsync: mocks.execute }),
  useWaitForTransactionReceipt: () => ({
    data: mocks.receipt,
    error: new Error("Timed out"),
    refetch: mocks.refetch,
    isFetching: false,
  }),
}));
const config = {
  networkId: toBase58(new Uint8Array(32)),
  address: contractAddress(new Uint8Array(32).fill(2)),
};
const key = `voting:v1:${config.networkId}:${toBase58(config.address)}`;
const invocation = methods.vote.invocation(config.address, GAS, {
  id: 0n,
  question: 0n,
  option: 0n,
});
let pending: Pending;
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queries}>{children}</QueryClientProvider>
);

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
  const signed = await signTransaction(
    transaction,
    account.signers,
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  pending = {
    version: 1,
    label: "Submit answer",
    record: {
      signedTransaction: toHex0x(serializeSignedTransaction(signed)),
      hash: toBase58(hashSignedTransaction(signed)),
      account: {
        address: toBase58(account.address),
        publicKey: toBase58(signer.publicKey.ed25519),
        nonce: "0",
      },
      networkHash: config.networkId,
    },
  };
  queries = new QueryClient();
  mocks.execute.mockReset();
  mocks.getTransactionReceipt.mockReset().mockResolvedValue(null);
  mocks.receipt = null;
  mocks.getChainTip.mockReset().mockResolvedValue({ blockHeight: 50n });
  mocks.sendTransaction
    .mockReset()
    .mockResolvedValue({ transactionHash: hashSignedTransaction(signed) });
  mocks.refetch.mockReset().mockResolvedValue({});
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _options: unknown,
        run: (held: object) => Promise<void>,
      ) => run({}),
    },
  });
});
afterEach(() => {
  cleanup();
  queries.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("round-trips the complete signed record and blocks new writes after reload and timeout", async () => {
  savePending(localStorage, key, pending);
  expect(loadPending(localStorage, key, config.networkId)).toEqual(pending);
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.pending).toEqual(pending));
  expect(result.current.blocked).toBe(true);
  act(() => result.current.send("Another answer", invocation));
  act(() => result.current.finish());
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(loadPending(localStorage, key, config.networkId)).toEqual(pending);
});

it("preserves corrupt evidence and blocks new signing", async () => {
  localStorage.setItem(key, "corrupt");
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => expect(result.current.storageError).toBe(true));
  act(() => result.current.send("Answer", invocation));
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe("corrupt");
});

it("stops before submission when signed-record storage fails", async () => {
  const broadcast = vi.fn();
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(pending.record);
    broadcast();
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  act(() => result.current.send("Answer", invocation));
  await waitFor(() => expect(result.current.storageError).toBe(true));
  expect(result.current.pending?.record).toEqual(pending.record);
  expect(broadcast).not.toHaveBeenCalled();
  expect(result.current.blocked).toBe(true);
});

it("recovers storage and submits the original bytes without signing again", async () => {
  mocks.execute.mockImplementation(async ({ options }) =>
    options.onSigned(pending.record),
  );
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
  const { result, unmount } = renderHook(() => useTransaction(config), {
    wrapper,
  });
  act(() => result.current.send("Submit answer", invocation));
  await waitFor(() => expect(result.current.storageError).toBe(true));
  storage.mockRestore();
  act(() => result.current.retryStorage());
  await waitFor(() => expect(result.current.storageError).toBe(false));
  expect(mocks.sendTransaction).not.toHaveBeenCalled();
  unmount();
  const reloaded = renderHook(() => useTransaction(config), { wrapper });
  act(() => reloaded.result.current.retrySubmission());
  await waitFor(() => expect(mocks.sendTransaction).toHaveBeenCalledTimes(1));
  expect(
    toHex0x(mocks.sendTransaction.mock.calls[0]![0].signedTransaction),
  ).toBe(pending.record.signedTransaction);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(loadPending(localStorage, key, config.networkId)).toEqual(pending);
});

it.each(["committed", "expired", "changed"])(
  "does not resubmit a %s transaction",
  async (state) => {
    savePending(localStorage, key, pending);
    const { result } = renderHook(() => useTransaction(config), { wrapper });
    if (state === "committed")
      mocks.getTransactionReceipt.mockResolvedValue({
        transactionHash: pending.record.hash,
      });
    if (state === "expired")
      mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
    if (state === "changed") localStorage.removeItem(key);
    act(() => result.current.retrySubmission());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);

it("retains the signed record after an uncertain submission", async () => {
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(pending.record);
    throw new Error("Connection lost");
  });
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  act(() => result.current.send("Submit answer", invocation));
  await waitFor(() => expect(result.current.message).toBe("Connection lost"));
  expect(loadPending(localStorage, key, config.networkId)).toEqual(pending);
  act(() => result.current.send("Submit answer", invocation));
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it.each(["return", "abort", "unsupported"])(
  "handles native %s receipts without losing uncertain evidence",
  async (kind) => {
    savePending(localStorage, key, pending);
    mocks.receipt = {
      transactionHash: hashFromBase58(pending.record.hash),
      blockHeight: 10n,
      execution:
        kind === "return"
          ? { result: "return", returnData: new Uint8Array() }
          : kind === "abort"
            ? { result: "abort", abortData: new Uint8Array() }
            : new UnsupportedRpcValue({ result: "future" }),
      gasUsed: 0n,
      events: [],
    };
    const { result } = renderHook(() => useTransaction(config), { wrapper });
    expect(result.current.confirmed).toBe(kind === "return");
    expect(result.current.settled).toBe(kind !== "unsupported");
    act(() => result.current.finish());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(loadPending(localStorage, key, config.networkId)).toEqual(
      kind === "unsupported" ? pending : null,
    );
  },
);

it("automatically completes a confirmed success without another user action", async () => {
  savePending(localStorage, key, pending);
  mocks.receipt = {
    transactionHash: hashFromBase58(pending.record.hash),
    blockHeight: 10n,
    execution: { result: "return", returnData: new Uint8Array() },
    gasUsed: 0n,
    events: [],
  };
  const { result } = renderHook(() => useTransaction(config), { wrapper });
  await waitFor(() => {
    expect(localStorage.getItem(key)).toBeNull();
    expect(result.current.completed).toBe("Submit answer");
    expect(result.current.blocked).toBe(false);
  });
  expect(mocks.execute).not.toHaveBeenCalled();
});
