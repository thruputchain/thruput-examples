import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configuration } from "@/test/fixtures";
import { testAccount, testClient, testWallet } from "@/test/wallet";
import { workflowStorageKey } from "@/launch/workflow";
import { WalletProvider } from "./wallet-provider";
import { WalletControls } from "./wallet-controls";
import { WalletInstallBanner } from "./wallet-install-banner";
import { createReadClient } from "@/groundhog/client";

vi.mock("@/groundhog/client", async (original) => ({
  ...(await original<typeof import("@/groundhog/client")>()),
  createReadClient: vi.fn(),
}));
const base = configuration();
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(createReadClient).mockImplementation((config) =>
    testClient(config.networkIdHex),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

function Probe({ connected }: { connected: boolean }) {
  const [draft, setDraft] = useState(0);
  return (
    <>
      <WalletInstallBanner />
      <WalletControls />
      <p>{connected ? "Wallet workflow" : "Public browsing"}</p>
      <button onClick={() => setDraft(draft + 1)}>Draft {draft}</button>
    </>
  );
}
function App({ config = base }: { config?: typeof base }) {
  return (
    <WalletProvider config={config}>
      {(config, connected) => (
        <Probe key={workflowStorageKey(config)} connected={connected} />
      )}
    </WalletProvider>
  );
}
function wallet() {
  const wallet = testWallet(base.networkIdHex);
  cleanups.push(wallet.unregister);
  return wallet;
}

it("retries failed RPC initialization before enabling wallet controls", async () => {
  vi.mocked(createReadClient).mockRejectedValueOnce(new Error("RPC offline"));
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("RPC offline");
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Public browsing")).toBeVisible();
  expect(createReadClient).toHaveBeenCalledTimes(2);
});

it("shares one client and preserves drafts on reconnect while isolating account changes", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  const view = render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect Test Wallet" }),
  );
  await user.click(screen.getByRole("button", { name: "Draft 0" }));
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeVisible();
  view.rerender(<App config={{ ...base, rpcUrl: new URL(base.rpcUrl) }} />);
  expect(createReadClient).toHaveBeenCalledTimes(1);
  await act(async () =>
    provider.change({
      networkHash: base.networkIdHex,
      accounts: [testAccount(2n)],
    }),
  );
  expect(screen.getByRole("button", { name: "Draft 0" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Disconnect" })).toHaveTextContent(
    testAccount(2n).address.slice(0, 6),
  );
  expect(createReadClient).toHaveBeenCalledTimes(1);
  view.rerender(
    <App config={{ ...base, rpcUrl: new URL("http://localhost:9546") }} />,
  );
  expect(await screen.findByText("Public browsing")).toBeVisible();
  expect(screen.getByRole("button", { name: "Draft 0" })).toBeVisible();
  expect(createReadClient).toHaveBeenCalledTimes(2);
});

it("quietly handles popup cancellation and gates wrong-network sessions", async () => {
  const user = userEvent.setup();
  const provider = wallet();
  provider.request.mockRejectedValueOnce(
    Object.assign(new Error("Page closed"), { code: 4001 }),
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect Test Wallet" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Public browsing")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.getByText("Wallet workflow")).toBeVisible();
  await act(async () =>
    provider.change({
      networkHash: "cd".repeat(32),
      accounts: [testAccount()],
    }),
  );
  expect(screen.getByText("Public browsing")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("network");
});
