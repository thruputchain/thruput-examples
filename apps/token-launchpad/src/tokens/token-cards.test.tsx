import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WalletProvider, useWallet } from "@thruputchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CxsWriter } from "@thruputchain/protocol";
import { toBase58 } from "@thruputchain/client";
import { testAccount, testClient, testWallet } from "@/test/wallet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TokenCards } from "./token-cards";

afterEach(() => vi.restoreAllMocks());

it("loads all visible balances concurrently and isolates account changes and failures", async () => {
  const network = toBase58(new Uint8Array(32).fill(0x00));
  const client = await testClient(network);
  const wallet = testWallet(network);
  const queries = new QueryClient();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = vi.spyOn(client, "view").mockImplementation(async (request) => {
    await pending;
    if (request.contract[31] === 2) throw new Error("Token unavailable");
    const data = new CxsWriter();
    data.writeUint128(
      request.caller && toBase58(request.caller) === testAccount().address
        ? 100n
        : 200n,
    );
    return {
      output: { result: "return", returnData: data.finish() },
      height: 1n,
      events: [],
      gasUsed: 0n,
    };
  });
  const tokens = Array.from({ length: 20 }, (_, i) => ({
    address: toBase58(
      Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 0)),
    ),
    name: `Token ${i}`,
    symbol: `T${i}`,
    decimals: 0,
    initialSupply: 1000n,
    administrator: testAccount().address,
    holder: testAccount().address,
    block: 1n,
    transactionHash: toBase58(new Uint8Array(32).fill(0x01)),
  }));
  function Cards() {
    const wallet = useWallet();
    return (
      <>
        <button onClick={() => void wallet.connect()}>Connect</button>
        <TokenCards tokens={tokens} connected={wallet.status === "connected"} />
      </>
    );
  }
  const rendered = render(
    <QueryClientProvider client={queries}>
      <WalletProvider client={client}>
        <TooltipProvider>
          <Cards />
        </TooltipProvider>
      </WalletProvider>
    </QueryClientProvider>,
  );
  try {
    expect(screen.getByText(/^Token 19 ·/)).toBeVisible();
    expect(view).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(view).toHaveBeenCalledTimes(20));
    await act(async () =>
      wallet.change({ networkHash: network, accounts: [testAccount(2n)] }),
    );
    await waitFor(() => expect(view).toHaveBeenCalledTimes(40));
    await act(async () => release());
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .filter((node) => node.textContent === "200"),
      ).toHaveLength(19),
    );
    expect(
      await screen.findByText("Unavailable", {}, { timeout: 2500 }),
    ).toBeVisible();
    expect(screen.queryByText("100", { exact: true })).toBeNull();
    expect(screen.getByText(/^Token 1 ·/)).toBeVisible();
  } finally {
    rendered.unmount();
    wallet.unregister();
    queries.clear();
  }
});
