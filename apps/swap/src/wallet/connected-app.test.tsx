import {
  addressFromHex,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { createPubkeyAccount } from "@groundhogchain/client/wallet";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import {
  calldata,
  contractEntrypointID,
  gasAmount,
} from "@groundhogchain/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_CALLER, type GlobalConfig } from "@/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { ConnectedWalletApp } from "./connected-app";
import { useWalletWriteBoundary } from "./write-context";

vi.mock("@/groundhog/client", () => ({
  createReadClient: () => ({
    getChainTip: vi.fn().mockResolvedValue({ height: 1n }),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    getTransactionStatus: vi.fn().mockResolvedValue({ status: "unknown" }),
  }),
}));

function account(byte: number) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(byte));
  const account = createPubkeyAccount({ signer });
  return {
    address: toHex0x(account.address),
    publicKey: toHex0x(signer.publicKey.ed25519),
    nonce: "0",
  };
}
const accounts = [account(1), account(2)];
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: READ_ONLY_CALLER,
  factoryAddress: addressFromHex(`0x${"03".repeat(32)}`),
  routerAddress: addressFromHex(`0x${"04".repeat(32)}`),
  nativeHogAddress: addressFromHex(`0x${"05".repeat(32)}`),
  registryEnabled: true,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllEnvs();
});

function provider(id = "test.wallet") {
  let session: WalletSession = { networkHash: config.networkIdHex, accounts };
  const listeners = new Set<(session: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async (request) => {
    if (request.method === "connect" || request.method === "getSession")
      return session;
    if (request.method === "disconnect") return undefined;
    throw new Error("Test never approves signing");
  });
  const provider: WalletProvider = {
    info: { id, name: id, version: "1.0.0" },
    request,
    on: (_event, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  cleanups.push(registerWalletProvider(provider));
  return {
    provider,
    request,
    listeners,
    change(value: WalletSession) {
      session = value;
      for (const listener of listeners) listener(value);
    },
  };
}

function renderApp() {
  const writers: WriteBoundary[] = [];
  function Probe({
    runtime,
    connected,
  }: {
    runtime: GlobalConfig;
    connected: boolean;
  }) {
    const writer = useWalletWriteBoundary();
    writers.push(writer);
    return (
      <>
        <output aria-label="Runtime caller">
          {toHex0x(runtime.accountAddress)}
        </output>
        <output aria-label="Writable">{String(connected)}</output>
        <input aria-label="Route draft" />
      </>
    );
  }
  const view = render(
    <StrictMode>
      <TooltipProvider>
        <ConnectedWalletApp config={config}>
          {(runtime, connected, revision) => (
            <Probe key={revision} runtime={runtime} connected={connected} />
          )}
        </ConnectedWalletApp>
      </TooltipProvider>
    </StrictMode>,
  );
  return { ...view, writers, user: userEvent.setup() };
}

async function connect(
  user: ReturnType<typeof userEvent.setup>,
  id = "test.wallet",
) {
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Wallet provider" }),
    id,
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
}

describe("connected wallet runtime", () => {
  it("hides Disconnect before approval and on an empty account session, then allows reconnect", async () => {
    const wallet = provider();
    let resolve!: (value: unknown) => void;
    wallet.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { user } = renderApp();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    await connect(user);
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    await act(async () =>
      resolve({ networkHash: config.networkIdHex, accounts }),
    );
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await act(async () =>
      wallet.change({ networkHash: config.networkIdHex, accounts: [] }),
    );
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    wallet.request.mockResolvedValueOnce({
      networkHash: config.networkIdHex,
      accounts,
    });
    await user.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });
  it("browses without a wallet, discovers either load order, and never presents the fallback caller as a wallet", async () => {
    const first = provider();
    const { user } = renderApp();
    expect(screen.getByText("Read-only browsing")).toBeVisible();
    expect(screen.queryByLabelText(/Connected account/)).toBeNull();
    expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
      toHex0x(READ_ONLY_CALLER),
    );
    expect(first.request).not.toHaveBeenCalled();
    act(() => {
      provider("later.wallet");
    });
    expect(screen.getAllByRole("option", { name: "test.wallet" })).toHaveLength(
      1,
    );
    await connect(user, "later.wallet");
    expect(screen.getByLabelText("Writable")).toHaveTextContent("true");
    expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
      accounts[0]!.address,
    );
  });

  it("enables registry production writes only after connection and disposes/remounts on account selection and disconnect", async () => {
    vi.stubEnv("PROD", true);
    const wallet = provider();
    const { user, writers, unmount } = renderApp();
    await connect(user);
    const oldWriter = writers.at(-1)!;
    await user.type(screen.getByLabelText("Route draft"), "stale quote");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Wallet account" }),
      accounts[1]!.address,
    );
    expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
      accounts[1]!.address,
    );
    expect(screen.getByLabelText("Route draft")).toHaveValue("");
    await expect(
      oldWriter.execute({
        invoked_address: config.routerAddress,
        entrypoint: contractEntrypointID(new Uint8Array(8)),
        gas_limit: gasAmount(1n),
        calldata: calldata(new Uint8Array()),
      }),
    ).resolves.toMatchObject({
      kind: "preSubmissionFailure",
      message: expect.stringContaining("disposed"),
    });
    expect(
      wallet.request.mock.calls.some(
        ([request]) => request.method === "signTransaction",
      ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByLabelText("Writable")).toHaveTextContent("false");
    expect(screen.queryByLabelText(/Connected account/)).toBeNull();
    expect(wallet.request).toHaveBeenCalledWith({ method: "disconnect" });
    expect(writers.at(-1)?.observe).toBeTypeOf("function");
    unmount();
    expect(wallet.listeners.size).toBe(0);
  });

  it("invalidates on account, lock and network change, preserving a still-authorized selected account", async () => {
    const wallet = provider();
    const { user } = renderApp();
    await connect(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Wallet account" }),
      accounts[1]!.address,
    );
    await user.type(screen.getByLabelText("Route draft"), "discard");
    await act(async () =>
      wallet.change({ networkHash: config.networkIdHex, accounts }),
    );
    expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
      accounts[1]!.address,
    );
    expect(screen.getByLabelText("Route draft")).toHaveValue("");
    await act(async () =>
      wallet.change({ networkHash: "ff".repeat(32), accounts }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("network");
    expect(screen.getByLabelText("Writable")).toHaveTextContent("false");
    await act(async () =>
      wallet.change({ networkHash: config.networkIdHex, accounts: [] }),
    );
    expect(screen.getByText("Read-only browsing")).toBeVisible();
  });

  it.each(["reject", "network", "malformed"])(
    "shows %s connection failure without enabling writes",
    async (failure) => {
      const wallet = provider();
      if (failure === "reject")
        wallet.request.mockRejectedValueOnce(new Error("Connection rejected"));
      if (failure === "network")
        wallet.request.mockResolvedValueOnce({
          networkHash: "ff".repeat(32),
          accounts,
        });
      if (failure === "malformed")
        wallet.request.mockResolvedValueOnce({ accounts });
      const { user } = renderApp();
      await connect(user);
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
      expect(screen.getByLabelText("Writable")).toHaveTextContent("false");
    },
  );

  it("ignores an old connect result after a session change", async () => {
    const wallet = provider();
    let resolve!: (value: unknown) => void;
    wallet.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { user } = renderApp();
    await connect(user);
    await act(async () =>
      wallet.change({ networkHash: config.networkIdHex, accounts: [] }),
    );
    await act(async () =>
      resolve({ networkHash: config.networkIdHex, accounts }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Writable")).toHaveTextContent("false"),
    );
    expect(screen.queryByLabelText(/Connected account/)).toBeNull();
  });
});
