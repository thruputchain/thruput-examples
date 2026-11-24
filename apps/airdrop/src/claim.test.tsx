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
  getTransactionStatus: vi.fn(),
  getTransactionsByBlock: vi.fn(),
  getBlockByHeight: vi.fn(),
  refetch: vi.fn(),
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
const keyFor = (account: string) =>
  `airdrop:pending:${config.networkId}:${config.anchorHash}:${config.address}:${account}`;
const success = { execution: { result: "return" } };
let key: string;
let record: PendingClaim;
/** What the wallet reports in `onSigned`. */
let evidence: {
  hash: string;
  signedTransaction: string;
  account: { address: string };
  networkHash: string;
};
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
  evidence = {
    hash: toBase58(hashSignedTransaction(signed)),
    signedTransaction: toHex0x(serializeSignedTransaction(signed)),
    account: { address: toBase58(account.address) },
    networkHash: config.networkId,
  };
  record = { hash: evidence.hash, expiresAt: "100" };
  key = keyFor(evidence.account.address);
  localStorage.setItem(key, JSON.stringify(record));
  mocks.getBlockByHeight.mockResolvedValue({
    blockHash: new Uint8Array(32).fill(3),
  });
  mocks.getChainTip.mockResolvedValue({ blockHeight: 50n });
  mocks.getTransactionStatus.mockResolvedValue({ status: "unknown" });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 200n,
  });
  mocks.getTransactionReceipt.mockResolvedValue(null);
  mocks.refetch.mockResolvedValue({});
  mocks.wallet = { status: "connected", address: evidence.account.address };
});
afterEach(() => {
  cleanup();
  queries.clear();
  vi.restoreAllMocks();
});

/** Claim with nothing saved yet: the wallet signs, then the node commits. */
function claimFromScratch() {
  localStorage.clear();
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(evidence);
    return { receipt: success };
  });
  return renderHook(() => useClaim(config), { wrapper });
}

it("checks the chain checkpoint, claims, and reports the receipt", async () => {
  const { result } = claimFromScratch();
  await act(() => result.current.send());
  expect(mocks.getBlockByHeight).toHaveBeenCalledWith({ blockHeight: 1n });
  expect(mocks.execute.mock.lastCall![0].request.invocation).toEqual(
    Airdrop.v0_1.claim.invocation(addressFromBase58(config.address), GAS),
  );
  expect(result.current.message).toBe("Claim confirmed.");
  expect(result.current.pending).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it("refuses to claim on a chain whose checkpoint changed", async () => {
  const { result } = claimFromScratch();
  mocks.getBlockByHeight.mockResolvedValue({ blockHash: new Uint8Array(32).fill(4) });
  await act(() => result.current.send());
  expect(result.current.error).toMatch(/checkpoint changed/);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("claims once when a second click comes while the checkpoint is read", async () => {
  const { result } = claimFromScratch();
  const send = result.current.send;
  await act(() => Promise.all([send(), send()]));
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it("observes the saved claim after a reload, and never signs again", async () => {
  const { result } = renderHook(() => useClaim(config), { wrapper });
  expect(result.current.pending).toEqual(record);
  expect(result.current.blocked).toBe(true);
  await act(() => result.current.send());
  await act(() => result.current.checkAgain());
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("clears the saved claim once the chain passes its expiry without committing it", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.message).toMatch(/expired without committing/);
});

it("keeps a claim that committed before expiry, without its receipt indexed", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionStatus.mockResolvedValue({ status: "committed", blockHeight: 99n });
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(mocks.getChainTip.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getTransactionStatus.mock.invocationCallOrder[0]!,
  );
});

it("does not block another wallet account with this account's saved claim", async () => {
  mocks.wallet.address = config.address;
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await waitFor(() => expect(result.current.pending).toBeNull());
  expect(result.current.blocked).toBe(false);
});

it("keeps a claim past expiry until the node has indexed its blocks", async () => {
  mocks.getChainTip.mockResolvedValue({ blockHeight: 101n });
  mocks.getTransactionsByBlock.mockResolvedValue({
    transactions: [],
    nextCursor: null,
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 99n,
  });
  const { result } = renderHook(() => useClaim(config), { wrapper });
  await act(() => result.current.checkAgain());
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(result.current.message).toMatch(/has not indexed block 100/);
});

it("does not unblock another account when this account's claim finishes", async () => {
  const other = config.address;
  const otherRecord = { hash: toBase58(new Uint8Array(32).fill(9)), expiresAt: "100" };
  localStorage.setItem(keyFor(other), JSON.stringify(otherRecord));
  const { result, rerender } = claimFromScratch();
  localStorage.setItem(keyFor(other), JSON.stringify(otherRecord));
  let commit!: () => void;
  const committed = new Promise<void>((done) => (commit = done));
  mocks.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(evidence);
    await committed;
    return { receipt: success };
  });
  let sent!: Promise<void>;
  act(() => {
    sent = result.current.send();
  });
  await waitFor(() => expect(mocks.execute).toHaveBeenCalled());
  mocks.wallet.address = other;
  rerender();
  await waitFor(() => expect(result.current.pending).toEqual(otherRecord));
  commit();
  await act(() => sent);
  expect(result.current.pending).toEqual(otherRecord);
  expect(localStorage.getItem(keyFor(other))).not.toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.message).toBe("");
});
