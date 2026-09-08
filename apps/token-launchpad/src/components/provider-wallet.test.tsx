import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivateKeySigner, toHex0x } from "@groundhogchain/client";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import { createPubkeyAccount } from "@groundhogchain/client/wallet";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "@/config";
import { ProviderApp, WalletControls } from "./provider-wallet";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/groundhog/client", () => ({ createReadClient: () => ({}) }));
vi.mock("@/app", () => ({
  LaunchpadRoutes: ({ readOnly }: { readOnly: boolean }) => {
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
  },
}));
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
  expect(screen.getByLabelText(account(2n).address)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByText("Public browsing")).toBeInTheDocument();
  expect(provider.request).toHaveBeenCalledWith({ method: "disconnect" });
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
