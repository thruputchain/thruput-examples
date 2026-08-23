import { contractAddress } from "@groundhogchain/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppConfig } from "@/config";
import type { PoolSnapshot } from "@/swap/snapshot";
import { runLiquidityOperation } from "@/transactions/liquidity-executor";
import { loadLiquidityOperations, type LiquidityOperation } from "@/transactions/liquidity-operation";
import { unavailableWriteBoundary } from "@/transactions/write-boundary";
import { LiquidityPage } from "./liquidity-page";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
  pairAddress: address(5),
  liquidityTokenAddress: address(4),
  handlerAddress: address(3),
  driverAddress: address(2),
  tokenAAddress: address(1),
  tokenBAddress: address(10),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("LiquidityPage", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists a canonical add intent before running it", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (_config: AppConfig, operation: LiquidityOperation) => ({
      ...operation,
      status: "queued" as const,
    }));
    renderPage(run);

    await user.type(await screen.findByLabelText("A amount"), "10");
    expect(screen.getByLabelText("B amount")).toHaveValue("20");
    await user.click(screen.getByRole("button", { name: "Add liquidity" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(loadLiquidityOperations(config)[0]).toMatchObject({
      kind: "add",
      intent: {
        amountsDesired: ["10000000", "20000000"],
        amountsMin: ["9900000", "19800000"],
      },
    });
  });

  it("lets either token amount drive the proportional deposit", async () => {
    const user = userEvent.setup();
    renderPage(vi.fn());

    await user.type(await screen.findByLabelText("A amount"), "10");
    const tokenB = screen.getByLabelText("B amount");
    expect(tokenB).toHaveValue("20");

    await user.clear(tokenB);
    await user.type(tokenB, "30");
    expect(screen.getByLabelText("A amount")).toHaveValue("15");
  });

  it("blocks deposits when either token balance is insufficient", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const lowBalance = snapshot();
    renderPage(run, {
      ...lowBalance,
      tokenB: { ...lowBalance.tokenB, balance: 10_000_000n },
    });

    await user.type(await screen.findByLabelText("A amount"), "10");

    expect(screen.getByText("Both tokens are required")).toBeVisible();
    expect(screen.getByText(/available B balance is insufficient/)).toBeVisible();
    expect(screen.getByLabelText("B amount")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Add liquidity" })).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
  });

  it("warns immediately when the wallet does not hold both tokens", async () => {
    const emptyBalance = snapshot();
    renderPage(vi.fn(), {
      ...emptyBalance,
      tokenB: { ...emptyBalance.tokenB, balance: 0n },
    });

    expect(await screen.findByText("Both tokens are required")).toBeVisible();
    expect(screen.getByText(/available B balance is insufficient/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add liquidity" })).toBeDisabled();
  });

  it("quotes and persists removal using unreserved LP", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (_config: AppConfig, operation: LiquidityOperation) => ({
      ...operation,
      status: "queued" as const,
    }));
    renderPage(run);

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(screen.getByText("100 A")).toBeVisible();
    expect(screen.getByText("200 B")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "1%" }));
    const slippage = screen.getByLabelText("Custom percentage");
    await user.clear(slippage);
    await user.type(slippage, "2");
    await user.click(screen.getByRole("button", { name: "Remove liquidity" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(loadLiquidityOperations(config)[0]).toMatchObject({
      kind: "remove",
      intent: {
        liquidity: "100000000",
        amountsMin: ["98000000", "196000000"],
      },
    });
  });
});

function renderPage(
  run: typeof runLiquidityOperation,
  poolSnapshot = snapshot(),
) {
  return render(
    <MemoryRouter initialEntries={["/pools/current/liquidity"]}>
      <TooltipProvider>
        <LiquidityPage
          config={config}
          dependencies={{
            readSnapshot: vi.fn().mockResolvedValue(poolSnapshot),
            writer: unavailableWriteBoundary,
            run,
          }}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function snapshot(): PoolSnapshot {
  return {
    tokenA: {
      address: config.tokenAAddress,
      name: "Token A",
      symbol: "A",
      decimals: 6,
      balance: 100_000_000n,
      allowance: 0n,
    },
    tokenB: {
      address: config.tokenBAddress,
      name: "Token B",
      symbol: "B",
      decimals: 6,
      balance: 200_000_000n,
      allowance: 0n,
    },
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    reserveTimestamp: 1n,
    liquidityTotalSupply: 1_000_000_000n,
    liquidityBalance: 100_000_000n,
    liquidityAllowance: 0n,
    feeTo: null,
    chainHeight: 7n,
    readAt: 1,
  };
}
