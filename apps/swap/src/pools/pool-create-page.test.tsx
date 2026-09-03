import { contractAddress } from "@groundhogchain/protocol";
import type { TransactionReceipt } from "@groundhogchain/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { GlobalConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  createCreationWorkflow,
  loadCreationWorkflow,
  saveCreationWorkflow,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import { unavailableWriteBoundary } from "@/transactions/write-boundary";
import { PoolCreatePage } from "./pool-create-page";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
} satisfies GlobalConfig;

describe("PoolCreatePage", () => {
  beforeEach(() => window.localStorage.clear());

  it("reviews the canonical creation intent before persisting and running", async () => {
    const user = userEvent.setup();
    const prepare = vi.fn().mockResolvedValue(review());
    const run = vi.fn(async (_config: GlobalConfig, workflow: CreationWorkflow) => ({
      ...workflow,
      status: "race" as const,
    }));
    renderPage({ prepare, run });

    const addresses = screen.getAllByLabelText("Contract address");
    const amounts = screen.getAllByLabelText("Initial amount");
    await user.type(addresses[0]!, hex(2));
    await user.type(amounts[0]!, "3");
    await user.type(addresses[1]!, hex(1));
    await user.type(amounts[1]!, "2");
    await user.click(screen.getByRole("button", { name: "Review pool" }));

    expect(await screen.findByRole("heading", { name: "Creation review" })).toBeVisible();
    expect(screen.getByText(/300 HOG base units across/)).toBeVisible();
    expect(screen.getByText("50 HOG base units per contract")).toBeVisible();
    expect(screen.getByText("100 HOG base units per contract")).toBeVisible();
    expect(screen.getByText("2 T1 : 3 T2")).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "Manual queue processing" }));
    await user.click(screen.getByRole("button", { name: "Create pool" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(
      config,
      expect.any(Object),
      expect.objectContaining({ automaticProcessing: false }),
    );
    expect(loadCreationWorkflow(config, hex(1), hex(2))).not.toBeNull();
    expect(await screen.findByText("race")).toBeVisible();
  });

  it("requires explicit confirmation for a restored pre-hash signing step", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.approveFunding.status = "signing";
    saveCreationWorkflow(config, workflow);
    renderPage({});

    const confirm = await screen.findByRole("button", {
      name: "Confirm transaction was not signed",
    });
    await user.click(confirm);

    await waitFor(() => expect(
       loadCreationWorkflow(config, hex(1), hex(2))?.steps.approveFunding,
    ).toMatchObject({ status: "pending", transactionHash: null }));
    expect(screen.getByRole("button", { name: "Continue creation" })).toBeEnabled();
  });

  it("does not let stale pre-hash confirmation overwrite committed progress", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.approveFunding.status = "signing";
    saveCreationWorkflow(config, workflow);
    renderPage({});
    saveCreationWorkflow(config, {
      ...workflow,
      updatedAt: 11,
      steps: {
        ...workflow.steps,
        approveFunding: {
          status: "committed",
          transactionHash: hex(50),
          receiptBlock: "11",
          message: null,
          updatedAt: 11,
        },
        createPool: {
          status: "signing",
          transactionHash: null,
          receiptBlock: null,
          message: null,
          updatedAt: 11,
        },
      },
    });

    await user.click(await screen.findByRole("button", {
      name: "Confirm transaction was not signed",
    }));

    await waitFor(() => expect(
      loadCreationWorkflow(config, hex(1), hex(2))?.steps.approveFunding,
    ).toMatchObject({ status: "committed", transactionHash: hex(50) }));
    expect(loadCreationWorkflow(config, hex(1), hex(2))?.steps.createPool)
      .toMatchObject({ status: "signing", transactionHash: null });
  });

  it("reloads terminal progress before resetting a stale queued crank", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review(), 10);
    for (const name of Object.keys(workflow.steps) as Array<keyof typeof workflow.steps>) {
      workflow.steps[name] = {
        status: "committed",
        transactionHash: hex(50),
        receiptBlock: "11",
        message: null,
        updatedAt: 11,
      };
    }
    workflow.status = "queued";
    workflow.requestId = hex(60);
    workflow.enqueueReceiptBlock = "11";
    workflow.pool = {
      liquidityToken: hex(21),
      handler: hex(22),
      driver: hex(23),
    };
    workflow.updatedAt = 11;
    saveCreationWorkflow(config, workflow);
    const run = vi.fn(async (_config: GlobalConfig, current: CreationWorkflow) => current);
    const verifyResult = vi.fn(async () => {});
    renderPage({ run, verifyResult });
    saveCreationWorkflow(config, { ...workflow, status: "executed", updatedAt: 12 });

    await user.click(await screen.findByRole("button", {
      name: "Retry queue processing",
    }));

    await waitFor(() => expect(run).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ status: "executed" }),
      expect.objectContaining({ automaticProcessing: true }),
    ));
    expect(loadCreationWorkflow(config, hex(1), hex(2))?.status).toBe("executed");
  });

  it("removes an unused factory allowance before continuing after a race", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.status = "race";
    workflow.pool = {
      liquidityToken: hex(21),
      handler: hex(22),
      driver: hex(23),
    };
    workflow.steps.approveFunding = {
      status: "committed",
      transactionHash: hex(40),
      receiptBlock: "11",
      message: null,
      updatedAt: 11,
    };
    workflow.steps.createPool = {
      status: "failed",
      transactionHash: hex(41),
      receiptBlock: null,
      message: "Another account created this pool.",
      updatedAt: 11,
    };
    workflow.updatedAt = 11;
    saveCreationWorkflow(config, workflow);
    const execute = vi.fn(async (_target, observer) => {
      observer?.onSigned(hex(42));
      return {
        kind: "committedSuccess" as const,
        hash: hex(42),
        receipt: {} as TransactionReceipt,
      };
    });
    const run = vi.fn(async (_config: GlobalConfig, current: CreationWorkflow) => current);
    renderPage({
      writer: { execute },
      readFactoryAllowance: async () => ({ value: 300n, height: 11n }),
      run,
    });

    await user.click(await screen.findByRole("button", {
      name: "Remove funding allowance and continue",
    }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        status: "active",
        steps: expect.objectContaining({
          createPool: expect.objectContaining({ status: "skipped" }),
        }),
      }),
      expect.any(Object),
    );
  });
});

function renderPage(
  dependencies: React.ComponentProps<typeof PoolCreatePage>["dependencies"],
) {
  return render(
    <MemoryRouter initialEntries={["/pools/new"]}>
      <TooltipProvider>
        <ProcessingModeProvider>
          <PoolCreatePage config={config} dependencies={{
            writer: unavailableWriteBoundary,
            ...dependencies,
          }} />
        </ProcessingModeProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function review(): PoolCreationReview {
  return {
    token0: {
      address: address(1),
      addressHex: hex(1),
      name: "Token 1",
      symbol: "T1",
      decimals: 3,
      balance: 20_000n,
      allowance: 0n,
      amount: 2_000n,
      approvalDifference: 2_000n,
    },
    token1: {
      address: address(2),
      addressHex: hex(2),
      name: "Token 2",
      symbol: "T2",
      decimals: 3,
      balance: 20_000n,
      allowance: 3_000n,
      amount: 3_000n,
      approvalDifference: 0n,
    },
    pool: null,
    nativeHogBalance: 10_000n,
    nativeHogAllowance: 0n,
    fundingMinimum: 50n,
    fundingPerContract: 100n,
    totalFunding: 300n,
    fundingApprovalDifference: 300n,
    initialLiquidity: 2_449n,
    readHeight: 7n,
  };
}
