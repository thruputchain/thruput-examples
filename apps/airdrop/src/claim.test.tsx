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
import type { ReactNode } from "react";
import { GAS, useClaim, type PendingClaim } from "./claim";
import { Airdrop } from "./contracts/generated/airdrop";

// Node 25+ exposes its own storage globals. Use the jsdom storage for this test.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
}

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
const key = `airdrop:pending:${config.networkId}:${config.anchorHash}:${config.address}`;
let record: PendingClaim;
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
    hash: toBase58(hashSignedTransaction(signed)),
    expiresAt: "100",
    signedTransaction: toHex0x(serializeSignedTransaction(signed)),
    account: toBase58(account.address),
    networkHash: config.networkId,
  };
  localStorage.setItem(key, JSON.stringify(record));
  mocks.getBlockByHeight.mockResolvedValue({
    blockHash: new Uint8Array(32).fill(3),
  });
  mocks.getChainTip.mockResolvedValue({ blockHeight: 50n });
  mocks.getTransactionReceipt.mockResolvedValue(null);
  mocks.refetch.mockResolvedValue({});
  mocks.request.mockResolvedValue({ hash: record.hash });
  mocks.wallet = {
    status: "connected",
    address: record.account,
    provider: { request: mocks.request },
  };
});
afterEach(() => {
  cleanup();
  queries.clear();
  vi.restoreAllMocks();
});

it("sends only the saved bytes after a reload, without another signature", async () => {
  const { result } = renderHook(() => useClaim(config), { wrapper });
  expect(result.current.pending).toEqual(record);
  expect(result.current.blocked).toBe(true);
  await act(() => result.current.retry());
  expect(mocks.request).toHaveBeenCalledWith({
    method: "submitTransaction",
    params: {
      account: record.account,
      networkHash: record.networkHash,
      signedTransaction: record.signedTransaction,
    },
  });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("keeps the saved claim when a retry fails or the claim has not expired", async () => {
  mocks.request.mockRejectedValue(new Error("Offline"));
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.retry());
  expect(result.current.error).toBe("Offline");
  await act(() => result.current.checkAgain());
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("clears the saved claim once the chain passes its expiry without a receipt", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.message).toMatch(/expired without committing/);
});

it("does not retry through another wallet account", async () => {
  mocks.wallet.address = config.address;
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.retry());
  expect(mocks.request).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/wallet account that signed/);
});
