import { act, renderHook, waitFor } from "@testing-library/react";
import { contractAddress } from "@thruputchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import {
  NetworkMismatchError,
} from "@/groundhog/client";
import { readTokenPreview, useTokenPreview } from "./token-preview";
import { testClient, TestProviders } from "@/test/render";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
}));
const address = (n: number) => contractAddress(new Uint8Array(32).fill(n));
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const config: GlobalConfig = {
  rpcUrl: new URL("http://localhost:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  factoryAddress: address(2),
  routerAddress: address(3),
  nativeHogAddress: address(4),
};
const view = <T>(value: T) => ({ value, height: 1n, events: [] });
const metadata = {
  name: view("Live Name"),
  symbol: view("LIVE"),
  decimals: view(6),
};
const read = vi.fn();
const network = vi.fn();
const client = { ...testClient, getNetworkInfo: network };

beforeEach(() => {
  vi.clearAllMocks();
  network.mockReset().mockResolvedValue({ networkHash: new Uint8Array(32) });
  read.mockReset().mockResolvedValue(metadata);
  vi.mocked(createErc20ReadAdapter).mockReturnValue({
    metadata: read,
    balanceOf: vi.fn(),
    allowance: vi.fn(),
  });
});

describe("live token previews", () => {
  it("checks the actual network before metadata and uses the configured caller", async () => {
    const signal = new AbortController().signal;
    await expect(readTokenPreview(config, hex(8), signal, client)).resolves.toEqual({
      name: "Live Name",
      symbol: "LIVE",
      decimals: 6,
    });
    expect(createErc20ReadAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: config.accountAddress,
        contract: address(8),
      }),
    );
    expect(network.mock.invocationCallOrder[0]).toBeLessThan(
      read.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed on network mismatch, without metadata reads", async () => {
    network.mockResolvedValue({ networkHash: new Uint8Array(32).fill(1) });
    await expect(
      readTokenPreview(config, hex(8), new AbortController().signal, client),
    ).rejects.toBeInstanceOf(NetworkMismatchError);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not invent missing metadata or decimals", async () => {
    read.mockResolvedValue({
      name: view(null),
      symbol: view(null),
      decimals: view(null),
    });
    await expect(
      readTokenPreview(config, hex(8), new AbortController().signal, client),
    ).resolves.toEqual({ name: null, symbol: null, decimals: null });
  });

  it("abandons old queries, suppresses late metadata, and never reads invalid addresses", async () => {
    let resolveOld!: (value: typeof metadata) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useTokenPreview(config, value, client),
      { initialProps: { value: hex(8) }, wrapper: TestProviders },
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rerender({ value: hex(9) });
    expect(result.current.preview).toEqual({ status: "pending" });
    await waitFor(() => expect(result.current.preview?.status).toBe("ready"));
    await act(async () => resolveOld({ ...metadata, name: view("OLD") }));
    expect(result.current.preview).toMatchObject({
      status: "ready",
      metadata: { name: "Live Name" },
    });
    rerender({ value: "0x" });
    expect(result.current.preview).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("rechecks network on retry and on caller/network changes", async () => {
    network.mockRejectedValueOnce(new NetworkMismatchError());
    const { result, rerender } = renderHook(
      ({ current }) => useTokenPreview(current, hex(8), client),
      { initialProps: { current: config }, wrapper: TestProviders },
    );
    await waitFor(() =>
      expect(result.current.preview).toEqual({
        status: "unavailable",
        networkMismatch: true,
      }),
    );
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.preview?.status).toBe("ready"));
    expect(network).toHaveBeenCalledTimes(2);
    rerender({ current: { ...config, accountAddress: address(7) } });
    expect(result.current.preview?.status).toBe("pending");
    await waitFor(() => expect(network).toHaveBeenCalledTimes(3));
    network.mockResolvedValue({ networkHash: new Uint8Array(32).fill(5) });
    rerender({ current: { ...config, networkIdHex: "05".repeat(32) } });
    await waitFor(() => expect(network).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(result.current.preview?.status).toBe("ready"));
  });

  it("keeps independent slot results when a second token is loaded", async () => {
    const { result, rerender } = renderHook(
      ({ b }) => ({
        a: useTokenPreview(config, hex(8), client),
        b: useTokenPreview(config, b, client),
      }),
      { initialProps: { b: "" }, wrapper: TestProviders },
    );
    await waitFor(() => expect(result.current.a.preview?.status).toBe("ready"));
    read.mockRejectedValueOnce(new Error("offline"));
    rerender({ b: hex(9) });
    await waitFor(() =>
      expect(result.current.b.preview?.status).toBe("unavailable"),
    );
    expect(result.current.a.preview?.status).toBe("ready");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
