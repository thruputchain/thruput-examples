import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  addressFromHex,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import { createPubkeyAccount } from "@groundhogchain/client/wallet";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "@/config";
import { WalletProvider as AppWalletProvider } from "./wallet-provider";
import { WalletControls } from "./wallet-controls";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createReadClient } from "@/groundhog/client";

vi.mock("@/groundhog/client", () => ({ createReadClient: vi.fn(() => ({})) }));
function Probe({ readOnly }: { readOnly: boolean }) {
  const [revision, setRevision] = useState(0);
  return (
    <TooltipProvider>
      <WalletControls />
      <p>{readOnly ? "Public browsing" : "Wallet workflow"}</p>
      <button onClick={() => setRevision(revision + 1)}>
        Draft {revision}
      </button>
    </TooltipProvider>
  );
}
function ProviderApp({ base: config }: { base: typeof base }) {
  return (
    <AppWalletProvider config={config}>
      {(_config, connected, revision) => (
        <Probe key={revision} readOnly={!connected} />
      )}
    </AppWalletProvider>
  );
}
const base = loadConfig({
  VITE_GROUNDHOG_RPC_URL: "http://localhost:9545",
  VITE_GROUNDHOG_NETWORK_ID: "ab".repeat(32),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"04".repeat(32)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"05".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: `0x${"06".repeat(32)}`,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_TOKEN_REGISTRY_ENABLED: "true",
});
function account(nonce: bigint) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const local = createPubkeyAccount({ signer, nonce });
  return {
    address: toHex0x(local.address),
    publicKey: toHex0x(signer.publicKey.ed25519),
    nonce: nonce.toString(),
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
function wallet() {
  let session: WalletSession = {
    networkHash: base.networkIdHex,
    accounts: [account(1n)],
  };
  const listeners = new Set<(session: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async () => session);
  const provider: WalletProvider = {
    info: { id: "test", name: "Test Wallet", version: "1.0.0" },
    request,
    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  cleanups.push(registerWalletProvider(provider));
  return {
    request,
    change(next: WalletSession) {
      session = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}
it("discovers before and after mount, connects with registry enabled, remounts on account changes, and disconnects", async () => {
  const user = userEvent.setup();
  render(<ProviderApp base={base} />);
  expect(screen.getByText("Public browsing")).toBeInTheDocument();
  let provider!: ReturnType<typeof wallet>;
  act(() => {
    provider = wallet();
  });
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(await screen.findByText("Wallet workflow")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Draft 0" }));
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeInTheDocument();
  await act(async () => {
    provider.change({
      networkHash: base.networkIdHex,
      accounts: [account(2n)],
    });
  });
  expect(screen.getByRole("button", { name: "Draft 0" })).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Wallet account" })).toBeNull();
  expect(screen.getByRole("button", { name: "Disconnect" })).toHaveTextContent(
    `${account(2n).address.slice(0, 6)}...${account(2n).address.slice(-4)}`,
  );
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByText("Public browsing")).toBeInTheDocument();
  expect(provider.request).toHaveBeenCalledWith({ method: "disconnect" });
});
it("retains equivalent config objects but requires explicit reconnection after a public config change", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  const view = render(<ProviderApp base={base} />);
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  await user.click(screen.getByRole("button", { name: "Draft 0" }));
  const reads = vi.mocked(createReadClient).mock.calls.length;
  view.rerender(
    <ProviderApp
      base={{
        ...base,
        rpcUrl: new URL(base.rpcUrl.href),
        expectedTokenHash: new Uint8Array(base.expectedTokenHash),
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeVisible();
  expect(vi.mocked(createReadClient).mock.calls).toHaveLength(reads);
  for (const next of [
    { ...base, rpcUrl: new URL("http://localhost:9546") },
    { ...base, networkIdHex: "ff".repeat(32) },
    { ...base, factoryAddress: addressFromHex(`0x${"09".repeat(32)}`) },
    { ...base, expectedTokenHash: new Uint8Array(32).fill(9) },
    { ...base, explorerUrl: "https://explorer.test" },
    { ...base, swapAppUrl: "https://swap.test" },
  ]) {
    view.rerender(<ProviderApp base={next} />);
    expect(screen.getByText("Public browsing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Draft 0" })).toBeVisible();
    expect(provider.request).toHaveBeenCalledTimes(1);
  }
});
it("shows rejection, permits retry, and removes wallet workflows on wrong-network events", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  provider.request.mockRejectedValueOnce(new Error("User rejected connection"));
  render(<ProviderApp base={base} />);
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "User rejected connection",
  );
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(await screen.findByText("Wallet workflow")).toBeInTheDocument();
  await act(async () => {
    provider.change({ networkHash: "cd".repeat(32), accounts: [account(1n)] });
  });
  expect(screen.getByText("Public browsing")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "configured launchpad network",
  );
});
it("hides Disconnect before approval and on an empty account session, then allows reconnect", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  let resolve!: (session: WalletSession) => void;
  provider.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<ProviderApp base={base} />);
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  await act(async () =>
    resolve({ networkHash: base.networkIdHex, accounts: [account(1n)] }),
  );
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await act(async () =>
    provider.change({ networkHash: base.networkIdHex, accounts: [] }),
  );
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  provider.request.mockResolvedValueOnce({
    networkHash: base.networkIdHex,
    accounts: [account(1n)],
  });
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(
    await screen.findByRole("button", { name: "Disconnect" }),
  ).toBeVisible();
});
it("does not revive an old connect result after a session change", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  let resolve!: (session: WalletSession) => void;
  provider.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<ProviderApp base={base} />);
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  await act(async () => {
    provider.change({ networkHash: base.networkIdHex, accounts: [] });
    resolve({ networkHash: base.networkIdHex, accounts: [account(1n)] });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Connect Test Wallet" }),
    ).toBeEnabled(),
  );
  expect(screen.getByText("Public browsing")).toBeInTheDocument();
});
