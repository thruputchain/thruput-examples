import {
  createThruputClient,
  localnet,
  MockTransport,
  hashFromBase58,
  TransactionReceiptTimeoutError,
  type TransactionReceipt,
  toBase58,
} from "@thruputchain/client";
import { useClient } from "@thruputchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { blockHeight, ExecResult } from "@thruputchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { configuration } from "@/test/fixtures";
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
  const config = {
    ...configuration(),
    networkId: toBase58(client.network.networkHash),
  };
  const hash = toBase58(new Uint8Array(32).fill(0x02));
  const receipt: TransactionReceipt = {
    txHash: hashFromBase58(hash),
    height: blockHeight(1n),
    execResult: ExecResult.ExecResultTxRootFrameReverted,
    gasUsed: 0n,
    returnData: null,
    abortData: null,
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
      receipt.txHash,
      expect.objectContaining({
        expectedNetworkHash: client.network.networkHash,
        signal: expect.any(AbortSignal),
      }),
    );
    await result.current.observe(hash);
    expect(wait).toHaveBeenCalledOnce();
    queries.clear();
    wait.mockRejectedValueOnce(
      new TransactionReceiptTimeoutError(receipt.txHash, undefined),
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
