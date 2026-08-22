import { contractAddress, ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/app";
import type { AppConfig } from "@/config";
import {
  RequestAccepted,
  RequestFailed,
} from "@/contracts/generated/swap-driver";
import type { PoolSnapshot, SnapshotReader } from "@/swap/snapshot";
import type {
  RequestObservation,
  RequestObserver,
} from "@/transactions/request-observer";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  crankAttemptKey,
  createCrankAttempt,
  loadCrankAttempt,
  saveCrankAttempt,
} from "@/transactions/crank-attempt";
import {
  createRequestRecord,
  loadRequestCollection,
  requestCollectionKey,
  saveRequestCollection,
  upsertRequest,
} from "@/transactions/request-collection";
import type { OutstandingRequest } from "@/transactions/outstanding-request";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(10),
  nativeHogAddress: address(11),
  poolContractFunding: 10_000_000n,
  pairAddress: address(7),
  liquidityTokenAddress: address(12),
  handlerAddress: address(6),
  driverAddress: address(5),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "gUSD",
  tokenBSymbol: "gEUR",
  tokenADecimals: 6,
  tokenBDecimals: 6,
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
    liquidityTotalSupply: 1_000_000_000n,
    liquidityBalance: 100_000_000n,
    feeTo: null,
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

async function enableManualProcessing(container?: HTMLElement): Promise<void> {
  const scope = container === undefined ? screen : within(container);
  await userEvent.setup().click(
    await scope.findByRole("switch", { name: "Manual queue processing" }),
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

function saveOutstandingRequest(
  activeConfig: AppConfig,
  request: OutstandingRequest,
): void {
  const record = createRequestRecord(request, {
    localId: "test-outstanding-request",
    now: 1,
  });
  saveRequestCollection(
    activeConfig,
    upsertRequest(loadRequestCollection(activeConfig), record),
  );
}

function loadOutstandingRequest(activeConfig: AppConfig) {
  return loadRequestCollection(activeConfig).at(-1) ?? null;
}

function clearOutstandingRequest(activeConfig: AppConfig): void {
  saveRequestCollection(activeConfig, []);
}

function queuedRequest(
  localId: string,
  requestByte: number,
  status: "queued" | "queuedNotObserved" | "queuedUntracked" = "queued",
) {
  return createRequestRecord(
    {
      status,
      phase: "swap",
      intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: status === "queuedUntracked"
        ? null
        : `0x${requestByte.toString(16).padStart(2, "0").repeat(32)}`,
      visibleObservationMs: status === "queuedNotObserved" ? 120_000 : 0,
      observationBaseline: null,
      criteria,
    },
    { localId, now: requestByte },
  );
}

const outstandingRequestKey = requestCollectionKey;

function committedSuccess(
  height: bigint,
  requestByte = 0xcd,
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
            RequestAccepted.signature,
            new Uint8Array(32).fill(requestByte),
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
  it("approves, queues, and processes one batch from one click", async () => {
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
        .mockResolvedValueOnce(committedSuccess(9n))
        .mockResolvedValueOnce(committedSuccess(10n)),
    };
    renderApp(read, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    expect(await screen.findByText("Execution pending")).toBeInTheDocument();
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();
    expect(writer.execute).toHaveBeenCalledTimes(3);
    expect(vi.mocked(writer.execute).mock.calls.map(([target]) =>
      target.invoked_address
    )).toEqual([
      config.tokenAAddress,
      config.routerAddress,
      config.driverAddress,
    ]);
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

  it("keeps the form available after automatic queue processing commits", async () => {
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

    expect(await screen.findByText("Execution pending")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Transaction status" }),
      ).toHaveTextContent("Swap queued for execution."),
    );
    expect(screen.queryByText("Transaction queue")).not.toBeInTheDocument();
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
    expect(writer.execute).toHaveBeenCalledTimes(2);

    expect(screen.queryByRole("button", { name: "Resolve manually" })).not.toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("queued");
  });

  it("persists the queued request and signed crank before submitting it", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn(async (target, observer) => {
        write += 1;
        if (write === 1) {
          expect(target.invoked_address).toEqual(config.routerAddress);
          observer?.onSigned(hash);
          return committedSuccess(12n);
        }

        expect(target.invoked_address).toEqual(config.driverAddress);
        expect(loadRequestCollection(config)[0]?.status).toBe("queued");
        expect(loadCrankAttempt(config)).toMatchObject({
          status: "signing",
          transactionHash: null,
        });
        observer?.onSigned(hash);
        expect(loadCrankAttempt(config)?.transactionHash).toBe(hash);
        const result = committedSuccess(13n);
        result.receipt.events = [];
        return result;
      }),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(writer.execute).toHaveBeenCalledTimes(2);
  });

  it("never renders the manual crank action during automatic processing", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    let resolveCrank!: (result: WriteResult) => void;
    const pendingCrank = new Promise<WriteResult>((resolve) => {
      resolveCrank = resolve;
    });
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        write += 1;
        if (write === 1) return Promise.resolve(committedSuccess(12n));
        observer?.onSigned(hash);
        return pendingCrank;
      }),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(await screen.findByText("Processing queue")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Crank queue" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      const result = committedSuccess(13n);
      result.receipt.events = [];
      resolveCrank(result);
    });
    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(
      screen.queryByRole("button", { name: "Crank queue" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a committed crank recoverable when request persistence fails", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    let failRequestWrite = false;
    const storageWrite = vi.spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        if (failRequestWrite && key === requestCollectionKey(config)) {
          failRequestWrite = false;
          throw new Error("storage unavailable");
        }
        setItem(key, value);
      });
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        write += 1;
        if (write === 1) return committedSuccess(12n);
        observer?.onSigned(hash);
        failRequestWrite = true;
        const result = committedSuccess(13n);
        result.receipt.events = [];
        return result;
      }),
    };
    renderApp(async () => approved, writer);

    try {
      await user.type(await screen.findByLabelText("YOU PAY"), "10");
      await user.click(screen.getByRole("button", { name: "Swap" }));

      await waitFor(() =>
        expect(loadCrankAttempt(config)?.status).toBe("indeterminate")
      );
      expect(loadRequestCollection(config)[0]?.status).toBe("queued");
      expect(loadCrankAttempt(config)?.status).not.toBe("committed");
      expect(loadCrankAttempt(config)?.transactionHash).toBe(hash);
    } finally {
      storageWrite.mockRestore();
    }
  });

  it("retries an authoritative crank failure without resubmitting the swap", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const failedReceipt = committedSuccess(13n).receipt;
    const writer: WriteBoundary = {
      execute: vi.fn()
        .mockResolvedValueOnce(committedSuccess(12n))
        .mockResolvedValueOnce({
          kind: "committedFailure",
          hash,
          receipt: {
            ...failedReceipt,
            execResult: ExecResult.ExecResultTxRootFrameReverted,
          },
        } satisfies WriteResult)
        .mockResolvedValueOnce({
          ...committedSuccess(14n),
          receipt: { ...committedSuccess(14n).receipt, events: [] },
        }),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(
      await screen.findByText(/retry without resubmitting your swap/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toHaveTextContent(
      "Queue processing failed. Retry without resubmitting the swap.",
    );
    expect(loadRequestCollection(config)[0]?.status).toBe("queued");
    await user.click(
      screen.getByRole("button", { name: "Retry queue processing" }),
    );
    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(vi.mocked(writer.execute).mock.calls.map(([target]) =>
      target.invoked_address
    )).toEqual([
      config.routerAddress,
      config.driverAddress,
      config.driverAddress,
    ]);
  });

  it("blocks automatic swaps while the crank outcome is uncertain", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const writer: WriteBoundary = {
      execute: vi.fn()
        .mockResolvedValueOnce(committedSuccess(12n))
        .mockImplementationOnce(async (_target, observer) => {
          observer?.onSigned(hash);
          return {
            kind: "indeterminate",
            hash: null,
            reason: "timeout",
          } satisfies WriteResult;
        }),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(
      await screen.findByText(/last crank's outcome is uncertain/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toHaveTextContent(
      "Queue-processing outcome uncertain. Check the original transaction before trying again.",
    );
    expect(loadCrankAttempt(config)).toMatchObject({
      status: "indeterminate",
      transactionHash: hash,
    });
    expect(screen.getByLabelText("YOU PAY")).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Manual queue processing" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check crank status" }),
    ).toBeEnabled();
    expect(writer.execute).toHaveBeenCalledTimes(2);
  });

  it("does not process queued work on mount or mode changes", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
    const writer: WriteBoundary = { execute: vi.fn() };
    const view = renderApp(async () => pool(), writer);

    const toggle = await screen.findByRole("switch", {
      name: "Manual queue processing",
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(writer.execute).not.toHaveBeenCalled();

    view.unmount();
    renderApp(async () => pool(), writer);
    expect(
      await screen.findByRole("switch", { name: "Manual queue processing" }),
    ).not.toBeChecked();
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("reveals hidden queued work by enabling manual processing", async () => {
    const user = userEvent.setup();
    const queued = queuedRequest("queued-request", 0xcd);
    const executed: ReturnType<typeof queuedRequest> = {
      ...queuedRequest("executed-request", 0xce),
      status: "executed",
      execution: {
        kind: "executed",
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 10_000_000n,
        amountOut: 19_500_000n,
      },
    };
    saveRequestCollection(config, [queued, executed]);
    renderApp();

    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Queued work available" }),
    );

    expect(
      screen.getByRole("switch", { name: "Manual queue processing" }),
    ).toBeChecked();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Crank queue" })).toBeEnabled();
  });

  it("does not let the hidden-work shortcut bypass recovery locking", async () => {
    const queued = queuedRequest("queued-request", 0xcd);
    const recovering = createRequestRecord(
      {
        status: "indeterminate",
        phase: "swap",
        intent: { amountIn: 1_000_000n, amountOutMin: 1n },
        transactionHash: hash,
        receiptBlock: null,
        requestId: null,
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      },
      { localId: "recovering-request", now: 2 },
    );
    saveRequestCollection(config, [queued, recovering]);
    renderApp();

    expect(
      await screen.findByRole("button", { name: "Queued work available" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Manual queue processing" }),
    ).toBeDisabled();
  });

  it("processes the whole driver queue and reconciles matching receipt events", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [
      queuedRequest("first-request", 0xcd),
      queuedRequest("second-request", 0xce),
    ]);
    let write = 0;
    let resolveSecondCrank!: (result: WriteResult) => void;
    const secondCrank = new Promise<WriteResult>((resolve) => {
      resolveSecondCrank = resolve;
    });
    const writer: WriteBoundary = {
      execute: vi.fn(async (target, observer) => {
        write += 1;
        expect(target.invoked_address).toEqual(config.driverAddress);
        expect(target.gas_limit).toBe(10_000_000n);
        expect(loadCrankAttempt(config)).toMatchObject({
          status: "signing",
          transactionHash: null,
        });
        observer?.onSigned(hash);
        expect(loadCrankAttempt(config)?.transactionHash).toBe(hash);
        if (write === 2) return secondCrank;
        const result = committedSuccess(14n);
        result.receipt.events = [
          {
            contractAddress: config.driverAddress,
            topics: [
              RequestFailed.signature,
              new Uint8Array(32).fill(0xcd),
            ],
            data: new Uint8Array(),
          },
        ];
        return result;
      }),
    };
    renderApp(async () => pool(), writer);
    await enableManualProcessing();

    expect(
      await screen.findByText("Crank to process all requests in the queue."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Transaction queue" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/crank-local\.sh/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Crank queue" }));

    await waitFor(() => {
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "failed",
        "queued",
      ]);
      expect(loadCrankAttempt(config)?.status).toBe("committed");
    });
    expect(screen.getByText("Transaction queue")).toBeInTheDocument();
    expect(
      screen.getByText("Crank to process all requests in the queue."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crank queue" })).toBeEnabled();
    expect(writer.execute).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Crank queue" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Transaction status" }),
      ).toHaveTextContent("Processing transaction queue.")
    );
    await act(async () => {
      const result = committedSuccess(15n);
      result.receipt.events = [];
      resolveSecondCrank(result);
    });
    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(writer.execute).toHaveBeenCalledTimes(2);
  });

  it("disables manual queue processing during a pending submission", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
    let resolveWrite!: (result: WriteResult) => void;
    const pending = new Promise<WriteResult>((resolve) => {
      resolveWrite = resolve;
    });
    const snapshot = pool({
      tokenA: {
        ...pool().tokenA,
        balance: 100_000_000n,
        allowance: 11_000_000n,
      },
    });
    const writer: WriteBoundary = { execute: vi.fn().mockReturnValue(pending) };
    renderApp(async () => snapshot, writer);
    await enableManualProcessing();

    await user.type(await screen.findByLabelText("YOU PAY"), "1");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(
      await screen.findByRole("button", { name: "Submitting swap" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Crank queue" })).toBeDisabled();

    await act(async () => {
      resolveWrite({ kind: "invalid", hash, reason: "expired" });
    });
  });

  it("blocks manual submission while crank recovery is pending", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
    const snapshot = pool({
      tokenA: {
        ...pool().tokenA,
        balance: 100_000_000n,
        allowance: 11_000_000n,
      },
    });
    const writer: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn(),
    };
    renderApp(async () => snapshot, writer);
    await enableManualProcessing();
    await user.type(await screen.findByLabelText("YOU PAY"), "1");
    saveCrankAttempt(config, {
      ...createCrankAttempt(config),
      status: "indeterminate",
      transactionHash: hash,
      message: "The queue-processing outcome is uncertain.",
    });
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: crankAttemptKey(config),
      }));
    });
    expect(
      await screen.findByRole("button", { name: "Check crank status" }),
    ).toBeEnabled();
    expect(screen.getByLabelText("YOU PAY")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("preserves an uncertain crank and checks its original hash explicitly", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer): Promise<WriteResult> => {
        observer?.onSigned(hash);
        return { kind: "indeterminate", hash: null, reason: "timeout" };
      }),
      observe: vi.fn()
        .mockRejectedValueOnce(new Error("RPC unavailable"))
        .mockResolvedValue({
          ...committedSuccess(14n),
          receipt: { ...committedSuccess(14n).receipt, events: [] },
        }),
    };
    renderApp(async () => pool(), writer);
    await enableManualProcessing();

    await user.click(await screen.findByRole("button", { name: "Crank queue" }));
    expect(
      await screen.findByText(/last crank's outcome is uncertain/i),
    ).toBeInTheDocument();
    expect(loadCrankAttempt(config)).toMatchObject({
      status: "indeterminate",
      transactionHash: hash,
    });
    expect(screen.queryByRole("button", { name: "Crank queue" })).not.toBeInTheDocument();

    const [queued] = loadRequestCollection(config);
    saveRequestCollection(config, [{
      ...queued!,
      status: "failed",
      updatedAt: queued!.updatedAt + 1,
      execution: {
        kind: "failed",
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
      },
    }]);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: requestCollectionKey(config),
      }));
    });
    expect(await screen.findByRole("button", { name: "Check crank status" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check crank status" }));
    expect(
      await screen.findByText(/original crank remains blocked/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check crank status" }));
    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(loadRequestCollection(config)[0]?.status).toBe("failed");
    expect(screen.queryByRole("button", { name: "Crank queue" })).not.toBeInTheDocument();
    expect(screen.queryByText(/original crank remains blocked/i)).not.toBeInTheDocument();
    expect(writer.observe).toHaveBeenCalledTimes(2);
    expect(writer.observe).toHaveBeenCalledWith(hash);
  });

  it("serializes concurrent crank clicks and discards the stale second click", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
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
    let resolveCrank!: (result: WriteResult) => void;
    const pending = new Promise<WriteResult>((resolve) => {
      resolveCrank = resolve;
    });
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        observer?.onSigned(hash);
        return pending;
      }),
    };
    const first = render(
      <App config={config} readSnapshot={async () => pool()} writeBoundary={writer} />,
    );
    const second = render(
      <App config={config} readSnapshot={async () => pool()} writeBoundary={writer} />,
    );
    const firstView = within(first.container);
    const secondView = within(second.container);
    await enableManualProcessing(first.container);
    await enableManualProcessing(second.container);

    await user.click(await firstView.findByRole("button", { name: "Crank queue" }));
    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(1));
    await user.click(await secondView.findByRole("button", { name: "Crank queue" }));
    await act(async () => {
      const result = committedSuccess(14n);
      result.receipt.events = [];
      resolveCrank(result);
    });

    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    expect(writer.execute).toHaveBeenCalledTimes(1);
  });

  it("serializes a crank and swap submission across app instances", async () => {
    const user = userEvent.setup();
    saveRequestCollection(config, [queuedRequest("queued-request", 0xcd)]);
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
    let resolveCrank!: (result: WriteResult) => void;
    const pendingCrank = new Promise<WriteResult>((resolve) => {
      resolveCrank = resolve;
    });
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        write += 1;
        observer?.onSigned(hash);
        return write === 1
          ? pendingCrank
          : Promise.resolve(committedSuccess(15n, 0xce));
      }),
    };
    const approved = pool({
      chainHeight: 20n,
      tokenA: {
        ...pool().tokenA,
        balance: 100_000_000n,
        allowance: 100_000_000n,
      },
    });
    const first = render(
      <App config={config} readSnapshot={async () => approved} writeBoundary={writer} />,
    );
    const second = render(
      <App config={config} readSnapshot={async () => approved} writeBoundary={writer} />,
    );
    const firstView = within(first.container);
    const secondView = within(second.container);
    await enableManualProcessing(first.container);
    await enableManualProcessing(second.container);

    await user.click(await firstView.findByRole("button", { name: "Crank queue" }));
    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(1));
    await user.type(await secondView.findByLabelText("YOU PAY"), "1");
    await user.click(
      secondView.getByRole("button", { name: /^(?:Approve & swap|Swap)$/ }),
    );
    expect(writer.execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      const result = committedSuccess(14n);
      result.receipt.events = [];
      resolveCrank(result);
    });

    await waitFor(() => expect(loadCrankAttempt(config)?.status).toBe("committed"));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: crankAttemptKey(config),
      }));
    });
    const swap = secondView.getByRole("button", {
      name: /^(?:Approve & swap|Swap)$/,
    });
    await waitFor(() => expect(swap).toBeEnabled());
    await user.click(swap);

    await waitFor(() => {
      expect(vi.mocked(writer.execute).mock.calls.length).toBeGreaterThan(1);
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "queued",
        "queued",
      ]);
    });
  });

  it("enqueues two swaps with aggregate allowance and durable reservations", async () => {
    const user = userEvent.setup();
    let allowance = 10_000_000n;
    let write = 0;
    const readSnapshot = vi.fn(async () =>
      pool({
        tokenA: { ...pool().tokenA, balance: 100_000_000n, allowance },
        chainHeight: 20n,
      })
    );
    const writer: WriteBoundary = {
      execute: vi.fn(async () => {
        write += 1;
        if (write === 2) allowance = 15_000_000n;
        return committedSuccess(11n + BigInt(write), write === 3 ? 0xce : 0xcd);
      }),
    };
    renderApp(readSnapshot, writer);
    await enableManualProcessing();

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() => expect(loadRequestCollection(config)).toHaveLength(1));

    await user.type(screen.getByLabelText("YOU PAY"), "5");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));
    await waitFor(() => {
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "queued",
        "queued",
      ]);
      expect(writer.execute).toHaveBeenCalledTimes(3);
    });

    const queued = loadRequestCollection(config);
    expect(queued.map(({ intent }) => intent.amountIn)).toEqual([
      10_000_000n,
      5_000_000n,
    ]);
    expect(queued.every(({ snapshotInferenceEligible }) =>
      !snapshotInferenceEligible
    )).toBe(true);
  });

  it("does not enqueue when another tab fills the pending swap queue", async () => {
    const pending = Array.from({ length: 9 }, (_, index) =>
      queuedRequest(`queued-request-${index}`, index, "queuedUntracked")
    );
    saveRequestCollection(config, pending);
    const writer: WriteBoundary = { execute: vi.fn() };
    const user = userEvent.setup();
    renderApp(
      async () =>
        pool({
          tokenA: {
            ...pool().tokenA,
            balance: 200_000_000n,
            allowance: 200_000_000n,
          },
        }),
      writer,
    );

    await user.type(await screen.findByLabelText("YOU PAY"), "1");
    const swap = screen.getByRole("button", {
      name: /^(?:Approve & swap|Swap)$/,
    });
    expect(swap).toBeEnabled();

    saveRequestCollection(config, [
      ...pending,
      queuedRequest("queued-request-9", 9, "queuedUntracked"),
    ]);
    await user.click(swap);

    expect(
      await screen.findByRole("button", { name: "Swap queue is full" }),
    ).toBeDisabled();
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("reconciles an earlier execution while observing aggregate approval", async () => {
    const user = userEvent.setup();
    let allowance = 10_000_000n;
    let firstExecuted = false;
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn(async () => {
        write += 1;
        if (write === 2) {
          firstExecuted = true;
          allowance = 5_000_000n;
        }
        return committedSuccess(11n + BigInt(write), write === 3 ? 0xce : 0xcd);
      }),
    };
    const execution: RequestObservation = {
      kind: "executionObserved",
      requestId: `0x${"cd".repeat(32)}`,
      transactionHash: hash,
      blockHeight: 13n,
      amountIn: 10_000_000n,
      amountOut: 19_743_160n,
    };
    const requestObserver: RequestObserver = {
      scan: async () => firstExecuted ? execution : null,
      scanAll: async () => ({
        observations: firstExecuted ? [execution] : [],
        observedThroughBlock: 20n,
      }),
    };
    renderApp(
      async () =>
        pool({
          tokenA: { ...pool().tokenA, balance: 100_000_000n, allowance },
          chainHeight: 20n,
        }),
      writer,
      requestObserver,
    );
    await enableManualProcessing();

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() => expect(loadRequestCollection(config)).toHaveLength(1));
    await user.type(screen.getByLabelText("YOU PAY"), "5");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    await waitFor(() => {
      expect(writer.execute).toHaveBeenCalledTimes(3);
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "executed",
        "queued",
      ]);
    });
  });

  it("continues when an earlier request fails and leaves safe excess allowance", async () => {
    const user = userEvent.setup();
    let allowance = 10_000_000n;
    let firstFailed = false;
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn(async () => {
        write += 1;
        if (write === 2) {
          firstFailed = true;
          allowance = 15_000_000n;
        }
        return committedSuccess(11n + BigInt(write), write === 3 ? 0xce : 0xcd);
      }),
    };
    const failure: RequestObservation = {
      kind: "executionFailed",
      requestId: `0x${"cd".repeat(32)}`,
      transactionHash: hash,
      blockHeight: 13n,
    };
    const scan = vi.fn(async () => firstFailed ? failure : null);
    const requestObserver: RequestObserver = {
      scan,
      scanAll: async () => ({
        observations: firstFailed ? [failure] : [],
        observedThroughBlock: 20n,
      }),
    };
    renderApp(
      async () =>
        pool({
          tokenA: { ...pool().tokenA, balance: 100_000_000n, allowance },
          chainHeight: 20n,
        }),
      writer,
      requestObserver,
    );
    await enableManualProcessing();

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() => expect(loadRequestCollection(config)).toHaveLength(1));
    await user.type(screen.getByLabelText("YOU PAY"), "5");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    await waitFor(() => {
      expect(writer.execute).toHaveBeenCalledTimes(3);
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "failed",
        "queued",
      ]);
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("uses unreserved balances for validation and Max", async () => {
    const user = userEvent.setup();
    saveOutstandingRequest(config, {
      status: "queued",
      phase: "swap",
      intent: { amountIn: 90_000_000n, amountOutMin: 1n },
      transactionHash: hash,
      receiptBlock: 12n,
      requestId: `0x${"cd".repeat(32)}`,
      visibleObservationMs: 0,
      observationBaseline: null,
      criteria,
    });
    const writer: WriteBoundary = { execute: vi.fn() };
    renderApp(
      async () =>
        pool({
          tokenA: { ...pool().tokenA, balance: 100_000_000n },
        }),
      writer,
    );

    const input = await screen.findByLabelText("YOU PAY");
    await user.click(screen.getByRole("button", { name: "MAX" }));
    expect(input).toHaveValue("10");
    await user.clear(input);
    await user.type(input, "11");
    expect(screen.getByText("Amount exceeds your available balance.")).toBeInTheDocument();
    expect(writer.execute).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Switch direction to gEUR for gUSD" }),
    );
    await user.click(screen.getByRole("button", { name: "MAX" }));
    expect(screen.getByLabelText("YOU PAY")).toHaveValue("34");
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
      await screen.findByText("Execution pending"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toHaveTextContent("Swap queued, but its request ID is unavailable.");
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Resolve manually" }));
    expect(screen.getByText("Confirm the queue is drained")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("queuedUntracked");
    await user.click(
      screen.getByRole("button", { name: "Confirm queue is drained" }),
    );
    await waitFor(() => expect(loadOutstandingRequest(config)).toBeNull());
    expect(screen.getByRole("heading", { name: "Swap preview" })).toHaveFocus();
  });

  it("keeps an indeterminate submission non-resubmittable", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        observer?.onSigned(hash);
        return {
          kind: "indeterminate",
          hash: null,
          reason: "disconnect",
        } satisfies WriteResult;
      }),
    };
    renderApp(async () => approved, writer);

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(
      await screen.findByText("Transaction outcome uncertain"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Do not retry it automatically/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Transaction status" }),
    ).toHaveTextContent(
      "Transaction outcome uncertain. Do not retry automatically.",
    );
    expect(screen.getByRole("button", { name: "Outcome is uncertain" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check transaction status" }),
    ).toBeEnabled();
    expect(loadOutstandingRequest(config)?.transactionHash).toBe(hash);
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
    expect(
      screen.getByRole("switch", { name: "Manual queue processing" }),
    ).toBeDisabled();
    expect(loadOutstandingRequest(config)?.transactionHash).toBe(hash);
    await act(async () => resolveWrite?.({ kind: "invalid", hash, reason: "expired" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(
      screen.getByRole("switch", { name: "Manual queue processing" }),
    ).toBeEnabled();
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

  it("recovers an indeterminate approval without a reload", async () => {
    const user = userEvent.setup();
    let approvalCommitted = false;
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        observer?.onSigned(hash);
        return {
          kind: "indeterminate",
          hash: null,
          reason: "disconnect",
        } satisfies WriteResult;
      }),
      observe: vi.fn(async () => {
        approvalCommitted = true;
        return committedSuccess(12n);
      }),
    };
    renderApp(
      async () =>
        pool({
          tokenA: {
            ...pool().tokenA,
            allowance: approvalCommitted ? 10_000_000n : 0n,
          },
          chainHeight: 12n,
        }),
      writer,
    );

    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Approve & swap" }));

    await screen.findByText("Transaction outcome uncertain");
    expect(loadOutstandingRequest(config)).toMatchObject({
      status: "indeterminate",
      phase: "approval",
      transactionHash: hash,
    });
    expect(
      screen.getByRole("button", { name: "Check transaction status" }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole("button", { name: "Check transaction status" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled()
    );
    expect(loadOutstandingRequest(config)).toBeNull();
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
        hash: null,
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
    let approvalSubmitted = false;
    let resolveApproval!: (result: WriteResult) => void;
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        observer?.onSigned(hash);
        approvalSubmitted = true;
        return new Promise<WriteResult>((resolve) => {
          resolveApproval = resolve;
        });
      }),
    };
    const view = renderApp(
      async () =>
        pool({
          tokenA: {
            ...pool().tokenA,
            allowance: approvalSubmitted ? 10_000_000n : 0n,
          },
          chainHeight: 12n,
        }),
      writer,
    );
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

  it("does not crank after the workspace unmounts during router submission", async () => {
    const user = userEvent.setup();
    const approved = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
    });
    let resolveSubmission!: (result: WriteResult) => void;
    const writer: WriteBoundary = {
      execute: vi.fn((_target, observer) => {
        observer?.onSigned(hash);
        return new Promise<WriteResult>((resolve) => {
          resolveSubmission = resolve;
        });
      }),
    };
    const view = renderApp(async () => approved, writer);
    await user.type(await screen.findByLabelText("YOU PAY"), "10");
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() =>
      expect(loadOutstandingRequest(config)?.transactionHash).toBe(hash)
    );

    view.unmount();
    await act(async () => resolveSubmission(committedSuccess(12n)));

    expect(writer.execute).toHaveBeenCalledTimes(1);
    expect(loadOutstandingRequest(config)?.status).toBe("queued");
    expect(loadCrankAttempt(config)).toBeNull();
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
    const mode = screen.getByRole("switch", {
      name: "Manual queue processing",
    });
    expect(mode).toBeEnabled();
    await user.click(mode);
    await user.click(screen.getByRole("button", { name: "Dismiss from history" }));
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
    expect(screen.getByText("Execution pending")).toBeInTheDocument();
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();
  });

  it("renders mixed request history and dismisses only a terminal record", async () => {
    const user = userEvent.setup();
    const queued = createRequestRecord(
      {
        status: "queued",
        phase: "swap",
        intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
        transactionHash: hash,
        receiptBlock: 12n,
        requestId: `0x${"cd".repeat(32)}`,
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      },
      { localId: "queued-request", now: 1 },
    );
    const executed: ReturnType<typeof createRequestRecord> = {
      ...createRequestRecord(
        {
          status: "queued",
          phase: "swap",
          intent: { amountIn: 4_000_000n, amountOutMin: 1_900_000n },
          transactionHash: `0x${"bc".repeat(32)}`,
          receiptBlock: 13n,
          requestId: `0x${"ce".repeat(32)}`,
          visibleObservationMs: 0,
          observationBaseline: null,
          criteria: {
            ...criteria,
            tokenIn: criteria.tokenOut,
            tokenOut: criteria.tokenIn,
          },
        },
        { localId: "executed-request", now: 2 },
      ),
      status: "executed",
      execution: {
        kind: "executed",
        transactionHash: `0x${"ef".repeat(32)}`,
        blockHeight: 14n,
        amountIn: 4_000_000n,
        amountOut: 2_000_000n,
      },
    };
    saveRequestCollection(config, [queued, executed]);
    renderApp();
    await enableManualProcessing();

    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Queued for execution")).toBeInTheDocument();
    expect(screen.getByText("Executed")).toBeInTheDocument();
    expect(screen.getByText(/4 gEUR was exchanged for 2 gUSD/)).toBeInTheDocument();
    const executedItem = screen.getByRole("article", { name: "gEUR gUSD" });
    expect(
      within(executedItem).getByLabelText(
        `Execution transaction hash: 0x${"ef".repeat(32)}`,
      ),
    ).toHaveTextContent("0xefefef…efef");
    await user.click(
      within(executedItem).getByRole("button", { name: "Dismiss from history" }),
    );

    await waitFor(() =>
      expect(loadRequestCollection(config).map(({ localId }) => localId)).toEqual([
        "queued-request",
      ])
    );
    expect(screen.getByRole("heading", { name: "Requests" })).toHaveFocus();
    expect(screen.getByText("Transaction queue")).toBeInTheDocument();
    expect(screen.getByText("Queued for execution")).toBeInTheDocument();
  });

  it("announces every terminal result from one observation batch", async () => {
    const first = createRequestRecord(
      {
        status: "queued",
        phase: "swap",
        intent: { amountIn: 10_000_000n, amountOutMin: 19_000_000n },
        transactionHash: hash,
        receiptBlock: 12n,
        requestId: `0x${"cd".repeat(32)}`,
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      },
      { localId: "first-request", now: 1 },
    );
    const second = {
      ...first,
      localId: "second-request",
      requestId: `0x${"ce".repeat(32)}`,
      createdAt: 2,
      updatedAt: 2,
    };
    saveRequestCollection(config, [first, second]);
    const requestObserver: RequestObserver = {
      scan: async () => null,
      scanAll: async () => ({
        observations: [
          {
            kind: "executionObserved",
            requestId: first.requestId!,
            transactionHash: `0x${"ef".repeat(32)}`,
            blockHeight: 14n,
            amountIn: 10_000_000n,
            amountOut: 19_500_000n,
          },
          {
            kind: "executionFailed",
            requestId: second.requestId!,
            transactionHash: `0x${"ac".repeat(32)}`,
            blockHeight: 14n,
          },
        ],
        observedThroughBlock: 14n,
      }),
    };
    renderApp(async () => pool(), undefined, requestObserver);
    await enableManualProcessing();

    expect(await screen.findByText("Executed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Transaction status" }),
      ).toHaveTextContent(
        "2 request updates: 1 observed, 0 inferred, 1 failed.",
      )
    );
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

    expect(await screen.findByText("Executed")).toBeInTheDocument();
    expect(screen.getByText(/10 gUSD was exchanged for 19.5 gEUR/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Crank queue" }),
    ).not.toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("executed");
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

    expect(await screen.findByText("Execution pending")).toBeInTheDocument();
    expect(await screen.findByText(/request may still execute/i)).toBeInTheDocument();
    expect(screen.getByLabelText("YOU PAY")).toBeEnabled();
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

    expect(await screen.findByText("Executed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("executed");
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
    expect(screen.queryByText("Queued for execution")).not.toBeInTheDocument();
  });

  it("rejects stale snapshot inference after another tab adds exposure", async () => {
    const initial = pool({
      tokenA: { ...pool().tokenA, allowance: 10_000_000n },
      chainHeight: 7n,
    });
    const baseline = {
      chainHeight: 7n,
      inputBalance: initial.tokenA.balance,
      outputBalance: initial.tokenB.balance,
      inputAllowance: initial.tokenA.allowance,
      reserveIn: initial.reserve0,
      reserveOut: initial.reserve1,
    };
    const first = createRequestRecord(
      {
        status: "queued",
        phase: "swap",
        intent: { amountIn: 10_000_000n, amountOutMin: 18_000_000n },
        transactionHash: hash,
        receiptBlock: 8n,
        requestId: `0x${"cd".repeat(32)}`,
        visibleObservationMs: 0,
        observationBaseline: baseline,
        criteria,
      },
      { localId: "first-request", now: 1 },
    );
    saveRequestCollection(config, [first]);
    const executed = pool({
      tokenA: {
        ...initial.tokenA,
        balance: initial.tokenA.balance - 10_000_000n,
        allowance: 0n,
      },
      tokenB: {
        ...initial.tokenB,
        balance: initial.tokenB.balance + 19_000_000n,
      },
      reserve0: initial.reserve0 + 10_000_000n,
      reserve1: initial.reserve1 - 19_000_000n,
      chainHeight: 10n,
    });
    const readSnapshot = vi
      .fn<SnapshotReader>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(executed);
    let rejectScan!: (reason: Error) => void;
    const requestObserver: RequestObserver = {
      scan: vi.fn().mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
      ),
    };
    renderApp(readSnapshot, undefined, requestObserver);
    await enableManualProcessing();
    await waitFor(() => expect(requestObserver.scan).toHaveBeenCalledTimes(1));

    const second = {
      ...createRequestRecord(
        {
          status: "submitting",
          phase: "swap",
          intent: { amountIn: 1_000_000n, amountOutMin: 1n },
          transactionHash: null,
          receiptBlock: null,
          requestId: null,
          visibleObservationMs: 0,
          observationBaseline: baseline,
          criteria,
        },
        { localId: "second-request", now: 2 },
      ),
      snapshotInferenceEligible: false,
    };
    saveRequestCollection(config, [
      { ...first, snapshotInferenceEligible: false },
      second,
    ]);
    await act(async () => rejectScan(new Error("event history unavailable")));

    await waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    await waitFor(() =>
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "queued",
        "submitting",
      ])
    );
    expect(screen.queryByText("Executed")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Execution pending")).toBeInTheDocument();

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

    expect(await screen.findByText("Executed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("executed");
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

    expect(await screen.findByText("Executed")).toBeInTheDocument();
    expect(loadOutstandingRequest(config)?.status).toBe("executed");
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
      execute: vi.fn(async () => ({
        kind: "preSubmissionFailure",
        hash: null,
        message: "not used",
      } satisfies WriteResult)),
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

    expect(await screen.findByText("Execution pending")).toBeInTheDocument();
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
    expect(writer.execute).not.toHaveBeenCalled();
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
      screen.queryByText("Queued for execution"),
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
      secondView.getByRole("button", { name: "Approving swap" }),
    ).toBeDisabled();

    await act(async () => resolveWrite?.(committedSuccess(12n)));

    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(2));
    expect(loadOutstandingRequest(config)?.status).toBe("queued");
  });

  it("serializes and retains two valid cross-tab submissions", async () => {
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
    let allowance = 1_000_000n;
    let resolveFirst!: (result: WriteResult) => void;
    const firstWrite = new Promise<WriteResult>((resolve) => {
      resolveFirst = resolve;
    });
    let write = 0;
    const writer: WriteBoundary = {
      execute: vi.fn(async () => {
        write += 1;
        if (write === 1) return firstWrite;
        if (write === 2) allowance = 2_000_000n;
        return committedSuccess(11n + BigInt(write), write === 3 ? 0xce : 0xcd);
      }),
    };
    const readSnapshot = async () =>
      pool({
        tokenA: {
          ...pool().tokenA,
          balance: 100_000_000n,
          allowance,
        },
        chainHeight: 20n,
      });
    const requestObserver: RequestObserver = {
      scan: async () => null,
      scanAll: async () => ({
        observations: [],
        observedThroughBlock: 20n,
      }),
    };
    const first = render(
      <App
        config={config}
        readSnapshot={readSnapshot}
        requestObserver={requestObserver}
        writeBoundary={writer}
      />,
    );
    const second = render(
      <App
        config={config}
        readSnapshot={readSnapshot}
        requestObserver={requestObserver}
        writeBoundary={writer}
      />,
    );
    const firstView = within(first.container);
    const secondView = within(second.container);

    await user.type(await firstView.findByLabelText("YOU PAY"), "1");
    await user.type(await secondView.findByLabelText("YOU PAY"), "1");
    await user.click(firstView.getByRole("button", { name: "Swap" }));
    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(1));
    await user.click(secondView.getByRole("button", { name: "Swap" }));
    await act(async () => resolveFirst(committedSuccess(12n)));

    await waitFor(() => {
      expect(writer.execute).toHaveBeenCalledTimes(4);
      expect(loadRequestCollection(config).map(({ status }) => status)).toEqual([
        "queued",
        "queued",
      ]);
    });
    expect(vi.mocked(writer.execute).mock.calls.map(([target]) =>
      target.invoked_address
    )).toEqual([
      config.routerAddress,
      config.driverAddress,
      config.routerAddress,
      config.driverAddress,
    ]);
    expect(new Set(
      loadRequestCollection(config).map(({ requestId }) => requestId),
    ).size).toBe(2);
  });
});
