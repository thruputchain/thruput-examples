import {
  createGroundhogClient,
  localnet,
  MockTransport,
  toHex0x,
  hashFromHex,
  TransactionReceiptTimeoutError,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { useClient } from "@groundhogchain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { blockHeight, ExecResult } from "@groundhogchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { configuration } from "@/test/fixtures";
import { useTransactions } from "./use-transactions";

vi.mock("@groundhogchain/react", async (original) => ({
  ...(await original<typeof import("@groundhogchain/react")>()),
  useClient: vi.fn(),
  useWalletClient: () => null,
}));
afterEach(() => vi.restoreAllMocks());

it("shares committed recovery across observers without wallet permission and retries only on explicit recovery", async () => {
  const client = await createGroundhogClient({
    cluster: localnet(),
    transport: new MockTransport(),
  });
  vi.mocked(useClient).mockReturnValue(client);
  const config = {
    ...configuration(),
    networkIdHex: toHex0x(client.network.networkHash).slice(2),
  };
  const hash = `0x${"02".repeat(32)}`;
  const receipt: TransactionReceipt = {
    txHash: hashFromHex(hash),
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
    ({ networkIdHex }) => useTransactions({ ...config, networkIdHex }),
    { wrapper, initialProps: { networkIdHex: config.networkIdHex } },
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
    rerender({ networkIdHex: "ff".repeat(32) });
    expect((await result.current.observe(hash)).kind).toBe("indeterminate");
    expect(wait).toHaveBeenCalledTimes(3);
  } finally {
    unmount();
    queries.clear();
  }
});
