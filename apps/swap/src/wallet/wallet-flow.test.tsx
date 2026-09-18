import {
  addressFromHex,
  createGroundhogClient,
  localnet,
  MockTransport,
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
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { READ_ONLY_CALLER, type GlobalConfig } from "@/config";
import { createNetworkReadClient } from "@/groundhog/client";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { WalletProvider as AppWalletProvider } from "./wallet-provider";
import { WalletControls } from "./wallet-controls";
import { WalletInstallBanner } from "./wallet-install-banner";
import { useWalletWriteBoundary } from "./write-context";

vi.mock("@/groundhog/client", async (original) => ({
  ...(await original<typeof import("@/groundhog/client")>()),
  createNetworkReadClient: vi.fn(),
}));
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: READ_ONLY_CALLER,
  registryEnabled: true,
  factoryAddress: addressFromHex(`0x${"03".repeat(32)}`),
  routerAddress: addressFromHex(`0x${"04".repeat(32)}`),
  nativeHogAddress: addressFromHex(`0x${"05".repeat(32)}`),
};
function account(seed: number) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(seed));
  const local = createPubkeyAccount({ signer, nonce: 0n });
  return {
    address: toHex0x(local.address),
    publicKey: toHex0x(signer.publicKey.ed25519),
    nonce: "0",
  };
}
const accounts = [account(1), account(2)];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(createNetworkReadClient).mockImplementation(() =>
    createGroundhogClient({
      cluster: localnet(),
      transport: new MockTransport(),
    }),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});
function wallet() {
  let session: WalletSession = { networkHash: config.networkIdHex, accounts };
  const listeners = new Set<(session: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async (input) => {
    if (input.method === "getCapabilities")
      return { ...input.params, atomicBatch: { maxCalls: 3 } };
    if (input.method === "signTransaction") throw new Error("Not approved");
    return session;
  });
  cleanups.push(
    registerWalletProvider({
      info: { id: "test", name: "Test Wallet", version: "1.0.0" },
      supportedMethods: ["getCapabilities"],
      request,
      on(_event, listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
  );
  return {
    request,
    change(next = session) {
      session = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}
function renderApp() {
  let writer!: WriteBoundary;
  function Probe({
    runtime,
    connected,
  }: {
    runtime: GlobalConfig;
    connected: boolean;
  }) {
    writer = useWalletWriteBoundary();
    return (
      <>
        <WalletInstallBanner />
        <WalletControls />
        <output aria-label="Runtime caller">
          {toHex0x(runtime.accountAddress)}
        </output>
        <output aria-label="Writable">{String(connected)}</output>
        <input aria-label="Route draft" />
      </>
    );
  }
  const tree = (config: GlobalConfig) => (
    <StrictMode>
      <AppWalletProvider config={config}>
        {(runtime, connected, revision) => (
          <Probe key={revision} runtime={runtime} connected={connected} />
        )}
      </AppWalletProvider>
    </StrictMode>
  );
  const view = render(tree(config));
  return {
    ...view,
    writer: () => writer,
    rerenderConfig: (config: GlobalConfig) => view.rerender(tree(config)),
  };
}

it("initializes a public client without wallet permission and offers RPC retry", async () => {
  vi.mocked(createNetworkReadClient).mockRejectedValueOnce(
    new Error("RPC unavailable"),
  );
  const provider = wallet();
  renderApp();
  expect(await screen.findByRole("alert")).toHaveTextContent("RPC unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("Writable")).toHaveTextContent("false");
  expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
    toHex0x(READ_ONLY_CALLER),
  );
  expect(provider.request).not.toHaveBeenCalled();
});

it("keeps a stable client, supports batching, and resets forms and writers with the binding", async () => {
  const provider = wallet();
  const app = renderApp();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Connect Test Wallet" }),
  );
  const old = app.writer();
  expect(await old.supportsBatch?.(3)).toBe(true);
  expect(await old.supportsBatch?.(4)).toBe(false);
  await user.type(screen.getByLabelText("Route draft"), "draft");
  app.rerenderConfig({ ...config, rpcUrl: new URL(config.rpcUrl) });
  expect(screen.getByLabelText("Route draft")).toHaveValue("draft");
  const reads = vi.mocked(createNetworkReadClient).mock.calls.length;
  await act(async () => provider.change());
  expect(screen.getByLabelText("Route draft")).toHaveValue("");
  expect(
    await old.execute({
      invoked_address: config.factoryAddress,
      entrypoint: contractEntrypointID(new Uint8Array(8)),
      calldata: calldata(new Uint8Array()),
      gas_limit: gasAmount(1000n),
    }),
  ).toMatchObject({ kind: "preSubmissionFailure" });
  expect(
    provider.request.mock.calls.some(
      ([input]) => input.method === "signTransaction",
    ),
  ).toBe(false);
  await act(async () =>
    provider.change({
      networkHash: config.networkIdHex,
      accounts: [accounts[1]!],
    }),
  );
  expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
    accounts[1]!.address,
  );
  expect(createNetworkReadClient).toHaveBeenCalledTimes(reads);
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByLabelText("Writable")).toHaveTextContent("false");
  app.rerenderConfig({ ...config, rpcUrl: new URL("http://localhost:9546") });
  expect(await screen.findByLabelText("Writable")).toHaveTextContent("false");
});

it("quietly handles closed popups and prevents writes on the wrong network", async () => {
  const provider = wallet();
  provider.request.mockRejectedValueOnce(
    Object.assign(new Error("Page closed"), { code: 4001 }),
  );
  renderApp();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Connect Test Wallet" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  await act(async () =>
    provider.change({ networkHash: "ab".repeat(32), accounts }),
  );
  expect(screen.getByLabelText("Writable")).toHaveTextContent("false");
  expect(screen.getByLabelText("Runtime caller")).toHaveTextContent(
    toHex0x(READ_ONLY_CALLER),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("network");
});
