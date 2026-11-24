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
const queuedKey = `swap:net:${toBase58(account)}:queued`;
const saved = (requestId: string) =>
  JSON.stringify({
    label: "Swap",
    driver: toBase58(contractAddress(new Uint8Array(32).fill(1))),
    handler: toBase58(contractAddress(new Uint8Array(32).fill(2))),
    requestId: `0x${requestId.repeat(32)}`,
    fromBlock: "9",
    cranked: true,
  });
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
  const build = () => ({ calls: [] });
  await act(() => result.current.submit("Swap", pool, build));
  expect(mocks.send).toHaveBeenCalledWith("Swap", build, {
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
  expect(mocks.send.mock.lastCall![1]()).toEqual({
    calls: [{ crank: pool.driver }],
  });
  const crankContext = mocks.send.mock.lastCall![2];
  // Not cranked until the crank commits, but not asked for twice either.
  expect(result.current.queued).toMatchObject({ cranked: false, fromBlock: "9" });
  expect(result.current.canCrankAgain).toBe(true);
  expect(mocks.outcome.mock.lastCall![4]).toBe(9n);

  act(() =>
    mocks.onDone!({
      succeeded: true,
      label: "Process the queue",
      context: crankContext,
      receipt: { blockHeight: 10n },
    }),
  );
  expect(result.current.queued?.cranked).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(2);

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

it("asks for the crank again after a reload that interrupted signing", async () => {
  localStorage.setItem(queuedKey, saved("07").replace('"cranked":true', '"cranked":false'));
  const { result } = renderHook(() => useQueuedRequest("net", account), {
    wrapper,
  });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.lastCall![0]).toBe("Process the queue");
  // The wallet returned without a crank; the app does not ask again on its own.
  await new Promise((done) => setTimeout(done, 100));
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(result.current.canCrankAgain).toBe(true);
});

it("runs one check at a time, and a late check does not clear the next request", async () => {
  let resolve!: (outcome: unknown) => void;
  mocks.outcome.mockReturnValue(new Promise((done) => (resolve = done)));
  localStorage.setItem(queuedKey, saved("07"));
  const { result } = renderHook(() => useQueuedRequest("net", account), {
    wrapper,
  });
  await waitFor(() => expect(mocks.outcome).toHaveBeenCalledTimes(1));

  // The interval fires while the first check is still running.
  await new Promise((done) => setTimeout(done, 3_200));
  expect(mocks.outcome).toHaveBeenCalledTimes(1);

  // Meanwhile, a later request replaced the first one.
  localStorage.setItem(queuedKey, saved("08"));
  await act(async () => resolve({ status: "done", amounts: [1n] }));
  expect(JSON.parse(localStorage.getItem(queuedKey)!).requestId).toBe(
    `0x${"08".repeat(32)}`,
  );
  expect(result.current.finished).toBeNull();
}, 10_000);

it("lets the user forget a request whose outcome cannot be read", async () => {
  mocks.outcome.mockRejectedValue(
    new Error("History retention no longer covers the requested range"),
  );
  localStorage.setItem(queuedKey, saved("07"));
  const { result } = renderHook(() => useQueuedRequest("net", account), {
    wrapper,
  });
  await waitFor(() => expect(result.current.unreadable).toBe(true));
  expect(result.current.busy).toBe(true);

  act(() => result.current.forget());
  expect(result.current.queued).toBeNull();
  expect(result.current.busy).toBe(false);
  expect(localStorage.getItem(queuedKey)).toBeNull();
});
