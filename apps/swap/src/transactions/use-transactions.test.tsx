import {
  addressFromBase58,
  createThruputClient,
  hashFromBase58,
  localnet,
  MockTransport,
  toBase58,
  type TransactionReceipt,
  TransactionReceiptTimeoutError,
} from "@thruputchain/client";
import { useClient } from "@thruputchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { blockHeight } from "@thruputchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useTransactions } from "./use-transactions";

vi.mock("@thruputchain/react", async (original) => ({
  ...(await original<typeof import("@thruputchain/react")>()),
  useClient: vi.fn(),
  useWalletClient: () => null,
}));
afterEach(() => vi.restoreAllMocks());

it("shares committed recovery across observers without wallet permission and retries only on explicit recovery", async () => {
  const client = await createThruputClient({
    cluster: localnet(),
    transport: new MockTransport(),
  });
  vi.mocked(useClient).mockReturnValue(client);
  const address = addressFromBase58(toBase58(new Uint8Array(32).fill(0x01)));
  const config = {
    rpcUrl: new URL("http://localhost:9545"),
    networkId: toBase58(client.network.networkHash),
    accountAddress: address,
    factoryAddress: address,
    routerAddress: address,
    nativeTokenAddress: address,
  };
  const hash = toBase58(new Uint8Array(32).fill(0x02));
  const receipt: TransactionReceipt = {
    transactionHash: hashFromBase58(hash),
    blockHeight: blockHeight(1n),
    execution: { result: "abort" as const, abortData: new Uint8Array() },
    gasUsed: 0n,

    events: [],
  };
  const wait = vi
    .spyOn(client, "waitForTransactionReceipt")
    .mockResolvedValue(receipt);
  const queries = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queries}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ networkId }) => useTransactions({ ...config, networkId }),
    { wrapper, initialProps: { networkId: config.networkId } },
  );
  try {
    const outcomes = await Promise.all([
      result.current.observe(hash),
      result.current.observe(hash),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "committedFailure",
      "committedFailure",
    ]);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(
      receipt.transactionHash,
      expect.objectContaining({
        expectedNetworkHash: client.network.networkHash,
        signal: expect.any(AbortSignal),
      }),
    );
    await result.current.observe(hash);
    expect(wait).toHaveBeenCalledOnce();
    queries.clear();
    wait.mockRejectedValueOnce(
      new TransactionReceiptTimeoutError(
        receipt.transactionHash,
        undefined,
        undefined,
      ),
    );
    expect((await result.current.observe(hash)).kind).toBe("indeterminate");
    expect(wait).toHaveBeenCalledTimes(2);
    expect((await result.current.observe(hash)).kind).toBe("committedFailure");
    expect(wait).toHaveBeenCalledTimes(3);
    rerender({ networkId: toBase58(new Uint8Array(32).fill(0xff)) });
    expect((await result.current.observe(hash)).kind).toBe("indeterminate");
    expect(wait).toHaveBeenCalledTimes(3);
  } finally {
    unmount();
    queries.clear();
  }
});
