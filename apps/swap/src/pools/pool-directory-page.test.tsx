import { toHex0x } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readPoolDirectory } from "@/pools/pool-directory";
import type { RegistryPoolPage, RegistryStatus } from "@/registry/client";
import {
  registryPoolsToEntries,
  type enrichRegistryPools,
} from "@/registry/pools";
import type { PoolSnapshot } from "@/swap/snapshot";
import { DIRECTORY_REFRESH_INTERVAL_MS, PoolDirectoryPage } from "./pool-directory-page";

vi.mock("@/pools/pool-directory", () => ({ readPoolDirectory: vi.fn() }));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const globalConfig: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  registryEnabled: false,
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
};
const poolConfig: AppConfig = {
  ...globalConfig,
  liquidityTokenAddress: address(8),
  handlerAddress: address(9),
  driverAddress: address(10),
  tokenAAddress: address(5),
  tokenBAddress: address(6),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
};
const snapshot: PoolSnapshot = {
  tokenA: {
    address: address(5),
    name: "Token A",
    symbol: "A",
    decimals: 6,
    balance: 10n,
    allowance: 0n,
  },
  tokenB: {
    address: address(6),
    name: "Token B",
    symbol: "B",
    decimals: 6,
    balance: 10n,
    allowance: 0n,
  },
  reserve0: 1_000_000n,
  reserve1: 2_000_000n,
  reserveTimestamp: 1n,
  liquidityTotalSupply: 1_000n,
  liquidityBalance: 100n,
  liquidityAllowance: 0n,
  liquidityTokenSymbol: "LP",
  liquidityTokenDecimals: 6,
  feeTo: null,
  chainHeight: 5n,
  readAt: 1,
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("PoolDirectoryPage", () => {
  it.each(["focus", "interval"] as const)("discovers a newly created pool from an empty direct directory on %s", async (trigger) => {
    vi.useFakeTimers();
    const readDirect = vi.fn().mockResolvedValueOnce({ entries: [], invalidEntryCount: 0 }).mockResolvedValue({ entries: [{ config: poolConfig, snapshot }], invalidEntryCount: 0 });
    renderPage(globalConfig, { readDirect });
    await act(async () => {});
    expect(screen.getByText("No pools yet")).toBeVisible();
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS);
    });
    expect(screen.getByText("A / B")).toBeVisible();
    expect(readDirect).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });

  it("pauses direct refreshes while hidden, avoids overlap, and retains data on background failure", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let reject!: (reason: Error) => void;
    const readDirect = vi.fn().mockResolvedValueOnce({ entries: [{ config: poolConfig, snapshot }], invalidEntryCount: 0 }).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({ entries: [], invalidEntryCount: 0 });
    renderPage(globalConfig, { readDirect });
    await act(async () => {});
    visibility.mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS * 3); });
    expect(readDirect).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS * 2); });
    expect(readDirect).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("offline")));
    expect(screen.getByText("A / B")).toBeVisible();
    expect(screen.getByText("Pool data may be stale")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS));
    expect(screen.getByText("No pools yet")).toBeVisible();
  });

  it.each(["focus", "interval"] as const)("refreshes an idle registry and discovers new pools on %s", async (trigger) => {
    vi.useFakeTimers();
    const empty = { ...page(), pools: [], total: 0 };
    const readRegistry = vi.fn().mockResolvedValue(empty);
    const readStatus = vi.fn().mockResolvedValue(status());
    renderPage({ ...globalConfig, registryEnabled: true }, { readRegistry, readStatus, requestSync: vi.fn().mockResolvedValue(status()), enrich: vi.fn(async (_config, entries) => entries) });
    await act(async () => {});
    expect(screen.getByText("No pools yet")).toBeVisible();
    const before = readRegistry.mock.calls.length;
    readRegistry.mockResolvedValue(page());
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS);
    });
    expect(readRegistry).toHaveBeenCalledTimes(before + 1);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
    expect(readRegistry.mock.calls.at(-1)?.[1]).not.toHaveProperty("asOfBlock");
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });

  it.each([
    ["focus", false],
    ["interval", false],
    ["focus", true],
    ["interval", true],
  ] as const)(
    "preserves page two and its pinned snapshot on idle %s refresh (failure=%s)",
    async (trigger, failure) => {
      vi.useFakeTimers();
      let latestBlock = "12";
      const readRegistry = vi.fn().mockImplementation(async (_config, query) => ({
        ...page(),
        offset: query.offset,
        asOfBlock: query.asOfBlock ?? latestBlock,
        total: 21,
        hasMore: query.offset === 0,
        pools: [{
          ...page().pools[0]!,
          token0Address: hex(query.offset + 5),
          token1Address: hex(query.offset + 6),
        }],
      }));
      const readStatus = vi.fn().mockResolvedValue(status());
      const requestSync = vi.fn().mockResolvedValue(status());
      const enrich = vi.fn(async (_config, entries) => entries);
      renderPage({ ...globalConfig, registryEnabled: true }, {
        readRegistry, readStatus, requestSync, enrich,
      });
      await act(async () => {});
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
      expect(screen.getByText("Showing 21-21 of 21")).toBeVisible();
      const pageTwoLink = `/pools/${hex(25)}/${hex(26)}`;
      expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", pageTwoLink);

      latestBlock = "99";
      readStatus.mockResolvedValue(status({ indexedThroughBlock: latestBlock }));
      const readsBefore = readRegistry.mock.calls.length;
      const enrichmentsBefore = enrich.mock.calls.length;
      let rejectRefresh!: (error: Error) => void;
      if (failure) {
        readRegistry.mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }));
      }
      await act(async () => {
        if (trigger === "focus") window.dispatchEvent(new Event("focus"));
        else await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS);
      });
      expect(readRegistry).toHaveBeenCalledTimes(readsBefore + 1);
      expect(readRegistry.mock.calls.at(-1)?.[1]).toMatchObject({ offset: 20, asOfBlock: "12" });
      if (failure) {
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
        await act(async () => rejectRefresh(new Error("offline")));
        expect(screen.getByText("Pool data may be stale")).toBeVisible();
        expect(enrich).toHaveBeenCalledTimes(enrichmentsBefore);
      } else {
        expect(enrich).toHaveBeenCalledTimes(enrichmentsBefore + 1);
      }
      expect(screen.getByText("Showing 21-21 of 21")).toBeVisible();
      expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", pageTwoLink);
      expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
      expect(requestSync).toHaveBeenCalledOnce();
      expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Previous" })));
      expect(readRegistry.mock.calls.at(-1)?.[1]).toMatchObject({ offset: 0, asOfBlock: "12" });
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(readRegistry.mock.calls.at(-1)?.[1]).toMatchObject({ offset: 0 });
      expect(readRegistry.mock.calls.at(-1)?.[1]).not.toHaveProperty("asOfBlock");
    },
  );

  it("pauses registry polling while hidden, prevents overlapping reads, and preserves a failed background page", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const readRegistry = vi.fn().mockResolvedValue(page());
    const readStatus = vi.fn().mockResolvedValue(status());
    renderPage({ ...globalConfig, registryEnabled: true }, { readRegistry, readStatus, requestSync: vi.fn().mockResolvedValue(status()), enrich: vi.fn(async (_config, entries) => entries) });
    await act(async () => {});
    const before = readRegistry.mock.calls.length;
    visibility.mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS * 3); });
    expect(readRegistry).toHaveBeenCalledTimes(before);
    expect(readStatus).not.toHaveBeenCalled();
    let reject!: (reason: Error) => void;
    readRegistry.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS * 2); });
    expect(readRegistry).toHaveBeenCalledTimes(before + 1);
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
    expect(screen.getByText("Pool data may be stale")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(DIRECTORY_REFRESH_INTERVAL_MS));
    expect(readRegistry).toHaveBeenCalledTimes(before + 2);
    expect(screen.queryByText("Pool data may be stale")).toBeNull();
  });

  it("keeps the displayed page-one snapshot pinned after a background replacement fails", async () => {
    const user = userEvent.setup();
    const readRegistry = vi.fn().mockImplementation(async (_config, query) => ({
      ...page(),
      offset: query.offset,
      asOfBlock: query.asOfBlock ?? "12",
      total: 21,
      hasMore: query.offset === 0,
    }));
    renderPage({ ...globalConfig, registryEnabled: true }, {
      readRegistry,
      readStatus: vi.fn().mockResolvedValue(status({ indexedThroughBlock: "99" })),
      requestSync: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await act(async () => {});
    readRegistry.mockRejectedValueOnce(new Error("offline"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(readRegistry.mock.calls.at(-1)?.[1]).not.toHaveProperty("asOfBlock");
    expect(screen.getByText("Pool data may be stale")).toBeVisible();
    expect(screen.getByText("Showing 1-1 of 21")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(readRegistry.mock.calls.at(-1)?.[1]).toMatchObject({ offset: 20, asOfBlock: "12" });
    expect(screen.getByText("Showing 21-21 of 21")).toBeVisible();
  });

  it.each([false, true])("retains previous live reserves when a background pool read fails (registry=%s)", async (registryEnabled) => {
    const live = { config: poolConfig, snapshot };
    const readDirect = vi.fn()
      .mockResolvedValueOnce({ entries: [live], invalidEntryCount: 0 })
      .mockResolvedValue({ entries: [], invalidEntryCount: 1 });
    const enrich = vi.fn<typeof enrichRegistryPools>()
      .mockImplementationOnce(async (_config, entries) => entries.map((entry) => ({ ...entry, live, loading: false })))
      .mockImplementation(async (_config, entries) => entries.map((entry) => ({ ...entry, loading: false, readError: true })));
    renderPage({ ...globalConfig, registryEnabled }, {
      readDirect, enrich,
      readRegistry: vi.fn().mockResolvedValue(page()),
      readStatus: vi.fn().mockResolvedValue(status()),
      requestSync: vi.fn().mockResolvedValue(status()),
    });
    await act(async () => {});
    expect(screen.getByText("A / B")).toBeVisible();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.getByText("A / B")).toBeVisible();
    expect(screen.getByText("Some pools could not be loaded")).toBeVisible();
  });

  it("ignores a late background registry page after the user changes the query", async () => {
    const user = userEvent.setup();
    let resolveBackground!: (value: RegistryPoolPage) => void;
    const replacement = page();
    replacement.pools[0] = { ...replacement.pools[0]!, token0Address: hex(20), token1Address: hex(21) };
    const readRegistry = vi.fn().mockResolvedValue(page());
    renderPage({ ...globalConfig, registryEnabled: true }, {
      readRegistry,
      readStatus: vi.fn().mockResolvedValue(status()),
      requestSync: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await act(async () => {});
    readRegistry.mockImplementationOnce(() => new Promise((resolve) => { resolveBackground = resolve; })).mockResolvedValue(replacement);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await user.type(screen.getByLabelText("Search addresses"), "20");
    const link = `/pools/${hex(20)}/${hex(21)}`;
    await waitFor(() => expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", link));
    await act(async () => resolveBackground(page()));
    expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", link);
  });
  it("shows an empty factory action", async () => {
    vi.mocked(readPoolDirectory).mockResolvedValue({
      entries: [],
      invalidEntryCount: 0,
    });
    renderPage();

    expect(await screen.findByText("No pools yet")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: "Create pool" }).length,
    ).toBeGreaterThan(0);
  });

  it("shows discovered reserves and pool actions", async () => {
    vi.mocked(readPoolDirectory).mockResolvedValue({
      entries: [{ config: poolConfig, snapshot }],
      invalidEntryCount: 0,
    });
    renderPage();

    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Handler address: ${toHex0x(poolConfig.handlerAddress)}`,
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
  });

  it("hides directory write actions when read-only", async () => {
    vi.mocked(readPoolDirectory).mockResolvedValue({
      entries: [{ config: poolConfig, snapshot }],
      invalidEntryCount: 0,
    });
    renderPage(globalConfig, {}, true);

    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Swap" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Liquidity" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Create pool/i })).toBeNull();
  });

  it("recovers from repeated direct directory failures with Try again", async () => {
    const user = userEvent.setup();
    vi.mocked(readPoolDirectory)
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("gateway disconnected"))
      .mockResolvedValueOnce({
        entries: [{ config: poolConfig, snapshot }],
        invalidEntryCount: 0,
      });
    renderPage();

    expect(await screen.findByText("RPC unavailable")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("gateway disconnected")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.queryByText("Pool registry unavailable")).toBeNull();
    expect(readPoolDirectory).toHaveBeenCalledTimes(3);
  });

  it("uses registry discovery, renders immutable identities, and reports partial live failures", async () => {
    const registryPage = page();
    const readRegistry = vi.fn().mockResolvedValue(registryPage);
    const requestSync = vi.fn(() => new Promise<RegistryStatus>(() => {}));
    const enrich = vi.fn().mockResolvedValue([
      {
        ...registryPoolsToEntries(registryPage.pools)[0]!,
        loading: false,
        readError: true,
      },
    ]);
    renderPage(
      { ...globalConfig, registryEnabled: true },
      { readRegistry, requestSync, enrich },
    );

    expect(
      await screen.findByRole("heading", { name: "0x050505…0505 / 0x060606…0606" }),
    ).toBeVisible();
    expect(
      await screen.findByText("Some pools could not be loaded"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute(
      "href",
      `/pools/${hex(5)}/${hex(6)}`,
    );
    expect(readPoolDirectory).not.toHaveBeenCalled();
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("debounces search, resets filters and sorting, and retains the first snapshot while paging", async () => {
    const user = userEvent.setup();
    const requestSync = vi.fn().mockResolvedValue(status());
    const readRegistry = vi.fn().mockImplementation(async (_config, query) => ({
      ...page(),
      offset: query.offset,
      asOfBlock: query.asOfBlock ?? "12",
      hasMore: query.offset === 0,
      total: 21,
    }));
    renderPage(
      { ...globalConfig, registryEnabled: true },
      {
        readRegistry,
        requestSync,
        readStatus: vi.fn().mockResolvedValue(status()),
        enrich: vi.fn(async (_config, entries) => entries),
      },
    );
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Search addresses"), "05");
    expect(readRegistry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(readRegistry.mock.calls[1]?.[1]).toMatchObject({
      q: "05",
      offset: 0,
    });

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(3));
    expect(readRegistry.mock.calls[2]?.[1]).toMatchObject({
      offset: 20,
      asOfBlock: "12",
    });

    await user.selectOptions(screen.getByLabelText("Sort by"), "oldest");
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(4));
    expect(readRegistry.mock.calls[3]?.[1]).toMatchObject({
      sort: "oldest",
      offset: 0,
    });
    expect(readRegistry.mock.calls[3]?.[1]).not.toHaveProperty("asOfBlock");

    await user.type(screen.getByLabelText("Contains token"), hex(5));
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(5));
    expect(readRegistry.mock.calls[4]?.[1]).toMatchObject({ token: hex(5) });
    expect(readRegistry.mock.calls[4]?.[1]).not.toHaveProperty("asOfBlock");
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it.each(["search", "token", "sort", "page"])(
    "clears displayed results while a replacement %s request is pending",
    async (change) => {
      const user = userEvent.setup();
      let resolveReplacement!: (value: RegistryPoolPage) => void;
      const readRegistry = vi
        .fn()
        .mockResolvedValueOnce({ ...page(), total: 21, hasMore: true })
        .mockImplementationOnce(
          () =>
            new Promise<RegistryPoolPage>((resolve) => {
              resolveReplacement = resolve;
            }),
        );
      renderPage(
        { ...globalConfig, registryEnabled: true },
        {
          readRegistry,
          requestSync: vi.fn(() => new Promise<RegistryStatus>(() => {})),
          enrich: vi.fn<typeof enrichRegistryPools>(async (_config, entries) =>
            entries.map((entry) => ({
              ...entry,
              loading: false,
              readError: true,
            })),
          ),
        },
      );
      expect(
        await screen.findByRole("link", { name: "View pool" }),
      ).toBeVisible();
      expect(
        await screen.findByText("Some pools could not be loaded"),
      ).toBeVisible();

      if (change === "search") {
        await user.type(screen.getByLabelText("Search addresses"), "20");
      } else if (change === "token") {
        await user.type(screen.getByLabelText("Contains token"), hex(20));
      } else if (change === "sort") {
        await user.selectOptions(screen.getByLabelText("Sort by"), "oldest");
      } else if (change === "page") {
        await user.click(screen.getByRole("button", { name: "Next" }));
      }
      await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("link", { name: "View pool" })).toBeNull();
      expect(screen.queryByText(/Showing /)).toBeNull();
      expect(screen.queryByText("Some pools could not be loaded")).toBeNull();
      expect(screen.queryByText("No pools yet")).toBeNull();
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

      const replacement = page();
      replacement.pools[0] = {
        ...replacement.pools[0]!,
        token0Address: hex(20),
        token1Address: hex(21),
      };
      await act(async () => resolveReplacement(replacement));
      expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute(
        "href",
        `/pools/${hex(20)}/${hex(21)}`,
      );
    },
  );

  it("retries a transient status poll failure and refreshes from page one on completion", async () => {
    vi.useFakeTimers();
    const readRegistry = vi.fn().mockResolvedValue(page());
    const readStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce(status({ syncState: "idle", syncing: false }));
    renderPage(
      { ...globalConfig, registryEnabled: true },
      {
        readRegistry,
        readStatus,
        requestSync: vi
          .fn()
          .mockResolvedValue(status({ syncState: "syncing", syncing: true })),
        enrich: vi.fn(async (_config, entries) => entries),
      },
    );
    await act(async () => {});
    expect(readRegistry).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Registry sync delayed")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(readRegistry).toHaveBeenCalledTimes(2);
    expect(readRegistry.mock.calls[1]?.[1]).not.toHaveProperty("asOfBlock");
  });

  it("polls after the sync hint and immediate status fallback both fail", async () => {
    vi.useFakeTimers();
    const readRegistry = vi.fn().mockResolvedValue(page());
    const readStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(status({ syncState: "syncing", syncing: true }))
      .mockResolvedValueOnce(status());
    renderPage(
      { ...globalConfig, registryEnabled: true },
      {
        readRegistry,
        readStatus,
        requestSync: vi.fn().mockRejectedValue(new Error("offline")),
        enrich: vi.fn(async (_config, entries) => entries),
      },
    );
    await act(async () => {});
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Registry sync delayed")).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Registry is syncing")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(readRegistry).toHaveBeenCalledTimes(2);
  });

  it("suppresses superseded registry completions", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: RegistryPoolPage) => void) | undefined;
    const firstPage = page();
    const secondPage = page();
    secondPage.pools[0] = {
      ...secondPage.pools[0]!,
      token0Address: hex(20),
      token1Address: hex(21),
    };
    const readRegistry = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<RegistryPoolPage>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(secondPage);
    const enrich = vi.fn(async (_config, entries) => entries);
    renderPage(
      { ...globalConfig, registryEnabled: true },
      {
        readRegistry,
        requestSync: vi.fn(() => new Promise<RegistryStatus>(() => {})),
        enrich,
      },
    );

    await user.type(screen.getByLabelText("Search addresses"), "20");
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", { name: "0x141414…1414 / 0x151515…1515" }),
    ).toBeVisible();
    resolveFirst?.(firstPage);
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: "0x141414…1414 / 0x151515…1515" }),
    ).toBeVisible();
  });

  it("suppresses superseded enrichment completions", async () => {
    const user = userEvent.setup();
    let resolveFirst:
      ((value: ReturnType<typeof registryPoolsToEntries>) => void) | undefined;
    const firstPage = page();
    const secondPage = page();
    secondPage.pools[0] = {
      ...secondPage.pools[0]!,
      token0Address: hex(20),
      token1Address: hex(21),
    };
    const enrich = vi
      .fn()
      .mockImplementationOnce(
        (_config, entries) =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async (_config, entries) => entries);
    renderPage(
      { ...globalConfig, registryEnabled: true },
      {
        readRegistry: vi
          .fn()
          .mockResolvedValueOnce(firstPage)
          .mockResolvedValueOnce(secondPage),
        requestSync: vi.fn(() => new Promise<RegistryStatus>(() => {})),
        enrich,
      },
    );
    expect(
      await screen.findByRole("heading", { name: "0x050505…0505 / 0x060606…0606" }),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Search addresses"), "20");
    expect(
      await screen.findByRole("heading", { name: "0x141414…1414 / 0x151515…1515" }),
    ).toBeVisible();
    resolveFirst?.(registryPoolsToEntries(firstPage.pools));
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: "0x141414…1414 / 0x151515…1515" }),
    ).toBeVisible();
  });
});

function renderPage(
  config: GlobalConfig = globalConfig,
  dependencies: React.ComponentProps<
    typeof PoolDirectoryPage
  >["dependencies"] = {},
  readOnly = false,
) {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <PoolDirectoryPage
          config={config}
          dependencies={dependencies}
          readOnly={readOnly}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const hex = (byte: number) =>
  `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

function page(): RegistryPoolPage {
  return {
    networkId: globalConfig.networkIdHex,
    factoryAddress: hex(3),
    pools: [
      {
        networkId: globalConfig.networkIdHex,
        factoryAddress: hex(3),
        token0Address: hex(5),
        token1Address: hex(6),
        liquidityTokenAddress: hex(8),
        handlerAddress: hex(9),
        driverAddress: hex(10),
        pairCount: "1",
        transactionHash: hex(11),
        eventSequence: "0",
        createdBlock: "12",
        indexedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    total: 1,
    limit: 20,
    offset: 0,
    asOfBlock: "12",
    hasMore: false,
    historyLimited: false,
  };
}

function status(overrides: Partial<RegistryStatus> = {}): RegistryStatus {
  return {
    networkId: globalConfig.networkIdHex,
    factoryAddress: hex(3),
    indexedThroughBlock: "12",
    poolCount: 1,
    historyLimited: false,
    syncState: "idle",
    syncing: false,
    lastSuccessfulSyncAt: "2026-09-05T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}
