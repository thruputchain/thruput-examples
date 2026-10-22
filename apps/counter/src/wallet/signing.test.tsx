// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createThruputClient,
  createPubkeyAccount,
  defineCluster,
  Ed25519Signer,
  toBase58,
} from "@thruputchain/client";
import { MockTransport } from "@thruputchain/client/transport";
import {
  registerWalletProvider,
  type WalletProvider as Provider,
  type WalletSession,
} from "@thruputchain/client/provider";
import type { ProviderWalletClient } from "@thruputchain/client/wallet";
import { CxsWriter, networkHash, sha256Hash } from "@thruputchain/protocol";
import { WalletProvider, useWalletClient } from "@thruputchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectedCounter } from "../app";
import { initialSnapshot } from "../transactions/engine";
import type { AppConfig } from "../config";

const { sendDevelopment, worker } = vi.hoisted(() => ({
  sendDevelopment: vi.fn(),
  worker: vi.fn(),
}));
vi.mock("../transactions/use-counter", () => ({ useCounter: worker }));
const caches: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _options: unknown,
        action: (lock: object) => Promise<void>,
      ) => action({}),
    },
  });
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((cache) => cache.clear());
  localStorage.clear();
  vi.restoreAllMocks();
  sendDevelopment.mockClear();
  worker.mockClear();
});

async function setup(withSigner = true) {
  worker.mockImplementation(() => ({
    snapshot: { ...initialSnapshot, ready: true, signerBalance: 10_000_000n },
    send: sendDevelopment,
  }));
  const network = toBase58(new Uint8Array(32));
  const accounts = [1, 2].map((seed) => {
    const signer = new Ed25519Signer(new Uint8Array(32).fill(seed));
    return {
      address: toBase58(createPubkeyAccount({ signer }).address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    };
  });
  const config: AppConfig = {
    networkId: network,
    counterAddress: toBase58(new Uint8Array(32).fill(0x22)),
    signerAddress: withSigner ? toBase58(new Uint8Array(32).fill(0x33)) : null,
    explorerUrl: null,
  };
  const client = await createThruputClient({
    cluster: defineCluster({
      networkHash: networkHash(sha256Hash(new Uint8Array(32))),
      capabilities: [],
    }),
    transport: new MockTransport(),
  });
  const writer = new CxsWriter();
  writer.writeUint64(10n);
  vi.spyOn(client, "simulateInvocation").mockResolvedValue({
    stateBlockHeight: 1n,
    output: { result: "return", returnData: writer.finish() },
    events: [],
    gasUsed: 1n,
  });
  let session: WalletSession = { networkHash: network, accounts: [] };
  const listeners = new Set<(session: WalletSession) => void>();
  const change = (next: WalletSession) => {
    session = next;
    listeners.forEach((listener) => listener(next));
  };
  const provider: Provider = {
    info: { id: "test-wallet", name: "Test wallet", version: "2.0.0" },
    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async request(request) {
      if (request.method === "connect") {
        change({ networkHash: network, accounts });
        return session;
      }
      if (request.method === "disconnect") {
        change({ networkHash: network, accounts: [] });
        return null;
      }
      if (request.method === "getSession") return session;
      throw new Error("Unexpected test request");
    },
  };
  const target = new EventTarget();
  registerWalletProvider(provider, target);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(queries);
  let binding: ProviderWalletClient | null = null;
  function Probe() {
    binding = useWalletClient();
    return null;
  }
  render(
    <QueryClientProvider client={queries}>
      <WalletProvider client={client} discoveryTarget={target}>
        <Probe />
        <ConnectedCounter config={config} />
      </WalletProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("10");
  return {
    config,
    accounts,
    network,
    change,
    get binding() {
      return binding;
    },
  };
}

it("uses the header wallet when connected and falls back after disconnection", async () => {
  const s = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Increment" }));
  expect(sendDevelopment).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(s.binding).not.toBeNull());
  await screen.findByRole("button", { name: "Disconnect" });
  expect(screen.queryByRole("button", { name: /^Top up Signer/ })).toBeNull();
  expect(worker).toHaveBeenLastCalledWith(s.config, false);
  const execute = vi
    .spyOn(s.binding!, "executeAndWait")
    .mockRejectedValue(new Error("Wallet rejected the request"));
  fireEvent.click(screen.getByRole("button", { name: "Increment" }));
  await screen.findByText("Wallet rejected the request");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(sendDevelopment).toHaveBeenCalledTimes(1);
  act(() => s.change({ networkHash: s.network, accounts: [] }));
  await waitFor(() => expect(worker).toHaveBeenLastCalledWith(s.config, true));
  expect(screen.getByRole("button", { name: /^Top up Signer/ })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Connect wallet" }).closest("header"),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Increment" }));
  expect(sendDevelopment).toHaveBeenCalledTimes(2);
});

it("does not fall back to the development signer after a wallet network change", async () => {
  const s = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(s.binding).not.toBeNull());
  act(() =>
    s.change({
      networkHash: toBase58(new Uint8Array(32).fill(0x11)),
      accounts: s.accounts,
    }),
  );
  await screen.findByText("Select the application's network in your wallet.");
  expect(
    (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(worker).toHaveBeenLastCalledWith(s.config, false);
  expect(sendDevelopment).not.toHaveBeenCalled();
});

it("keeps reads available without a configured development key", async () => {
  await setup(false);
  expect(screen.getByTestId("counter-value").textContent).toBe("10");
  expect(screen.queryByText(/· stale/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});
