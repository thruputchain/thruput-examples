import { toHex0x } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { PoolDirectoryPage } from "./pool-directory-page";

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
afterEach(() => vi.useRealTimers());

describe("PoolDirectoryPage", () => {
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

  it("keeps the previous directory visible when refresh fails", async () => {
    const user = userEvent.setup();
    vi.mocked(readPoolDirectory)
      .mockResolvedValueOnce({
        entries: [{ config: poolConfig, snapshot }],
        invalidEntryCount: 0,
      })
      .mockRejectedValueOnce(new Error("gateway disconnected"))
      .mockResolvedValueOnce({
        entries: [{ config: poolConfig, snapshot }],
        invalidEntryCount: 0,
      });
    renderPage();

    expect(await screen.findByText("A / B")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Pool data may be stale")).toBeVisible();
    expect(screen.getByText(/gateway disconnected/)).toBeVisible();
    expect(screen.getByText("A / B")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(
        screen.queryByText("Pool data may be stale"),
      ).not.toBeInTheDocument();
    });
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
    const requestSync = vi.fn(() => new Promise<RegistryStatus>(() => {}));
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

  it.each(["search", "token", "sort", "page", "refresh"])(
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
      } else {
        await user.click(
          screen.getByRole("button", {
            name: change === "page" ? "Next" : "Refresh",
          }),
        );
      }
      await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("link", { name: "View pool" })).toBeNull();
      expect(screen.queryByText(/Showing /)).toBeNull();
      expect(screen.queryByText("Some pools could not be loaded")).toBeNull();
      expect(screen.queryByText("No pools yet")).toBeNull();
      expect(screen.getByRole("button", { name: "Refreshing" })).toBeDisabled();

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
