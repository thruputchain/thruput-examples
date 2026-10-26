// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
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
  addressFromBase58,
} from "@thruputchain/client";
import { blockHeight, networkHash, sha256Hash } from "@thruputchain/protocol";
import type { PendingWalletTransaction } from "@thruputchain/client/wallet";
import type { ReactNode } from "react";
import { GAS, useClaim } from "./claim";
import { Airdrop } from "./contracts/generated/airdrop";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getChainTip: vi.fn(),
  getBlockByHeight: vi.fn(),
  refetch: vi.fn(),
  request: vi.fn(),
  wallet: {} as Record<string, unknown>,
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => mocks,
  useExecute: () => ({ mutateAsync: mocks.execute }),
  useWallet: () => mocks.wallet,
  useWaitForTransactionReceipt: () => ({ data: null, refetch: mocks.refetch }),
}));
const config = {
  networkId: toBase58(new Uint8Array(32)),
  address: toBase58(new Uint8Array(32).fill(2)),
  anchorHash: toBase58(new Uint8Array(32).fill(3)),
  anchorHeight: "1",
  tokens: [],
  swapUrl: "/swap/",
};
const key = `airdrop:v1:${config.networkId}:${config.anchorHash}:${config.address}`;
let record: PendingWalletTransaction;
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queries}>{children}</QueryClientProvider>
);
beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  queries = new QueryClient();
  const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const signed = await signTransaction(
    createTransaction({
      invocation: defaultWalletAdapter.createRootInvocation(account.address, {
        invocation: Airdrop.v0_1.claim.invocation(
          addressFromBase58(config.address),
          GAS,
        ),
        gasLimit: GAS,
      }),
      auth_claim: account.authClaim,
      contracts_to_deploy: [],
      uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
    }),
    account.signers,
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  record = {
    signedTransaction: toHex0x(serializeSignedTransaction(signed)),
    hash: toBase58(hashSignedTransaction(signed)),
    account: {
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    },
    networkHash: config.networkId,
  };
  localStorage.setItem(key, JSON.stringify(record));
  mocks.getBlockByHeight.mockResolvedValue({
    blockHash: new Uint8Array(32).fill(3),
  });
  mocks.getChainTip.mockResolvedValue({ blockHeight: 50n });
  mocks.getTransactionReceipt.mockResolvedValue(null);
  mocks.wallet = {
    status: "connected",
    address: record.account.address,
    provider: { request: mocks.request, on: () => () => {} },
  };
  mocks.request.mockImplementation(async (request) =>
    request.method === "getSession"
      ? { networkHash: config.networkId, accounts: [record.account] }
      : { hash: record.hash },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_key: string, callback: () => unknown) => callback(),
    },
  });
});
afterEach(() => {
  cleanup();
  queries.clear();
  vi.restoreAllMocks();
});
it("retries only saved bytes after reload without requesting another signature", async () => {
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.recover(true));
  expect(mocks.request).toHaveBeenCalledWith({
    method: "submitTransaction",
    params: {
      account: record.account.address,
      networkHash: record.networkHash,
      signedTransaction: record.signedTransaction,
    },
  });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
});
it("preserves evidence when submission fails or expiry has not passed", async () => {
  mocks.request.mockRejectedValue(new Error("Offline"));
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.recover(true));
  await act(() => result.current.recover(false));
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each([false, true])(
  "clears expired evidence only after a fresh on-chain claim check (%s)",
  async (claimed) => {
    mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
    const view = vi
      .spyOn(Airdrop.v0_1.hasClaimed, "view")
      .mockResolvedValue({ value: claimed } as never);
    const { result } = renderHook(() => useClaim(config), { wrapper });
    await act(() => result.current.recover(false));
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({
        minStateBlockHeight: 101n,
        args: { address: addressFromBase58(record.account.address) },
      }),
    );
    expect(localStorage.getItem(key)).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  },
);
it("retains expired evidence if the state read lags or fails", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  vi.spyOn(Airdrop.v0_1.hasClaimed, "view").mockRejectedValue(
    new Error("State unavailable"),
  );
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.recover(false));
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("does not retry through another account or clear evidence on another chain", async () => {
  mocks.wallet.address = config.address;
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.recover(true));
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getBlockByHeight.mockResolvedValue({
    blockHash: new Uint8Array(32).fill(4),
  });
  await act(() => result.current.recover(false));
  expect(localStorage.getItem(key)).not.toBeNull();
});
