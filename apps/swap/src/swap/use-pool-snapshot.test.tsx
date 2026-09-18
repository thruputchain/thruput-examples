import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressFromHex } from "@groundhogchain/client";
import { TestProviders } from "@/test/render";
const address = addressFromHex(`0x${"01".repeat(32)}`);
const config = { rpcUrl: new URL("http://localhost"), networkIdHex: "00".repeat(32), accountAddress: address, factoryAddress: address, routerAddress: address, nativeHogAddress: address, handlerAddress: address, driverAddress: address, liquidityTokenAddress: address, tokenAAddress: address, tokenBAddress: address, tokenASymbol: "A", tokenBSymbol: "B", tokenADecimals: 7, tokenBDecimals: 7 };

import type { PoolSnapshot } from "@/swap/snapshot";

import {
  SNAPSHOT_REFRESH_INTERVAL_MS,
  usePoolSnapshot,
} from "./use-pool-snapshot";

afterEach(() => {
  vi.useRealTimers();
});

describe("usePoolSnapshot", () => {
  it("ignores an older read after a post-action refresh completes", async () => {
    let resolveFirst!: (value: PoolSnapshot) => void;
    const first = new Promise<PoolSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const latest = { chainHeight: 9n } as PoolSnapshot;
    const read = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(latest);
    const { result } = renderHook(() => usePoolSnapshot(read, config), { wrapper: TestProviders });

    await act(async () => result.current.refresh());
    expect(result.current.snapshot).toBe(latest);
    await act(async () => resolveFirst({ chainHeight: 8n } as PoolSnapshot));
    expect(result.current.snapshot).toBe(latest);
    expect(result.current.isRefreshing).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refreshes visible pool data on the quote interval", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({ chainHeight: 1n } as PoolSnapshot);
    renderHook(() => usePoolSnapshot(read, config), { wrapper: TestProviders });

    await act(async () => {
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_INTERVAL_MS);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not overlap background refreshes", async () => {
    vi.useFakeTimers();
    const read = vi.fn(
      () => new Promise<PoolSnapshot>(() => undefined),
    );
    renderHook(() => usePoolSnapshot(read, config), { wrapper: TestProviders });

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_INTERVAL_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
