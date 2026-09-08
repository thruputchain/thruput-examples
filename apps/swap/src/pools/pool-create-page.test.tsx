import { contractAddress } from "@groundhogchain/protocol";
import type { TransactionReceipt } from "@groundhogchain/client";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ExplorerProvider } from "@/components/explorer-context";
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
import { allowanceCleanupKey, loadAllowanceCleanup } from "@/transactions/allowance-cleanup";
import { PoolCreatePage } from "./pool-create-page";
import { createNetworkReadClient, NetworkMismatchError } from "@/groundhog/client";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";

vi.mock("@/groundhog/client", async (original) => ({ ...await original<object>(), createNetworkReadClient: vi.fn() }));
vi.mock("@/contracts/erc20-adapter", () => ({ createErc20ReadAdapter: vi.fn() }));

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
};

describe("PoolCreatePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    config.registryEnabled = false;
    vi.mocked(createNetworkReadClient).mockReset().mockResolvedValue({ getNetworkInfo: vi.fn().mockResolvedValue({ networkHash: new Uint8Array(32) }) } as never);
    vi.mocked(createErc20ReadAdapter).mockReset().mockReturnValue({ metadata: vi.fn().mockResolvedValue({ name: { value: "Live token" }, symbol: { value: "LIVE" }, decimals: { value: 6 } }) } as never);
  });

  it.each(["amount", "funding"])("loads a concurrent %s intent without executing it", async (intent) => {
    const user = userEvent.setup();
    const run = vi.fn();
    renderPage({ prepare: vi.fn().mockResolvedValue(review()), run }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await screen.findByRole("button", { name: "Create pool" });
    const saved = createCreationWorkflow(config, review());
    if (intent === "amount") saved.token0.amount = "9000";
    else {
      saved.fundingPerContract = "200";
      saved.totalFunding = "600";
    }
    saveCreationWorkflow(config, saved);
    await user.click(screen.getByRole("button", { name: "Create pool" }));
    expect(await screen.findByText(/saved creation appeared in another tab/)).toBeVisible();
    expect(run).not.toHaveBeenCalled();
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(saved);
    expect(screen.getByRole("button", { name: "Continue creation" })).toBeEnabled();
  });

  it("renders review and persisted progress fallback symbols with full explorer identity", async () => {
    const user = userEvent.setup();
    const missing = review();
    missing.token0.symbol = `${hex(1).slice(0, 8)}...`;
    missing.token1.symbol = hex(2);
    const page = renderPage({ prepare: vi.fn().mockResolvedValue(missing) }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`, "https://explorer.test");
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await screen.findByRole("button", { name: "Create pool" });
    expect(screen.getAllByRole("link", { name: `Token address: ${hex(1)} (opens explorer in a new tab)` })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: `Token address: ${hex(2)} (opens explorer in a new tab)` })).toHaveLength(2);
    page.unmount();
    const workflow = createCreationWorkflow(config, missing);
    workflow.steps.approveFunding.transactionHash = hex(42);
    workflow.steps.approveFunding.status = "indeterminate";
    saveCreationWorkflow(config, workflow);
    renderPage({}, "", "https://explorer.test");
    expect(screen.getByRole("link", { name: `Token address: ${hex(1)} (opens explorer in a new tab)` })).toHaveAttribute("href", `https://explorer.test/address/${hex(1)}`);
    expect(screen.getByRole("link", { name: /transaction hash:/ })).toHaveAttribute("href", `https://explorer.test/tx/${hex(42)}`);
  });

  it.each([false, true])("freezes queued execution and cancels on unmount: %s", async (unmount) => {
    const user = userEvent.setup();
    const run = vi.fn(async (_config, current) => current);
    const page = renderPage({ prepare: vi.fn().mockResolvedValue(review()), run }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await screen.findByRole("button", { name: "Create pool" });
    let release!: () => void;
    const lock = vi.spyOn(navigator.locks, "request").mockImplementationOnce((_name, _options, action) =>
      new Promise((resolve, reject) => {
        release = () => Promise.resolve(action!({} as Lock)).then(resolve, reject);
      }) as never,
    );
    await user.click(screen.getByRole("button", { name: "Create pool" }));
    for (const input of [...screen.getAllByLabelText("Contract address"), ...screen.getAllByLabelText("Initial amount")]) {
      expect(input).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Search tokens for Token A" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Manual queue processing" })).toBeDisabled();
    if (unmount) page.unmount();
    await act(async () => release());
    expect(run).toHaveBeenCalledTimes(unmount ? 0 : 1);
    expect(loadCreationWorkflow(config, hex(1), hex(2)) === null).toBe(unmount);
    lock.mockRestore();
  });

  it.each([null, hex(42)])("recovers account cleanup without clearing hash evidence: %s", async (transactionHash) => {
    const user = userEvent.setup();
    const record = {
      version: 2, networkIdHex: config.networkIdHex, accountAddress: hex(9),
      tokenAddress: hex(6), spenderAddress: hex(7), status: "signing",
      transactionHash, difference: "-300", updatedAt: 10,
    };
    window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify(record));
    renderPage({});
    const confirm = screen.queryByRole("button", { name: "Confirm allowance cleanup was not signed" });
    if (transactionHash === null) {
      expect(confirm).toBeVisible();
      await user.click(confirm!);
      await waitFor(() => expect(loadAllowanceCleanup(config)).toBeNull());
    } else {
      expect(confirm).toBeNull();
      expect(screen.getByText(/must be observed before continuing/)).toBeVisible();
      expect(loadAllowanceCleanup(config)).toEqual(record);
    }
  });

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

  it("does not let stale cleanup confirmation erase a hash added in another tab", async () => {
    const user = userEvent.setup();
    const record = {
      version: 2, networkIdHex: config.networkIdHex, accountAddress: hex(9),
      tokenAddress: hex(6), spenderAddress: hex(7), status: "signing",
      transactionHash: null, difference: "-300", updatedAt: 10,
    };
    window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify(record));
    renderPage({});
    window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify({ ...record, transactionHash: hex(42) }));
    await user.click(screen.getByRole("button", { name: "Confirm allowance cleanup was not signed" }));
    expect(await screen.findByText("The allowance cleanup has a transaction hash and must be observed")).toBeVisible();
    expect(loadAllowanceCleanup(config)?.transactionHash).toBe(hex(42));
    expect(screen.queryByRole("button", { name: "Confirm allowance cleanup was not signed" })).toBeNull();
  });

  it("preserves failed creation on cleanup network mismatch and permits verified retry", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review());
    workflow.status = "failed";
    workflow.steps.approveFunding = {
      ...workflow.steps.approveFunding, status: "committed", transactionHash: hex(40), receiptBlock: "11",
    };
    workflow.steps.createPool.status = "failed";
    saveCreationWorkflow(config, workflow);
    const execute = vi.fn();
    const readFactoryAllowance = vi.fn(async () => ({ value: 0n, height: 12n }));
    renderPage({ writer: { execute }, readFactoryAllowance });
    vi.mocked(createNetworkReadClient).mockRejectedValueOnce(new NetworkMismatchError());
    await user.click(screen.getByRole("button", { name: "Remove factory funding allowance" }));
    expect(await screen.findByText(/different Groundhog network/)).toBeVisible();
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(workflow);
    expect(readFactoryAllowance).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove factory funding allowance" }));
    await waitFor(() => expect(loadCreationWorkflow(config, hex(1), hex(2))?.status).toBe("archived"));
    expect(screen.getByRole("button", { name: "Start another pool" })).toBeVisible();
  });

  it("observes interrupted factory cleanup by hash without signing again", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review());
    workflow.status = "failed";
    workflow.steps.approveFunding = {
      ...workflow.steps.approveFunding, status: "committed", transactionHash: hex(40), receiptBlock: "11",
    };
    workflow.steps.createPool.status = "failed";
    saveCreationWorkflow(config, workflow);
    window.localStorage.setItem(allowanceCleanupKey(config), JSON.stringify({
      version: 2, networkIdHex: config.networkIdHex, accountAddress: hex(9),
      tokenAddress: hex(6), spenderAddress: hex(7), status: "signing",
      transactionHash: hex(42), difference: "-300", updatedAt: 10,
    }));
    const execute = vi.fn();
    const observe = vi.fn().mockResolvedValue({ kind: "committedSuccess", hash: hex(42), receipt: {} });
    renderPage({ writer: { execute, observe } });
    await user.click(screen.getByRole("button", { name: "Remove factory funding allowance" }));
    await waitFor(() => expect(loadCreationWorkflow(config, hex(1), hex(2))?.status).toBe("archived"));
    expect(observe).toHaveBeenCalledWith(hex(42));
    expect(execute).not.toHaveBeenCalled();
    expect(loadAllowanceCleanup(config)).toBeNull();
    expect(screen.queryByText("Pending allowance cleanup")).toBeNull();
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

  it("does not reuse a workflow from another factory for a new creation", async () => {
    const user = userEvent.setup();
    const otherConfig = { ...config, factoryAddress: address(17) };
    const obsolete = saveCreationWorkflow(
      otherConfig,
      createCreationWorkflow(otherConfig, review(), 10),
    );
    const run = vi.fn(async (_config: GlobalConfig, current: CreationWorkflow) => current);
    renderPage({ prepare: vi.fn().mockResolvedValue(review()), run }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);

    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await user.click(await screen.findByRole("button", { name: "Create pool" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1]).toMatchObject({ factoryAddress: hex(7) });
    expect(run.mock.calls[0]![1].id).not.toBe(obsolete.id);
  });

  it("starts fresh when raced pool liquidity later fails", async () => {
    const user = userEvent.setup();
    const failed = createCreationWorkflow(config, review(), 10);
    failed.status = "failed";
    failed.pool = {
      liquidityToken: hex(21),
      handler: hex(22),
      driver: hex(23),
    };
    failed.requestId = hex(30);
    failed.enqueueReceiptBlock = "12";
    failed.steps.approveFunding = {
      status: "committed",
      transactionHash: hex(40),
      receiptBlock: "10",
      message: null,
      updatedAt: 10,
    };
    failed.steps.createPool.status = "skipped";
    failed.steps.enqueue = {
      status: "committed",
      transactionHash: hex(41),
      receiptBlock: "12",
      message: null,
      updatedAt: 12,
    };
    saveCreationWorkflow(config, failed);
    const run = vi.fn(async (_config: GlobalConfig, current: CreationWorkflow) => current);
    renderPage({ prepare: vi.fn().mockResolvedValue(review()), run }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);

    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await user.click(await screen.findByRole("button", { name: "Create pool" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1].id).not.toBe(failed.id);
  });

  it("requests best-effort registry sync when verified pool creation commits", async () => {
    const user = userEvent.setup();
    config.registryEnabled = true;
    const requestRegistrySync = vi.fn().mockRejectedValue(new Error("offline"));
    const run = vi.fn(async (
      _config: GlobalConfig,
      current: CreationWorkflow,
      dependencies: { onUpdate?: (workflow: CreationWorkflow) => void },
    ) => {
      const next = {
        ...current,
        status: "race" as const,
        steps: {
          ...current.steps,
          createPool: { ...current.steps.createPool, status: "committed" as const },
        },
      };
      dependencies.onUpdate?.(next);
      return next;
    });
    renderPage({ prepare: vi.fn().mockResolvedValue(review()), run, requestRegistrySync }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);

    await user.click(screen.getByRole("button", { name: "Review pool" }));
    await user.click(await screen.findByRole("button", { name: "Create pool" }));

    await waitFor(() => expect(requestRegistrySync).toHaveBeenCalledWith(config));
    expect(await screen.findByText("race")).toBeVisible();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
  });

  it("loads two link presets independently without amounts, auto review, or URL writes", async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    renderPage({ prepare, run }, `?tokenA=${hex(2)}&tokenB=${hex(1)}&amountA=9&autoSubmit=true`);
    expect(screen.getAllByLabelText("Contract address").map((el) => (el as HTMLInputElement).value)).toEqual([hex(2), hex(1)]);
    expect(screen.getAllByLabelText("Initial amount").every((el) => (el as HTMLInputElement).value === "")).toBe(true);
    await waitFor(() => expect(screen.getAllByText("Live name: Live token")).toHaveLength(2));
    expect(createNetworkReadClient).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    push.mockRestore();
    replace.mockRestore();
  });

  it("warns on invalid presets and reads only the independently valid slot", async () => {
    renderPage({}, `?tokenA=bad&tokenB=${hex(2)}`);
    expect(screen.getByText(/tokenA preset was ignored/)).toBeVisible();
    expect(screen.getAllByLabelText("Contract address")[0]).toHaveValue("");
    await waitFor(() => expect(createNetworkReadClient).toHaveBeenCalledTimes(1));
  });

  it("gives recovery priority and starts empty after reset, without replaying URL tokens", async () => {
    const user = userEvent.setup();
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.status = "race";
    saveCreationWorkflow(config, workflow);
    renderPage({}, `?tokenA=${hex(4)}&tokenB=${hex(5)}`);
    expect(screen.getByText(/saved creation is being recovered/)).toBeVisible();
    expect(createNetworkReadClient).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start another pool" }));
    expect(screen.getAllByLabelText("Contract address").every((el) => (el as HTMLInputElement).value === "")).toBe(true);
    expect(createNetworkReadClient).not.toHaveBeenCalled();
  });

  it("does not use presets or enable review when storage cannot be read safely", () => {
    saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    const get = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    renderPage({}, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    expect(screen.getByText(/could not be loaded safely/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Review pool" })).toBeDisabled();
    expect(createNetworkReadClient).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("clears the edited token amount and rejects a late review for old input", async () => {
    const user = userEvent.setup();
    let resolve!: (value: PoolCreationReview) => void;
    const prepare = vi.fn(() => new Promise<PoolCreationReview>((done) => { resolve = done; }));
    renderPage({ prepare }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    fireEvent.change(screen.getAllByLabelText("Initial amount")[0]!, { target: { value: "2" } });
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    fireEvent.change(screen.getAllByLabelText("Contract address")[0]!, { target: { value: "0x" } });
    expect(screen.getAllByLabelText("Initial amount")[0]).toHaveValue("");
    await act(async () => resolve(review()));
    expect(screen.queryByRole("button", { name: "Create pool" })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Contract address")[0]).toHaveValue("0x");
  });

  it("does not reapply link presets when the query changes on the same mount", async () => {
    const user = userEvent.setup();
    renderPage({}, `?tokenA=${hex(1)}`);
    await waitFor(() => expect(createNetworkReadClient).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getAllByLabelText("Contract address")[0]!, { target: { value: "0x" } });
    await user.click(screen.getByRole("link", { name: "Change test query" }));
    expect(screen.getByTestId("search")).toHaveTextContent(`?tokenB=${hex(4)}`);
    expect(screen.getAllByLabelText("Contract address")[0]).toHaveValue("0x");
    expect(screen.getAllByLabelText("Contract address")[1]).toHaveValue("");
    expect(createNetworkReadClient).toHaveBeenCalledTimes(1);
  });

  it("invalidates a completed review on amount edits and a pending review on late failure", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const prepare = vi.fn().mockResolvedValueOnce(review()).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderPage({ prepare }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    expect(await screen.findByRole("button", { name: "Create pool" })).toBeVisible();
    fireEvent.change(screen.getAllByLabelText("Initial amount")[1]!, { target: { value: "5" } });
    expect(screen.queryByRole("button", { name: "Create pool" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    fireEvent.change(screen.getAllByLabelText("Initial amount")[1]!, { target: { value: "6" } });
    await act(async () => reject(new Error("Old review error")));
    expect(screen.queryByText("Old review error")).not.toBeInTheDocument();
  });

  it("blocks mismatched-network review until retry and permits fresh review after transient preview failure", async () => {
    const user = userEvent.setup();
    vi.mocked(createNetworkReadClient).mockRejectedValueOnce(new NetworkMismatchError()).mockRejectedValueOnce(new Error("offline"));
    const prepare = vi.fn().mockResolvedValue(review());
    renderPage({ prepare }, `?tokenA=${hex(1)}&tokenB=${hex(2)}`);
    await screen.findByText(/RPC network mismatch/);
    expect(screen.getByRole("button", { name: "Review pool" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry Token A metadata" }));
    await screen.findByText("Live name: Live token");
    expect(screen.getByText(/Live token metadata is unavailable/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    expect(await screen.findByRole("button", { name: "Create pool" })).toBeVisible();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("cannot expose an old account's pending review after a configuration remount", async () => {
    const user = userEvent.setup();
    let resolve!: (value: PoolCreationReview) => void;
    const prepare = vi.fn(() => new Promise<PoolCreationReview>((done) => { resolve = done; }));
    const tree = (current: GlobalConfig) => (
      <MemoryRouter initialEntries={[`/pools/new?tokenA=${hex(1)}&tokenB=${hex(2)}`]}>
        <ProcessingModeProvider>
          <PoolCreatePage config={current} dependencies={{ prepare, writer: unavailableWriteBoundary }} />
        </ProcessingModeProvider>
      </MemoryRouter>
    );
    const page = render(tree(config));
    await user.click(screen.getByRole("button", { name: "Review pool" }));
    const oldSignals = vi.mocked(createNetworkReadClient).mock.calls.map(([, signal]) => signal);
    page.rerender(tree({ ...config, accountAddress: address(10) }));
    expect(oldSignals.every((signal) => signal?.aborted)).toBe(true);
    await act(async () => resolve(review()));
    expect(screen.queryByRole("button", { name: "Create pool" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review pool" })).toBeEnabled();
  });
});

function renderPage(
  dependencies: React.ComponentProps<typeof PoolCreatePage>["dependencies"],
  search = "",
  explorerUrl?: string,
) {
  return render(
    <MemoryRouter initialEntries={[`/pools/new${search}`]}>
      <TooltipProvider>
        <ExplorerProvider value={explorerUrl}>
        <ProcessingModeProvider>
          <PoolCreatePage config={config} dependencies={{
            writer: unavailableWriteBoundary,
            ...dependencies,
          }} />
          <Link to={`?tokenB=${hex(4)}`}>Change test query</Link>
          <SearchLocation />
        </ProcessingModeProvider>
        </ExplorerProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function SearchLocation() {
  return <output data-testid="search">{useLocation().search}</output>;
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
