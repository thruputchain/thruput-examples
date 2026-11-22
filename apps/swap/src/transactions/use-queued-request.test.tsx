// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQueuedRequest } from "./use-queued-request";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  onDone: undefined as undefined | ((done: unknown) => void),
  outcome: vi.fn(),
  pending: null as unknown,
}));
vi.mock("@thruputchain/react", () => ({ useClient: () => ({}) }));
vi.mock("./use-wallet-transaction", () => ({
  useWalletTransaction: (_key: string, onDone: (done: unknown) => void) => {
    mocks.onDone = onDone;
    return {
      send: mocks.send,
      pending: mocks.pending,
      busy: false,
      blocked: false,
      message: null,
      reset: () => {},
    };
  },
}));
vi.mock("@/contracts/swap", () => ({
  acceptedRequestId: () => new Uint8Array(32).fill(7),
  crank: (driver: unknown) => ({ crank: driver }),
  findRequestOutcome: mocks.outcome,
}));

const account = contractAddress(new Uint8Array(32).fill(3));
const pool = {
  driver: contractAddress(new Uint8Array(32).fill(1)),
  handler: contractAddress(new Uint8Array(32).fill(2)),
};
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.outcome.mockReset().mockResolvedValue(null);
});
afterEach(() => localStorage.clear());

it("queues the request, cranks once, then reports the outcome", async () => {
  const { result } = renderHook(() => useQueuedRequest("net", account), {
    wrapper,
  });
  await act(() => result.current.submit("Swap", pool, []));
  expect(mocks.send).toHaveBeenCalledWith("Swap", { calls: [] }, {
    kind: "request",
    label: "Swap",
    driver: toBase58(pool.driver),
    handler: toBase58(pool.handler),
  });

  // The request committed: save its ID, then send one crank.
  act(() =>
    mocks.onDone!({
      succeeded: true,
      label: "Swap",
      context: {
        kind: "request",
        label: "Swap",
        driver: toBase58(pool.driver),
        handler: toBase58(pool.handler),
      },
      receipt: { blockHeight: 9n },
    }),
  );
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(mocks.send.mock.lastCall![0]).toBe("Process the queue");
  expect(result.current.queued).toMatchObject({ cranked: true, fromBlock: "9" });
  expect(mocks.outcome.mock.lastCall![4]).toBe(9n);

  // A crank processed the request.
  mocks.outcome.mockResolvedValue({ status: "done", amounts: [1n] });
  await waitFor(() => expect(result.current.finished).not.toBeNull(), {
    timeout: 5_000,
  });
  expect(result.current.queued).toBeNull();
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("does not crank again after a reload", async () => {
  localStorage.setItem(
    `swap:net:${toBase58(account)}:queued`,
    JSON.stringify({
      label: "Swap",
      driver: toBase58(pool.driver),
      handler: toBase58(pool.handler),
      requestId: `0x${"07".repeat(32)}`,
      fromBlock: "9",
      cranked: true,
    }),
  );
  const { result } = renderHook(() => useQueuedRequest("net", account), {
    wrapper,
  });
  await waitFor(() => expect(mocks.outcome).toHaveBeenCalled());
  expect(result.current.queued?.cranked).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
});
