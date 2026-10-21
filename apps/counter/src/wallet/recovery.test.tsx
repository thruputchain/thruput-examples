// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addressFromBase58,
  createPubkeyAccount,
  createTransaction,
  defaultWalletAdapter,
  hashSignedTransaction,
  PrivateKeySigner,
  serializeSignedTransaction,
  signTransaction,
  toBase58,
  toHex0x,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  blockHeight,
  gasAmount,
  networkHash,
  sha256Hash,
} from "@thruputchain/protocol";
import { Counter } from "../contracts/generated/counter";
import { pendingKey } from "./pending";
import { useWalletCounter } from "./use-wallet-counter";
import { WalletActivity } from "./wallet-activity";

const calls = vi.hoisted(() => ({
  execute: vi.fn(),
  sign: vi.fn(),
  submit: vi.fn(),
  getReceipt: vi.fn(),
  wait: vi.fn(),
  tip: vi.fn(),
  // Base58 of 32 zero bytes, matching `network` in the mocked client below.
  session: { address: "", session: { networkHash: "1".repeat(32) } },
}));
vi.mock("@thruputchain/react", () => ({
  useClient: () => ({
    network: { networkHash: new Uint8Array(32) },
    getTransactionReceipt: calls.getReceipt,
    waitForTransactionReceipt: calls.wait,
    getChainTip: calls.tip,
  }),
  useWallet: () => calls.session,
  useWalletClient: () => ({
    signTransaction: calls.sign,
    submitTransaction: calls.submit,
  }),
  useExecute: () => ({
    mutateAsync: calls.execute,
    isPending: false,
    reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: null,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  transactionReceiptQueryOptions: ({ hash }: { hash: string }) => ({
    queryKey: ["receipt", hash],
  }),
  contractViewQueryOptions: () => ({ queryKey: ["counter"] }),
}));

const zero58 = toBase58(new Uint8Array(32));
const address = toBase58(new Uint8Array(32).fill(0x22));
const key = pendingKey(zero58, address);
let query: QueryClient;
let fixture: Awaited<ReturnType<typeof signedUpdate>>;
async function signedUpdate() {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const tx = createTransaction({
    invocation: defaultWalletAdapter.createRootInvocation(account.address, {
      invocation: Counter.v0_1.increment.invocation(
        addressFromBase58(address),
        gasAmount(500_000n),
        { amount: 1n },
      ),
      gasLimit: gasAmount(1_000_000n),
    }),
    auth_claim: account.authClaim,
    contracts_to_deploy: [],
    uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
  });
  const signed = await signTransaction(
    tx,
    account.signers,
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  const hash = hashSignedTransaction(signed);
  const record = {
    signedTransaction: toHex0x(serializeSignedTransaction(signed)),
    hash: toBase58(hash),
    account: {
      address: toBase58(account.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    },
    networkHash: zero58,
  };
  const receipt: TransactionReceipt = {
    transactionHash: hash,
    blockHeight: 10n,
    execution: { result: "return" as const, returnData: new Uint8Array() },
    gasUsed: 0n,
    events: [],
  };
  return { record, tx, receipt };
}
beforeEach(async () => {
  fixture = await signedUpdate();
  calls.session.address = fixture.record.account.address;
  calls.session.session.networkHash = fixture.record.networkHash;
  calls.execute.mockReset();
  calls.sign.mockReset().mockResolvedValue(fixture.record);
  calls.submit.mockReset().mockResolvedValue({ hash: fixture.record.hash });
  calls.getReceipt.mockReset().mockResolvedValue(null);
  calls.wait.mockReset().mockResolvedValue(fixture.receipt);
  calls.tip.mockReset().mockResolvedValue({ blockHeight: 10n });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn(async (_key, _options, run) => run({})),
    },
  });
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  query.clear();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Page() {
  const activity = useWalletCounter(address);
  return (
    <>
      <button
        disabled={activity.blocked}
        onClick={() => activity.send("increment")}
      >
        New update
      </button>
      <WalletActivity activity={activity} explorerUrl={null} />
      <button onClick={activity.clearRecord}>Clear completed record</button>
      <output aria-label="Recent wallet transactions">
        {JSON.stringify(activity.recent)}
      </output>
    </>
  );
}
function mount(saved = true) {
  if (saved)
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, ...fixture.record }),
    );
  return render(
    <QueryClientProvider client={query}>
      <Page />
    </QueryClientProvider>,
  );
}

it("reloads observation-only and resubmits the original bytes only after explicit reapproval", async () => {
  mount();
  const recent = () =>
    JSON.parse(
      screen.getByLabelText("Recent wallet transactions").textContent!,
    );
  expect(recent()).toEqual([
    expect.objectContaining({
      hash: fixture.record.hash,
      direction: "increment",
      state: "pending",
    }),
  ]);
  expect(calls.execute).not.toHaveBeenCalled();
  expect(calls.sign).not.toHaveBeenCalled();
  expect(calls.submit).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same transaction" }),
  );
  await waitFor(() => expect(calls.submit).toHaveBeenCalledOnce());
  expect(calls.sign).toHaveBeenCalledWith(fixture.tx);
  expect(calls.submit).toHaveBeenCalledWith(fixture.record);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
    version: 1,
    ...fixture.record,
  });
  await waitFor(() =>
    expect(recent()).toEqual([
      expect.objectContaining({
        hash: fixture.record.hash,
        state: "confirmed",
      }),
    ]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Clear completed record" }),
  );
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  expect(recent()).toEqual([
    expect.objectContaining({ hash: fixture.record.hash, state: "confirmed" }),
  ]);
});

it("recovers a failed submission without preparing a replacement transaction", async () => {
  calls.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(fixture.record);
    throw new Error("Submission response lost");
  });
  mount(false);
  fireEvent.click(screen.getByRole("button", { name: "New update" }));
  await screen.findByText("Submission response lost");
  expect(
    JSON.parse(
      screen.getByLabelText("Recent wallet transactions").textContent!,
    ),
  ).toEqual([
    expect.objectContaining({
      hash: fixture.record.hash,
      direction: "increment",
      state: "pending",
    }),
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same transaction" }),
  );
  await waitFor(() => expect(calls.submit).toHaveBeenCalledOnce());
  expect(calls.execute).toHaveBeenCalledOnce();
  expect(calls.submit).toHaveBeenCalledWith(fixture.record);
  await waitFor(() =>
    expect(
      JSON.parse(
        screen.getByLabelText("Recent wallet transactions").textContent!,
      ),
    ).toEqual([
      expect.objectContaining({
        hash: fixture.record.hash,
        direction: "increment",
        state: "confirmed",
      }),
    ]),
  );
});

it("refuses another account, changed approval bytes, and expired transactions", async () => {
  mount();
  calls.session.address = toBase58(new Uint8Array(32).fill(0x33));
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same transaction" }),
  );
  await screen.findByText(
    "Select the original wallet account and network before retrying.",
  );
  expect(calls.sign).not.toHaveBeenCalled();
  calls.session.address = fixture.record.account.address;
  calls.sign.mockResolvedValue({
    ...fixture.record,
    signedTransaction: "0x00",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same transaction" }),
  );
  await screen.findByText(
    "Wallet reapproval changed the original transaction.",
  );
  expect(calls.submit).not.toHaveBeenCalled();
  calls.tip.mockResolvedValue({ blockHeight: 101n });
  calls.sign.mockClear();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same transaction" }),
  );
  await screen.findByText(/The signed update has expired/);
  expect(calls.sign).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("allows retry after a storage read error without silently discarding evidence", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  mount(false);
  expect(
    (screen.getByRole("button", { name: "New update" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText("Storage blocked")).toBeTruthy();
  read.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry storage" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "New update" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(calls.execute).not.toHaveBeenCalled();
});

it("requires confirmation to forget corrupt storage and then permits a new update", async () => {
  localStorage.setItem(key, "invalid JSON");
  mount(false);
  fireEvent.click(screen.getByRole("button", { name: "Forget saved record" }));
  expect(localStorage.getItem(key)).toBe("invalid JSON");
  expect(
    screen.getByText(/does not cancel a submitted transaction/),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm forget record" }),
  );
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  expect(
    (screen.getByRole("button", { name: "New update" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("stops broadcast on persistence failure, keeps the record in memory, and can retry storage", async () => {
  calls.execute.mockImplementation(async ({ options }) => {
    await options.onSigned(fixture.record);
    await calls.submit(fixture.record);
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
  mount(false);
  fireEvent.click(screen.getByRole("button", { name: "New update" }));
  await screen.findByText(
    /Cannot save the signed update. Submission was stopped/,
  );
  expect(calls.submit).not.toHaveBeenCalled();
  write.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry storage" }));
  await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
  expect(calls.submit).not.toHaveBeenCalled();
});

it("does not send while another tab holds the wallet-update lock", async () => {
  vi.mocked(navigator.locks.request).mockImplementation(
    async (_key, _options, run) => run!(null),
  );
  mount(false);
  fireEvent.click(screen.getByRole("button", { name: "New update" }));
  await screen.findByText(/Another tab is handling/);
  expect(calls.execute).not.toHaveBeenCalled();
});

it("blocks a saved record whose hash does not match", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      ...fixture.record,
      hash: toBase58(new Uint8Array(32).fill(0xff)),
    }),
  );
  mount(false);
  expect(
    screen.getByText(/Saved transaction identity does not match/),
  ).toBeTruthy();
  expect(calls.sign).not.toHaveBeenCalled();
});
