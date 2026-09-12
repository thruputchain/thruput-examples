import { contractAddress } from "@groundhogchain/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { AppConfig } from "@/config";
import type { PoolSnapshot } from "@/swap/snapshot";
import { runLiquidityOperation } from "@/transactions/liquidity-executor";
import {
  createAddLiquidityOperation,
  loadLiquidityOperations,
  saveLiquidityOperations,
  type LiquidityOperation,
} from "@/transactions/liquidity-operation";
import { unavailableWriteBoundary } from "@/transactions/write-boundary";
import { LiquidityPage } from "./liquidity-page";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
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
    expect(screen.getByText("10 LP")).toBeVisible();
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

  it("stops after enqueue when shared manual processing is enabled", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (_config: AppConfig, operation: LiquidityOperation) => ({
      ...operation,
      status: "queued" as const,
    }));
    renderPage(run);

    await user.click(await screen.findByRole("switch", {
      name: "Manual queue processing",
    }));
    await user.type(screen.getByLabelText("A amount"), "10");
    await user.click(screen.getByRole("button", { name: "Add liquidity" }));

    await waitFor(() => expect(run).toHaveBeenCalledWith(
      config,
      expect.any(Object),
      expect.objectContaining({ automaticProcessing: false }),
    ));
  });

  it("shows persisted terminal history without blocking a new operation", async () => {
    const completed = createAddLiquidityOperation(config, {
      amountsDesired: [10_000_000n, 20_000_000n],
      amountsMin: [9_900_000n, 19_800_000n],
      estimatedLiquidity: 10_000_000n,
      liquidityBalanceBefore: 0n,
      reservesBefore: [1_000_000_000n, 2_000_000_000n],
    }, 1);
    completed.status = "executed";
    completed.requestId = hex(30);
    completed.receiptBlock = "8";
    completed.updatedAt = 2;
    completed.steps.enqueue = {
      status: "committed",
      transactionHash: hex(31),
      message: null,
      updatedAt: 2,
    };
    completed.result = {
      transactionHash: hex(32),
      blockHeight: "9",
      liquidityMinted: "10000000",
      amountsDeposited: null,
      recipientVerified: true,
    };
    saveLiquidityOperations(config, [completed]);

    renderPage(vi.fn());

    expect(await screen.findByLabelText("A amount")).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Liquidity history" })).toBeVisible();
    expect(screen.getByText(/Minted 10 LP.*verified/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Liquidity request ID/ })).toBeVisible();
  });

  it("keeps one queued operation in the existing blocking recovery flow", async () => {
    const queued = createAddLiquidityOperation(config, {
      amountsDesired: [10_000_000n, 20_000_000n],
      amountsMin: [9_900_000n, 19_800_000n],
      estimatedLiquidity: 10_000_000n,
      liquidityBalanceBefore: 0n,
      reservesBefore: [1_000_000_000n, 2_000_000_000n],
    }, 1);
    queued.status = "queued";
    queued.requestId = hex(30);
    queued.receiptBlock = "8";
    queued.steps.enqueue = {
      status: "committed",
      transactionHash: hex(31),
      message: null,
      updatedAt: 2,
    };
    saveLiquidityOperations(config, [queued]);

    renderPage(vi.fn());

    expect(await screen.findByRole("button", { name: "Crank queue" })).toBeVisible();
    expect(screen.queryByLabelText("A amount")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Liquidity history" }))
      .not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Remove liquidity" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(loadLiquidityOperations(config)[0]).toMatchObject({
      kind: "remove",
      intent: {
        liquidity: "100000000",
        amountsMin: ["99000000", "198000000"],
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
        <ProcessingModeProvider>
          <LiquidityPage
            config={config}
            dependencies={{
              readSnapshot: vi.fn().mockResolvedValue(poolSnapshot),
              writer: unavailableWriteBoundary,
              run,
            }}
          />
        </ProcessingModeProvider>
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
    liquidityTokenSymbol: "LP",
    liquidityTokenDecimals: 6,
    feeTo: null,
    chainHeight: 7n,
    readAt: 1,
  };
}
