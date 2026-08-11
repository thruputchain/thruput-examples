import { contractAddress, ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/app";
import type { AppConfig } from "@/config";
import { REQUEST_ACCEPTED_SIGNATURE } from "@/contracts/swap-event";
import type { PoolSnapshot, SnapshotReader } from "@/swap/snapshot";
import type { RequestObserver } from "@/transactions/request-observer";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  clearOutstandingRequest,
  loadOutstandingRequest,
  outstandingRequestKey,
  saveOutstandingRequest,
} from "@/transactions/outstanding-request";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  pairAddress: address(7),
  handlerAddress: address(6),
  driverAddress: address(5),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "gUSD",
  tokenBSymbol: "gEUR",
  tokenDecimals: 6,
};

beforeEach(() => window.localStorage.clear());

function pool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    tokenA: {
      address: config.tokenAAddress,
      name: "Groundhog USD",
      symbol: "gUSD",
      decimals: 6,
      balance: 12_000_000n,
      allowance: 0n,
    },
    tokenB: {
      address: config.tokenBAddress,
      name: "Groundhog EUR",
      symbol: "gEUR",
      decimals: 6,
      balance: 34_000_000n,
      allowance: 0n,
    },
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    reserveTimestamp: 1n,
    chainHeight: 7n,
    readAt: 1,
    ...overrides,
  };
}

function renderApp(
  readSnapshot: SnapshotReader = async () => pool(),
  writeBoundary?: WriteBoundary,
  requestObserver: RequestObserver = {
    scan: async () => null,
  },
) {
  return render(
    <App
      config={config}
      readSnapshot={readSnapshot}
      requestObserver={requestObserver}
      {...(writeBoundary === undefined ? {} : { writeBoundary })}
    />,
  );
}

const hash = `0x${"ab".repeat(32)}`;
const criteria = {
  pairAddress: `0x${"07".repeat(32)}`,
  handlerAddress: `0x${"06".repeat(32)}`,
  driverAddress: `0x${"05".repeat(32)}`,
  recipient: `0x${"09".repeat(32)}`,
  tokenIn: `0x${"01".repeat(32)}`,
  tokenOut: `0x${"02".repeat(32)}`,
};

function committedSuccess(
  height: bigint,
): Extract<WriteResult, { kind: "committedSuccess" }> {
  return {
    kind: "committedSuccess",
    hash,
    receipt: {
      txHash: sha256Hash(new Uint8Array(32).fill(0xab)),
      height,
      execResult: ExecResult.ExecResultOK,
      events: [
        {
          contractAddress: config.driverAddress,
          topics: [
            REQUEST_ACCEPTED_SIGNATURE,
            new Uint8Array(32).fill(0xcd),
          ],
          data: new Uint8Array(),
        },
      ],
      returnData: new Uint8Array(),
      abortData: null,
    },
  };
}

describe("read-only swap experience", () => {
  it("loads the local snapshot and derives an exact-input preview", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByLabelText("Loading pool")).toBeInTheDocument();
    await user.type(await screen.findByLabelText("YOU PAY"), "10");

    expect(screen.getByLabelText("Estimated output")).toHaveTextContent("19.74316");
    expect(screen.getByText("19.644444 gEUR")).toBeInTheDocument();
    expect(screen.getByText("Estimated output")).toBeInTheDocument();
    expect(screen.getByText("Minimum output")).toBeInTheDocument();
    expect(screen.getByText("0.3%", { selector: "dd" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Switch direction to gEUR for gUSD" }),
    );
    await user.type(screen.getByLabelText("YOU PAY"), "10");
    expect(screen.getByLabelText("Estimated output")).toHaveTextContent("4.960273");
    expect(screen.getByText("4.935471 gUSD")).toBeInTheDocument();
  });

  it("validates malformed, zero, precision, and excessive amounts", async () => {
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByLabelText("YOU PAY");

    await user.type(input, "nope");
    expect(screen.getByText("Enter a valid decimal amount.")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "0");
    expect(screen.getByText("Amount must be greater than zero.")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "0.0000001");
    expect(screen.getByText(/does not support that many/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "13");
    expect(screen.getByText(/exceeds your available balance/)).toBeInTheDocument();
  });

  it("supports slippage presets, custom validation, and high-risk warning", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText("YOU PAY");

    await user.click(screen.getByRole("button", { name: /0.5%/ }));
    await user.click(screen.getByRole("radio", { name: "1%" }));
    expect(screen.getByLabelText("Custom percentage")).toHaveValue("1");
    await user.clear(screen.getByLabelText("Custom percentage"));
    await user.type(screen.getByLabelText("Custom percentage"), "5.01");
    expect(screen.getByText("High slippage")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Custom percentage"));
    await user.type(screen.getByLabelText("Custom percentage"), "50.01");
    expect(screen.getByText(/no more than 50%/)).toBeInTheDocument();
  });

  it("operates slippage and transaction details from the keyboard", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText("YOU PAY");

    const slippage = screen.getByRole("button", { name: /0.5%/ });
    slippage.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Slippage tolerance" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const details = screen.getByRole("button", {
      name: "Transaction details",
    });
    details.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Allowance change")).toBeInTheDocument();
  });

  it("distinguishes RPC failure, retry, and empty liquidity", async () => {
    const user = userEvent.setup();
    const read = vi
      .fn<SnapshotReader>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(pool({ reserve0: 0n }));
    renderApp(read);

    expect(await screen.findByText("RPC unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Empty pool")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pool has no liquidity/ })).toBeDisabled();
  });

  it("ignores an older refresh that resolves after a newer request", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: PoolSnapshot) => void) | undefined;
    const first = new Promise<PoolSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const read = vi
      .fn<SnapshotReader>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(pool({ chainHeight: 9n }));
    renderApp(read);

    await user.click(screen.getByRole("button", { name: "Refresh pool data" }));
    expect((await screen.findAllByText(/block 9/)).length).toBeGreaterThan(0);
    await act(async () => resolveFirst?.(pool({ chainHeight: 8n })));
    await waitFor(() =>
      expect(screen.getAllByText(/block 9/).length).toBeGreaterThan(0),
    );
  });

});

describe("local swap submission", () => {
  it("approves the exact amount and queues the swap from one click", async () => {
    const user = userEvent.setup();
    const read = vi
      .fn<SnapshotReader>()
      .mockResolvedValueOnce(pool())
      .mockResolvedValueOnce(pool())
      .mockResolvedValue(pool({
        tokenA: { ...pool().tokenA, allowance: 10_000_000n },
        chainHeight: 8n,
      }));
    const writer: WriteBoundary = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(committedSuccess(8n))
        .mockResolvedValueOnce(committedSuccess(9n)),
    };
    renderApp(read, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    expect(await screen.findByRole("button", { name: "Queued for execution" })).toBeDisabled();
    expect(writer.execute).toHaveBeenCalledTimes(2);
  });

  it("does not lower the reviewed minimum output after approval", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
      chainHeight: 8n,
    });
    const read = vi
      .fn<SnapshotReader>()
      .mockResolvedValueOnce(pool())
      .mockResolvedValueOnce(pool())
      .mockResolvedValueOnce(approved)
      .mockResolvedValue({ ...approved, reserve1: 1_000_000n });
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue(committedSuccess(8n)),
    };
    renderApp(read, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    expect(
      await screen.findByText(/moved beyond your reviewed slippage limit/, {
        selector: "[data-slot='alert-description']",
      }),
    ).toBeInTheDocument();
    expect(writer.execute).toHaveBeenCalledTimes(1);
  });

  it("shows a successful router receipt as queued and blocks duplicates", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue(committedSuccess(12n)),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(await screen.findByText("Queued for execution", { selector: "div" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Transaction status" }),
      ).toHaveTextContent("Swap queued for execution."),
    );
    expect(screen.getByText(/bash scripts\/crank-local\.sh/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queued for execution" })).toBeDisabled();
    expect(writer.execute).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", {
        name: "I cranked and confirmed the queue is drained",
      }),
    );
    expect(loadOutstandingRequest(config)).toBeNull();
    expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
  });

  it("reports a queued receipt whose request ID cannot be decoded", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const result = committedSuccess(12n);
    result.receipt.events = [];
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue(result),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(
      await screen.findByText("Queued; request ID unavailable", {
        selector: "div",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toHaveTextContent("Swap queued, but its request ID is unavailable.");
    expect(
      screen.getByRole("button", { name: "Queued; request ID unavailable" }),
    ).toBeDisabled();
  });

  it("keeps an indeterminate submission non-resubmittable", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue({
        kind: "indeterminate",
        hash,
        reason: "disconnect",
      } satisfies WriteResult),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(await screen.findByText("Outcome uncertain")).toBeInTheDocument();
    expect(
      screen.getByText(/Do not submit another transaction/, {
        selector: "[data-slot='alert-description']",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outcome is uncertain" })).toBeDisabled();
  });

  it("persists the signed hash before swap polling completes", async () => {
    const user = userEvent.setup();
    let resolveWrite: ((result: WriteResult) => void) | undefined;
    const pending = new Promise<WriteResult>((resolve) => {
      resolveWrite = resolve;
    });
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const writer: WriteBoundary = {
      execute(_target, observer) {
        observer?.onSigned(hash);
        return pending;
      },
    };
    renderApp(async () => approved, writer);
    const status = await screen.findByRole("status", {
      name: "Transaction status",
    });
    expect(status).toBeEmptyDOMElement();

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    await waitFor(() => expect(status).toHaveTextContent("Submitting swap."));
    expect(loadOutstandingRequest(config)?.transactionHash).toBe(hash);
    await act(async () => resolveWrite?.({ kind: "invalid", hash, reason: "expired" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(status).toBeEmptyDOMElement();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toBe(status);
  });

  it("shows approval progress and permits correction after authoritative invalidation", async () => {
    const user = userEvent.setup();
    let resolveWrite: ((result: WriteResult) => void) | undefined;
    const pending = new Promise<WriteResult>((resolve) => {
      resolveWrite = resolve;
    });
    const writer: WriteBoundary = { execute: vi.fn().mockReturnValue(pending) };
    renderApp(async () => pool(), writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));
    expect(await screen.findByRole("button", { name: "Approving swap" })).toBeDisabled();
    expect(screen.queryByText(/before this page was restored/)).not.toBeInTheDocument();

    await act(async () => resolveWrite?.({ kind: "invalid", hash, reason: "expired" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
    expect(
      screen.getByText("expired", {
        selector: "[data-slot='alert-description']",
      }),
    ).toBeInTheDocument();
    expect(writer.execute).toHaveBeenCalledTimes(1);
  });

  it("persists an indeterminate approval across reloads", async () => {
    const user = userEvent.setup();
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue({
        kind: "indeterminate",
        hash,
        reason: "disconnect",
      } satisfies WriteResult),
    };
    renderApp(async () => pool(), writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    await screen.findByText("Outcome uncertain");
    expect(loadOutstandingRequest(config)).toMatchObject({
      status: "indeterminate",
      phase: "approval",
      transactionHash: hash,
    });
  });

  it("does not automatically recheck or rewrite a restored indeterminate request", async () => {
    const user = userEvent.setup();
    saveOutstandingRequest(config, {
      status: "indeterminate",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const writer: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn().mockResolvedValue({
        kind: "indeterminate",
        hash,
        reason: "timeout",
      } satisfies WriteResult),
    };
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    renderApp(async () => pool(), writer);

    await screen.findByLabelText("YOU PAY");
    expect(writer.observe).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Check transaction status" }),
    );
    await waitFor(() => expect(writer.observe).toHaveBeenCalledTimes(1));
    expect(storageWrite).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Check transaction status" }),
    );
    await waitFor(() => expect(writer.observe).toHaveBeenCalledTimes(2));
  });

  it("stops after a signed approval when the workspace unmounts", async () => {
    const user = userEvent.setup();
    let resolveApproval!: (result: WriteResult) => void;
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        observer?.onSigned(hash);
        return new Promise<WriteResult>((resolve) => {
          resolveApproval = resolve;
        });
      }),
    };
    const view = renderApp(async () => pool(), writer);
    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));
    await waitFor(() =>
      expect(loadOutstandingRequest(config)?.transactionHash).toBe(hash),
    );

    view.unmount();
    await act(async () => resolveApproval(committedSuccess(12n)));

    expect(writer.execute).toHaveBeenCalledTimes(1);
    expect(loadOutstandingRequest(config)).toMatchObject({
      status: "approving",
      phase: "approval",
      transactionHash: hash,
    });
  });

  it("keeps a committed router failure non-resubmittable", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const failedReceipt = committedSuccess(12n).receipt;
    const writer: WriteBoundary = {
      execute: vi.fn().mockResolvedValue({
        kind: "committedFailure",
        hash,
        receipt: {
          ...failedReceipt,
          execResult: ExecResult.ExecResultTxRootFrameReverted,
        },
      } satisfies WriteResult),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(await screen.findByRole("button", { name: "Transaction failed" })).toBeDisabled();
    expect(screen.getByText(/committed with a failed execution/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge committed failure" }));
    expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
  });

  it("restores an outstanding queued request after a reload", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    renderApp(async () => approved);

    await screen.findByLabelText("YOU PAY");
    expect(screen.getByText("Queued for execution", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queued for execution" })).toBeDisabled();
  });

  it("observes a restored queued request and refreshes the snapshot", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const readSnapshot = vi.fn(async () => pool());
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockResolvedValue({
        kind: "executionObserved",
        requestId: `0x${"cd".repeat(32)}`,
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 19_500_000n,
      }),
    };
    renderApp(readSnapshot, undefined, requestObserver);

    expect(await screen.findByText("Execution observed")).toBeInTheDocument();
    expect(screen.getByText(/10 gUSD was exchanged for 19.5 gEUR/)).toBeInTheDocument();
    expect(loadOutstandingRequest(config)).toBeNull();
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
  });

  it("keeps an observation timeout queued and nonterminal", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 120_000,
      observationBaseline: null,
      criteria,
    });
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockResolvedValue(null),
    };
    renderApp(async () => pool(), undefined, requestObserver);

    expect(await screen.findByText("Execution not observed")).toBeInTheDocument();
    expect(screen.getByText(/absence of an event does not prove failure/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queued; execution not observed" })).toBeDisabled();
    expect(loadOutstandingRequest(config)?.status).toBe("queuedNotObserved");
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalled());
  });

  it("observes terminal execution after the visible timeout", async () => {
    saveOutstandingRequest(config, {
      status: "queuedNotObserved",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 120_000,
      observationBaseline: null,
      criteria,
    });
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockResolvedValue({
        kind: "executionObserved",
        requestId: `0x${"cd".repeat(32)}`,
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 19_500_000n,
      }),
    };
    renderApp(async () => pool(), undefined, requestObserver);

    expect(await screen.findByText("Execution observed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("labels restored reverse-direction execution with the persisted tokens", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 4_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria: {
        ...criteria,
        tokenIn: criteria.tokenOut,
        tokenOut: criteria.tokenIn,
      },
    });
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockResolvedValue({
        kind: "executionObserved",
        requestId: `0x${"cd".repeat(32)}`,
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 4_500_000n,
      }),
    };
    renderApp(async () => pool(), undefined, requestObserver);

    expect(await screen.findByText(/10 gEUR was exchanged for 4.5 gUSD/)).toBeInTheDocument();
  });

  it("does not overlap event scans across visibility changes", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    let resolveScan!: (value: null) => void;
    const scanResult = new Promise<null>(
      (resolve) => { resolveScan = resolve; },
    );
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(scanResult),
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    try {
      renderApp(async () => pool(), undefined, requestObserver);
      await screen.findByLabelText("YOU PAY");
      await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(requestObserver.scan).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveScan(null);
      });
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it("does not restore a request cleared by another tab during a scan", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    let resolveScan!: (value: null) => void;
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(
        new Promise<null>((resolve) => {
          resolveScan = resolve;
        }),
      ),
    };
    renderApp(async () => pool(), undefined, requestObserver);
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));

    clearOutstandingRequest(config);
    window.dispatchEvent(new StorageEvent("storage", {
      key: outstandingRequestKey(config),
      newValue: null,
    }));
    await act(async () => {
      resolveScan(null);
    });

    expect(loadOutstandingRequest(config)).toBeNull();
    expect(screen.queryByText("Queued for execution", { selector: "div" })).not.toBeInTheDocument();
  });

  it("accepts a terminal event from a scan already running at timeout", async () => {
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 119_900,
      observationBaseline: null,
      criteria,
    });
    let resolveScan!: (value: Awaited<ReturnType<RequestObserver["scan"]>>) => void;
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(
        new Promise<Awaited<ReturnType<RequestObserver["scan"]>>>((resolve) => {
          resolveScan = resolve;
        }),
      ),
    };
    renderApp(async () => pool(), undefined, requestObserver);
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Execution not observed")).toBeInTheDocument();

    await act(async () => {
      resolveScan({
        kind: "executionObserved",
        requestId: `0x${"cd".repeat(32)}`,
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 19_500_000n,
      });
    });

    expect(await screen.findByText("Execution observed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("accepts a terminal scan after another tab records the timeout", async () => {
    const queuedRequest = {
      status: "queued" as const,
      phase: "swap" as const,
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    };
    saveOutstandingRequest(config, queuedRequest);
    let resolveScan!: (
      value: Awaited<ReturnType<RequestObserver["scan"]>>,
    ) => void;
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
      ),
    };
    renderApp(async () => pool(), undefined, requestObserver);
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));

    saveOutstandingRequest(config, {
      ...queuedRequest,
      status: "queuedNotObserved",
      visibleObservationMs: 120_000,
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: outstandingRequestKey(config),
      }),
    );
    await act(async () =>
      resolveScan({
        kind: "executionObserved",
        requestId: queuedRequest.requestId,
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 19_500_000n,
      }),
    );

    expect(await screen.findByText("Execution observed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("does not regress visible observation time written by another tab", async () => {
    const queuedRequest = {
      status: "queued" as const,
      phase: "swap" as const,
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    };
    saveOutstandingRequest(config, queuedRequest);
    let resolveScan!: (value: null) => void;
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(
        new Promise<null>((resolve) => {
          resolveScan = resolve;
        }),
      ),
    };
    renderApp(async () => pool(), undefined, requestObserver);
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));

    saveOutstandingRequest(config, {
      ...queuedRequest,
      visibleObservationMs: 100_000,
    });
    await act(async () => {
      resolveScan(null);
    });

    expect(loadOutstandingRequest(config)?.visibleObservationMs).toBeGreaterThanOrEqual(100_000);
  });

  it("requires explicit confirmation to clear a restored pre-hash marker", async () => {
    const user = userEvent.setup();
    saveOutstandingRequest(config, {
      status: "submitting",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: null,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    renderApp(async () => pool());

    await screen.findByLabelText("YOU PAY");
    await user.click(
      screen.getByRole("button", {
        name: "I confirmed no transaction is pending or queued",
      }),
    );

    expect(loadOutstandingRequest(config)).toBeNull();
  });

  it("allows explicit clearing of a restored null-hash indeterminate marker", async () => {
    const user = userEvent.setup();
    saveOutstandingRequest(config, {
      status: "indeterminate",
      phase: "approval",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: null,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    renderApp(async () => pool());

    await user.click(
      await screen.findByRole("button", {
        name: "I confirmed no transaction is pending or queued",
      }),
    );

    expect(loadOutstandingRequest(config)).toBeNull();
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();
  });

  it("reconciles a restored signed swap into the queued state", async () => {
    saveOutstandingRequest(config, {
      status: "submitting",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const writer: WriteBoundary = {
      execute: async () => ({
        kind: "preSubmissionFailure",
        hash: null,
        message: "not used",
      }),
      observe: vi.fn().mockResolvedValue(committedSuccess(12n)),
    };
    render(
      <StrictMode>
        <App
          config={config}
          readSnapshot={async () => pool()}
          requestObserver={{
            scan: async () => null,
          }}
          writeBoundary={writer}
        />
      </StrictMode>,
    );

    expect(await screen.findByText("Queued for execution", { selector: "div" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Transaction status" }),
      ).toHaveTextContent("Swap queued for execution."),
    );
    expect(loadOutstandingRequest(config)).toMatchObject({
      status: "queued",
      transactionHash: hash,
      receiptBlock: 12n,
    });
    expect(writer.observe).toHaveBeenCalledTimes(1);
    expect(writer.observe).toHaveBeenCalledWith(hash);
  });

  it("does not recreate a restored request cleared during transaction observation", async () => {
    saveOutstandingRequest(config, {
      status: "submitting",
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: null,
      requestId: null,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    let resolveObservation!: (result: WriteResult) => void;
    const writer: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn().mockReturnValue(
        new Promise<WriteResult>((resolve) => {
          resolveObservation = resolve;
        }),
      ),
    };
    renderApp(async () => pool(), writer);
    await waitFor(() => expect(writer.observe).toHaveBeenCalledTimes(1));

    clearOutstandingRequest(config);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: outstandingRequestKey(config),
        newValue: null,
      }),
    );
    await act(async () => resolveObservation(committedSuccess(12n)));

    expect(loadOutstandingRequest(config)).toBeNull();
    expect(
      screen.queryByText("Queued for execution", { selector: "div" }),
    ).not.toBeInTheDocument();
  });

  it("serializes submission attempts across two app instances", async () => {
    const user = userEvent.setup();
    let previousLock = Promise.resolve();
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          name: string,
          options: LockOptions,
          callback: (lock: Lock) => Promise<unknown>,
        ) => {
          const previous = previousLock;
          let release = () => {};
          previousLock = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await callback({ name, mode: options.mode ?? "exclusive" });
          } finally {
            release();
          }
        },
      },
    });
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    let resolveWrite: ((result: WriteResult) => void) | undefined;
    const pending = new Promise<WriteResult>((resolve) => {
      resolveWrite = resolve;
    });
    const writer: WriteBoundary = { execute: vi.fn().mockReturnValue(pending) };
    const first = render(
      <App config={config} readSnapshot={async () => approved} writeBoundary={writer} />,
    );
    const second = render(
      <App config={config} readSnapshot={async () => approved} writeBoundary={writer} />,
    );
    const firstView = within(first.container);
    const secondView = within(second.container);

    await user.type(await firstView.findByLabelText("YOU PAY"), "10");
    await user.type(await secondView.findByLabelText("YOU PAY"), "10");
    await user.click(firstView.getByRole("button", { name: "Swap" }));
    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(1));
    await user.click(secondView.getByRole("button", { name: "Swap" }));
    expect(secondView.getByLabelText("YOU PAY")).toBeDisabled();
    expect(
      secondView.getByRole("button", { name: "Submitting swap" }),
    ).toBeDisabled();

    await act(async () => resolveWrite?.(committedSuccess(12n)));

    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(1));
    expect(loadOutstandingRequest(config)?.status).toBe("queued");
  });
});
