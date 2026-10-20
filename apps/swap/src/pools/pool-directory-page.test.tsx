import {
  addressFromBase58,
  addressToStrkey,
  toBase58,
} from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RegistryPoolPage, RegistryStatus } from "@/registry/client";
import {
  registryPoolsToEntries,
  type enrichRegistryPools,
} from "@/registry/pools";
import type { PoolSnapshot } from "@/swap/snapshot";
import { DIRECTORY_REFRESH_INTERVAL_MS, PoolDirectoryPage } from "./pool-directory-page";

const defaultRead = vi.fn();

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const globalConfig: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
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
  it.each(["focus", "interval"] as const)("refreshes an idle registry and discovers new pools on %s", async (trigger) => {
    vi.useFakeTimers();
    const empty = { ...page(), pools: [], total: 0 };
    const readRegistry = vi.fn().mockResolvedValue(empty);
    const readStatus = vi.fn().mockResolvedValue(status());
    renderPage(globalConfig, { readRegistry, readStatus, requestSync: vi.fn().mockResolvedValue(status()), enrich: vi.fn(async (_config, entries) => entries) });
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
          token0Address: id(query.offset + 5),
          token1Address: id(query.offset + 6),
        }],
      }));
      const readStatus = vi.fn().mockResolvedValue(status());
      const requestSync = vi.fn().mockResolvedValue(status());
      const enrich = vi.fn(async (_config, entries) => entries);
      renderPage(globalConfig, {
        readRegistry, readStatus, requestSync, enrich,
      });
      await act(async () => {});
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
      expect(screen.getByText("Showing 21-21 of 21")).toBeVisible();
      const pageTwoLink = `/pools/${id(25)}/${id(26)}`;
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
    renderPage(globalConfig, { readRegistry, readStatus, requestSync: vi.fn().mockResolvedValue(status()), enrich: vi.fn(async (_config, entries) => entries) });
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
    renderPage(globalConfig, {
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

  it("retains previous live reserves when a background pool read fails", async () => {
    const live = { config: poolConfig, snapshot };
    const enrich = vi.fn<typeof enrichRegistryPools>()
      .mockImplementationOnce(async (_config, entries) => entries.map((entry) => ({ ...entry, live, loading: false })))
      .mockImplementation(async (_config, entries) => entries.map((entry) => ({ ...entry, loading: false, readError: true })));
    renderPage(globalConfig, {
      enrich,
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
    replacement.pools[0] = { ...replacement.pools[0]!, token0Address: id(20), token1Address: id(21) };
    const readRegistry = vi.fn().mockResolvedValue(page());
    renderPage(globalConfig, {
      readRegistry,
      readStatus: vi.fn().mockResolvedValue(status()),
      requestSync: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await act(async () => {});
    readRegistry.mockImplementationOnce(() => new Promise((resolve) => { resolveBackground = resolve; })).mockResolvedValue(replacement);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await user.type(screen.getByLabelText("Search addresses"), "20");
    const link = `/pools/${id(20)}/${id(21)}`;
    await waitFor(() => expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", link));
    await act(async () => resolveBackground(page()));
    expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute("href", link);
  });
  it("shows an empty factory action", async () => {
    defaultRead.mockResolvedValue({ ...page(), pools: [], total: 0 });
    renderPage();

    expect(await screen.findByText("No pools yet")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: "Create pool" }).length,
    ).toBeGreaterThan(0);
  });

  it("shows discovered reserves and pool actions", async () => {
    defaultRead.mockResolvedValue(page());
    renderPage();

    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Handler address: ${toBase58(poolConfig.handlerAddress)}`,
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
  });

  it("hides directory write actions when read-only", async () => {
    defaultRead.mockResolvedValue(page());
    renderPage(globalConfig, {}, true);

    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Swap" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Liquidity" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Create pool/i })).toBeNull();
  });

  it("recovers from repeated registry failures with Try again", async () => {
    const user = userEvent.setup();
    defaultRead
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("gateway disconnected"))
      .mockResolvedValueOnce(page());
    renderPage();

    expect(await screen.findByText("RPC unavailable")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("gateway disconnected")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("A / B")).toBeVisible();
    expect(screen.queryByText("Pool registry unavailable")).toBeNull();
    expect(defaultRead).toHaveBeenCalledTimes(3);
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
      globalConfig,
      { readRegistry, requestSync, enrich },
    );

    expect(
      await screen.findByRole("heading", { name: poolHeading(5, 6) }),
    ).toBeVisible();
    expect(
      await screen.findByText("Some pools could not be loaded"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute(
      "href",
      `/pools/${id(5)}/${id(6)}`,
    );
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
      globalConfig,
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

    await user.type(screen.getByLabelText("Contains token"), id(5));
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(5));
    expect(readRegistry.mock.calls[4]?.[1]).toMatchObject({ token: id(5) });
    expect(readRegistry.mock.calls[4]?.[1]).not.toHaveProperty("asOfBlock");
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("filters by a pasted base58 or StrKey token and rejects hex", async () => {
    const user = userEvent.setup();
    const readRegistry = vi.fn().mockResolvedValue(page());
    renderPage(globalConfig, {
      readRegistry,
      requestSync: vi.fn().mockResolvedValue(status()),
      readStatus: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(1));
    const token = screen.getByLabelText("Contains token");

    // The base58 address the page displays is what people paste back.
    await user.click(token);
    await user.paste(id(5));
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(readRegistry.mock.calls[1]?.[1]).toMatchObject({ token: id(5) });
    expect(token).not.toHaveAttribute("aria-invalid", "true");

    await user.clear(token);
    await user.paste(addressToStrkey(addressFromBase58(id(6))));
    await waitFor(() =>
      expect(readRegistry.mock.calls.at(-1)?.[1]).toMatchObject({
        token: id(6),
      }),
    );

    const calls = readRegistry.mock.calls.length;
    await user.clear(token);
    await user.paste(`0x${"05".repeat(32)}`);
    expect(
      await screen.findByText(
        "Enter the base58 token address. 0x hex addresses are not accepted.",
      ),
    ).toBeInTheDocument();
    expect(token).toHaveAttribute("aria-invalid", "true");
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(
      readRegistry.mock.calls
        .slice(calls)
        .some(([, query]) => String(query.token).startsWith("0x")),
    ).toBe(false);
  });

  it("sends a pasted base58 address fragment as a case-sensitive search", async () => {
    const user = userEvent.setup();
    const readRegistry = vi.fn().mockResolvedValue(page());
    renderPage(globalConfig, {
      readRegistry,
      requestSync: vi.fn().mockResolvedValue(status()),
      readStatus: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(1));
    const fragment = id(5).slice(4, 14);
    await user.click(screen.getByLabelText("Search addresses"));
    await user.paste(fragment);
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(readRegistry.mock.calls[1]?.[1]).toMatchObject({ q: fragment });
  });

  it("searches a pasted StrKey address as base58 and rejects hex", async () => {
    const user = userEvent.setup();
    const readRegistry = vi.fn().mockResolvedValue(page());
    renderPage(globalConfig, {
      readRegistry,
      requestSync: vi.fn().mockResolvedValue(status()),
      readStatus: vi.fn().mockResolvedValue(status()),
      enrich: vi.fn(async (_config, entries) => entries),
    });
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(1));
    const search = screen.getByLabelText("Search addresses");

    await user.click(search);
    await user.paste(addressToStrkey(addressFromBase58(id(6))));
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(readRegistry.mock.calls[1]?.[1]).toMatchObject({ q: id(6) });
    expect(search).not.toHaveAttribute("aria-invalid", "true");

    const calls = readRegistry.mock.calls.length;
    await user.clear(search);
    await user.paste(`0x${"05".repeat(32)}`);
    expect(
      await screen.findByText(
        "Search with base58 address text. 0x hex addresses are not accepted.",
      ),
    ).toBeInTheDocument();
    expect(search).toHaveAttribute("aria-invalid", "true");
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(
      readRegistry.mock.calls
        .slice(calls)
        .some(([, query]) => String(query.q).startsWith("0x")),
    ).toBe(false);
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
        globalConfig,
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
        await user.type(screen.getByLabelText("Contains token"), id(20));
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
        token0Address: id(20),
        token1Address: id(21),
      };
      await act(async () => resolveReplacement(replacement));
      expect(screen.getByRole("link", { name: "View pool" })).toHaveAttribute(
        "href",
        `/pools/${id(20)}/${id(21)}`,
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
      globalConfig,
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
      globalConfig,
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
    expect(screen.getByText("Syncing tokens...")).toBeVisible();
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
      token0Address: id(20),
      token1Address: id(21),
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
      globalConfig,
      {
        readRegistry,
        requestSync: vi.fn(() => new Promise<RegistryStatus>(() => {})),
        enrich,
      },
    );

    await user.type(screen.getByLabelText("Search addresses"), "20");
    await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", { name: poolHeading(0x14, 0x15) }),
    ).toBeVisible();
    resolveFirst?.(firstPage);
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: poolHeading(0x14, 0x15) }),
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
      token0Address: id(20),
      token1Address: id(21),
    };
    const enrich = vi
      .fn()
      .mockImplementationOnce(
        (_config, _entries) =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async (_config, entries) => entries);
    renderPage(
      globalConfig,
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
      await screen.findByRole("heading", { name: poolHeading(5, 6) }),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Search addresses"), "20");
    expect(
      await screen.findByRole("heading", { name: poolHeading(0x14, 0x15) }),
    ).toBeVisible();
    resolveFirst?.(registryPoolsToEntries(firstPage.pools));
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: poolHeading(0x14, 0x15) }),
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
          dependencies={{
            readRegistry: defaultRead,
            readStatus: vi.fn().mockResolvedValue(status()),
            requestSync: () => new Promise(() => {}),
            enrich: async (_config, entries) => entries.map((entry) => ({ ...entry, live: { config: poolConfig, snapshot }, loading: false })),
            ...dependencies,
          }}
          readOnly={readOnly}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

function page(): RegistryPoolPage {
  return {
    networkId: globalConfig.networkId,
    factoryAddress: id(3),
    pools: [
      {
        networkId: globalConfig.networkId,
        factoryAddress: id(3),
        token0Address: id(5),
        token1Address: id(6),
        liquidityTokenAddress: id(8),
        handlerAddress: id(9),
        driverAddress: id(10),
        pairCount: "1",
        transactionHash: id(11),
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
    networkId: globalConfig.networkId,
    factoryAddress: id(3),
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

/** Untitled pools are named by their abbreviated base58 token addresses. */
function poolHeading(token0: number, token1: number): string {
  const short = (byte: number) => {
    const value = toBase58(new Uint8Array(32).fill(byte));
    return `${value.slice(0, 8)}…${value.slice(-4)}`;
  };
  return `${short(token0)} / ${short(token1)}`;
}
