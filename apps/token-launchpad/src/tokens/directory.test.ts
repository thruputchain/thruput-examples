import { act, renderHook, waitFor } from "@/test/render";
import { afterEach, expect, it, vi } from "vitest";
import { toBase58 } from "@thruputchain/client";
import { configuration } from "@/test/fixtures";
import type { RegistryStatus, RegistryTokenPage } from "@/registry/client";
import { useTokenDirectory } from "./use-token-directory";

const config = configuration();
const page = (asOfBlock = "12"): RegistryTokenPage => ({
  tokens: [],
  total: 0,
  limit: 20,
  offset: 0,
  asOfBlock,
  hasMore: false,
  historyLimited: false,
});
const status: RegistryStatus = {
  networkId: config.networkId,
  factoryAddress: toBase58(config.factoryAddress),
  indexedThroughBlock: "12",
  tokenCount: 0,
  historyLimited: false,
  syncState: "idle",
  syncing: false,
  lastSuccessfulSyncAt: null,
  lastError: null,
};
const noSync = () => new Promise<RegistryStatus>(() => {});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("filters by creator, retains pagination snapshot, and ignores superseded pages", async () => {
  const read = vi.fn().mockResolvedValue(page());
  const { result } = renderHook(() =>
    useTokenDirectory({
      config,
      scope: "mine",
      readOnly: true,
      registryRead: read,
      registrySync: noSync,
    }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(read.mock.calls[0]?.[1]).toMatchObject({
    creator: toBase58(config.accountAddress),
    offset: 0,
  });
  let old!: (page: RegistryTokenPage) => void;
  read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue(page("99"));
  act(() => result.current.changePage(20));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1]?.[1]).toMatchObject({
    offset: 20,
    asOfBlock: "12",
  });
  act(() => result.current.setSort("oldest"));
  await waitFor(() => expect(result.current.page?.asOfBlock).toBe("99"));
  await act(async () => old(page("18")));
  expect(result.current.page?.asOfBlock).toBe("99");
});

it("refreshes on visibility without overlapping reads or replacing data on failure", async () => {
  vi.useFakeTimers();
  const visible = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const read = vi.fn().mockResolvedValue(page());
  const options = {
    config,
    scope: "all" as const,
    readOnly: true,
    registryRead: read,
    registrySync: vi.fn().mockResolvedValue(status),
    registryStatus: vi.fn().mockResolvedValue(status),
  };
  const { result } = renderHook(() => useTokenDirectory(options));
  await act(async () => {});
  const before = read.mock.calls.length;
  visible.mockReturnValue("hidden");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(before);
  let reject!: (error: Error) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  visible.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(before + 1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  await act(async () => reject(new Error("offline")));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.page?.asOfBlock).toBe("12");
  expect(result.current.error).toBeTruthy();
});
