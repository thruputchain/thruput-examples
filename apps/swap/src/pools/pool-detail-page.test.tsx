import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppConfig } from "@/config";
import { createSnapshotReader, type PoolSnapshot } from "@/swap/snapshot";
import { usePoolSnapshot } from "@/swap/use-pool-snapshot";
import { PoolDetailPage } from "./pool-detail-page";

vi.mock("@/swap/snapshot", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/swap/snapshot")>(),
  createSnapshotReader: vi.fn(),
}));
vi.mock("@/swap/use-pool-snapshot", () => ({ usePoolSnapshot: vi.fn() }));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
  poolContractFunding: 100n,
  pairAddress: address(7),
  liquidityTokenAddress: address(8),
  handlerAddress: address(9),
  driverAddress: address(10),
  tokenAAddress: address(5),
  tokenBAddress: address(6),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 3,
};
const snapshot: PoolSnapshot = {
  tokenA: {
    address: config.tokenAAddress,
    name: "Token A",
    symbol: "A",
    decimals: 6,
    balance: 12_345_678n,
    allowance: 0n,
  },
  tokenB: {
    address: config.tokenBAddress,
    name: "Token B",
    symbol: "B",
    decimals: 3,
    balance: 9_876n,
    allowance: 0n,
  },
  reserve0: 1_000_000n,
  reserve1: 2_000n,
  reserveTimestamp: 1n,
  liquidityTotalSupply: 1_000n,
  liquidityBalance: 100n,
  liquidityAllowance: 0n,
  liquidityTokenSymbol: "LP",
  liquidityTokenDecimals: 3,
  feeTo: null,
  chainHeight: 5n,
  readAt: 1,
};

beforeEach(() => {
  vi.mocked(createSnapshotReader).mockReturnValue(vi.fn());
  vi.mocked(usePoolSnapshot).mockReturnValue({
    snapshot,
    error: null,
    isLoading: false,
    isRefreshing: false,
    isUserRefreshing: false,
    refresh: vi.fn(),
  });
});

describe("PoolDetailPage", () => {
  it("shows wallet token balances", () => {
    renderPage();

    expect(screen.getByText("Your A balance")).toBeVisible();
    expect(screen.getByText("12.345678 A")).toBeVisible();
    expect(screen.getByText("Your B balance")).toBeVisible();
    expect(screen.getByText("9.876 B")).toBeVisible();
  });

  it("identifies a pool without usable liquidity", () => {
    vi.mocked(usePoolSnapshot).mockReturnValue({
      snapshot: { ...snapshot, reserve0: 0n },
      error: null,
      isLoading: false,
      isRefreshing: false,
      isUserRefreshing: false,
      refresh: vi.fn(),
    });

    renderPage();

    expect(screen.getByText("Empty pool")).toBeVisible();
    expect(screen.getByText(/no usable liquidity/)).toBeVisible();
  });
});

function renderPage() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <PoolDetailPage config={config} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}
