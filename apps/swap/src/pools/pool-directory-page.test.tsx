import { toHex0x } from "@groundhogchain/client";
import { contractAddress } from "@groundhogchain/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readPoolDirectory } from "@/pools/pool-directory";
import type { PoolSnapshot } from "@/swap/snapshot";
import { PoolDirectoryPage } from "./pool-directory-page";

vi.mock("@/pools/pool-directory", () => ({ readPoolDirectory: vi.fn() }));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const globalConfig: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
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
  tokenA: { address: address(5), name: "Token A", symbol: "A", decimals: 6, balance: 10n, allowance: 0n },
  tokenB: { address: address(6), name: "Token B", symbol: "B", decimals: 6, balance: 10n, allowance: 0n },
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

describe("PoolDirectoryPage", () => {
  it("shows an empty factory action", async () => {
    vi.mocked(readPoolDirectory).mockResolvedValue({
      entries: [],
      invalidEntryCount: 0,
    });
    renderPage();

    expect(await screen.findByText("No pools yet")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Create pool" }).length)
      .toBeGreaterThan(0);
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
    expect(screen.getByRole("button", {
      name: `Handler address: ${toHex0x(poolConfig.handlerAddress)}`,
    })).toBeVisible();
    expect(screen.getByRole("link", { name: "View pool" })).toBeVisible();
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
      expect(screen.queryByText("Pool data may be stale")).not.toBeInTheDocument();
    });
  });
});

function renderPage(config: GlobalConfig = globalConfig) {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <PoolDirectoryPage config={config} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}
