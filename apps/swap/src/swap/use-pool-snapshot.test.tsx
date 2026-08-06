import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PoolSnapshot } from "@/swap/snapshot";

import {
  SNAPSHOT_REFRESH_INTERVAL_MS,
  usePoolSnapshot,
} from "./use-pool-snapshot";

afterEach(() => {
  vi.useRealTimers();
});

describe("usePoolSnapshot", () => {
  it("refreshes visible pool data on the quote interval", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({ chainHeight: 1n } as PoolSnapshot);
    renderHook(() => usePoolSnapshot(read));

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
    renderHook(() => usePoolSnapshot(read));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_INTERVAL_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
