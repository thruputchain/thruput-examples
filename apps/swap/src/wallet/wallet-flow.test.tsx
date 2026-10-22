import {
  addressFromBase58,
  createThruputClient,
  localnet,
  MockTransport,
  Ed25519Signer,
  toBase58,
} from "@thruputchain/client";
import { createPubkeyAccount } from "@thruputchain/client/wallet";
import {
  registerWalletProvider,
  type WalletProvider,
  type WalletSession,
} from "@thruputchain/client/provider";
import {
  calldata,
  contractEntrypointID,
  gasAmount,
} from "@thruputchain/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Link } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { READ_ONLY_CALLER, type GlobalConfig } from "@/config";
import { AppProviders } from "@/app-providers";
import { AppRoutes } from "@/routes";
import { AppLayout } from "@/app-layout";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { useTransactions } from "@/transactions/use-transactions";

let writer: WriteBoundary;
vi.mock("@/pools/pool-directory-page", () => ({
  PoolDirectoryPage: () => (
    <>
      <Link to="/pools/new">Create pool</Link>
      <input aria-label="Directory search" />
    </>
  ),
}));
vi.mock("@/pools/pool-create-page", () => ({
  PoolCreatePage: ({ config }: { config: GlobalConfig }) => {
    writer = useTransactions(config);
    return (
      <>
        <input aria-label="Route draft" />
      </>
    );
  },
}));
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost/thruput-rpc"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: READ_ONLY_CALLER,
  factoryAddress: addressFromBase58(toBase58(new Uint8Array(32).fill(0x03))),
  routerAddress: addressFromBase58(toBase58(new Uint8Array(32).fill(0x04))),
  nativeTokenAddress: addressFromBase58(toBase58(new Uint8Array(32).fill(0x05))),
};
const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
const local = createPubkeyAccount({ signer });
const session: WalletSession = {
  networkHash: toBase58(new Uint8Array(32)),
  accounts: [
    {
      address: toBase58(local.address),
      publicKey: toBase58(signer.publicKey.ed25519),
      nonce: "0",
    },
  ],
};
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

it("preserves public filters, resets write forms on rebinding, and invalidates old batch writers", async () => {
  const listeners = new Set<(session: WalletSession) => void>();
  const request = vi.fn<WalletProvider["request"]>(async (input) => {
    if (input.method === "getCapabilities")
      return { ...input.params, atomicBatch: { maxCalls: 3 } };
    if (input.method === "signTransaction") throw new Error("Not approved");
    return session;
  });
  cleanups.push(
    registerWalletProvider({
      info: { id: "test", name: "Test Wallet", version: "2.0.0" },
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
  const client = await createThruputClient({
    cluster: localnet(),
    transport: new MockTransport(),
  });
  render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={["/pools"]}>
        <AppLayout>
          <AppRoutes config={config} />
        </AppLayout>
      </MemoryRouter>
    </AppProviders>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Directory search"), "pair");
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  expect(screen.getByLabelText("Directory search")).toHaveValue("pair");
  await user.click(screen.getByRole("link", { name: "Create pool" }));
  const old = writer!;
  expect(await old.supportsBatch?.(3)).toBe(true);
  await user.type(screen.getByLabelText("Route draft"), "draft");
  await act(async () => listeners.forEach((listener) => listener(session)));
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
    request.mock.calls.some(([input]) => input.method === "signTransaction"),
  ).toBe(false);
});
