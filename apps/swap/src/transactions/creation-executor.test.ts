import { toBase58 } from "@thruputchain/client";
import { contractAddress, sha256Hash } from "@thruputchain/protocol";
import { CxsWriter } from "@thruputchain/xdr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import type { Erc20ReadAdapter } from "@/contracts/erc20-adapter";
import type {
  PoolAddresses,
  SwapFactoryReadAdapter,
} from "@/contracts/factory-adapter";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { swap_if } from "@/contracts/generated/swap-factory";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  confirmCreationStepWasNotSigned,
  continueSupersededCreation,
  runCreationWorkflow,
  type CreationExecutorDependencies,
} from "./creation-executor";
import {
  createCreationWorkflow,
  hasBlockingCreationTransaction,
  loadCreationWorkflow,
  saveCreationWorkflow,
} from "./creation-workflow";
import { createCrankAttempt, saveCrankAttempt } from "./crank-attempt";
import type { WriteBoundary, WriteResult } from "./write-boundary";

const RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
type RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
const PoolCreated = swap_if.v0_1.events.PoolCreated;
type PoolCreated = swap_if.v0_1.events.PoolCreated;

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) =>
  `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const view = <T>(value: T) => ({
  value,
  stateBlockHeight: 100n,
  gasUsed: 0n,
  events: [],
});
const pool: PoolAddresses = {
  liquidityToken: address(21),
  handler: address(22),
  driver: address(23),
};
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
} satisfies GlobalConfig;
const poolConfig = {
  ...config,
  liquidityTokenAddress: pool.liquidityToken,
  handlerAddress: pool.handler,
  driverAddress: pool.driver,
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "T1",
  tokenBSymbol: "T2",
  tokenADecimals: 0,
  tokenBDecimals: 0,
} satisfies AppConfig;

describe("creation executor", () => {
  beforeEach(() => window.localStorage.clear());

  it.each([2, 3, 4, 5])(
    "negotiates the actual %s-call creation batch",
    async (count) => {
      const state = {
        created: false,
        fundingAllowance: count === 2 ? 300n : 0n,
      };
      const deps = dependencies(state);
      const token = deps.token;
      deps.token = (address) => ({
        ...token(address),
        allowance: async () =>
          view(
            address[0] === 6
              ? state.fundingAllowance
              : (address[0] === 1 && count >= 4) ||
                  (address[0] === 2 && count === 5)
                ? 0n
                : 20_000n,
          ),
      });
      const workflow = saveCreationWorkflow(
        config,
        createCreationWorkflow(config, review(), 10),
      );
      const writer = {
        supportsBatch: vi.fn(async (actual: number) => actual <= count),
        execute: vi.fn(),
        executeBatch: vi
          .fn()
          .mockResolvedValue({
            kind: "preSubmissionFailure",
            hash: null,
            message: "Rejected",
          }),
      };
      const result = await runCreationWorkflow(config, workflow, {
        ...deps,
        writeBoundary: writer,
      });
      expect(writer.supportsBatch.mock.calls).toEqual([[2], [count]]);
      expect(writer.executeBatch).toHaveBeenCalledOnce();
      expect(writer.executeBatch.mock.calls[0]![0]).toHaveLength(count);
      expect(result.executionMode).toBe("batch");
      expect(writer.execute).not.toHaveBeenCalled();
    },
  );

  it("uses individual calls when the constructed batch exceeds the wallet limit", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const writer = {
      supportsBatch: vi.fn(async (count: number) => count <= 2),
      execute: vi
        .fn()
        .mockResolvedValue({
          kind: "preSubmissionFailure",
          hash: null,
          message: "Rejected",
        }),
      executeBatch: vi.fn(),
    };
    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    });
    expect(writer.supportsBatch.mock.calls).toEqual([[2], [3]]);
    expect(writer.executeBatch).not.toHaveBeenCalled();
    expect(writer.execute).toHaveBeenCalledOnce();
    expect(result.executionMode).toBe("single");
    expect(result.batchSteps).toBeUndefined();
  });

  it("does not fall back or persist a batch when capability detection fails", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const writer = {
      supportsBatch: vi
        .fn()
        .mockRejectedValue(new Error("Capabilities unavailable")),
      execute: vi.fn(),
      executeBatch: vi.fn(),
    };
    await expect(
      runCreationWorkflow(config, workflow, {
        ...dependencies({ created: false, fundingAllowance: 0n }),
        writeBoundary: writer,
      }),
    ).rejects.toThrow("Capabilities unavailable");
    expect(writer.execute).not.toHaveBeenCalled();
    expect(writer.executeBatch).not.toHaveBeenCalled();
    expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(workflow);
  });

  it.each([
    ["unavailable", 0],
    ["stale", 0],
    ["unavailable", 1],
    ["stale", 1],
  ] as const)(
    "skips %s batch-only prediction when the wallet limit is %s",
    async (prediction, limit) => {
      const state = { created: false, fundingAllowance: 0n };
      const deps = dependencies(state);
      const predictionStates: boolean[] = [];
      deps.factory.poolAddresses = vi.fn(async () => {
        predictionStates.push(state.created);
        if (!state.created && prediction === "unavailable")
          throw new Error("Prediction unavailable");
        return { ...view(pool), height: state.created ? 100n : 0n };
      });
      const execute = vi.fn(async () => {
        if (execute.mock.calls.length === 1) {
          state.fundingAllowance = 300n;
          return committed(7n);
        }
        if (execute.mock.calls.length === 2) {
          state.created = true;
          return committed(7n, [poolCreatedEvent()]);
        }
        return committed(7n, [acceptedEvent(new Uint8Array(32).fill(60))]);
      });
      const writer = {
        supportsBatch: vi.fn(async (count: number) => count <= limit),
        execute,
        executeBatch: vi.fn(),
      };
      const workflow = saveCreationWorkflow(
        config,
        createCreationWorkflow(config, review(), 10),
      );
      const result = await runCreationWorkflow(config, workflow, {
        ...deps,
        writeBoundary: writer,
        automaticProcessing: false,
      });
      expect(result.executionMode).toBe("single");
      expect(result.status).toBe("queued");
      expect(writer.supportsBatch).toHaveBeenCalledExactlyOnceWith(2);
      expect(writer.executeBatch).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(3);
      expect(predictionStates.length).toBeGreaterThan(0);
      expect(predictionStates.every(Boolean)).toBe(true);
    },
  );

  it("recovers one creation batch hash and applies all steps together", async () => {
    const state = { created: false, fundingAllowance: 0n };
    const deps = dependencies(state);
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const result = committed(7n, [
      poolCreatedEvent(),
      acceptedEvent(new Uint8Array(32).fill(60)),
    ]);
    const poolReturn = new CxsWriter();
    poolReturn.writeFixedOpaque(pool.liquidityToken, 32);
    poolReturn.writeFixedOpaque(pool.handler, 32);
    poolReturn.writeFixedOpaque(pool.driver, 32);
    const returns = new CxsWriter();
    returns.writeUint32(3n);
    for (const bytes of [
      new Uint8Array(),
      poolReturn.finish(),
      new Uint8Array(32).fill(60),
    ])
      returns.writeVarOpaque(bytes, 0xffff_ffff);
    result.receipt.execution = {
      result: "return",
      returnData: returns.finish(),
    };
    const writer: WriteBoundary = {
      supportsBatch: vi.fn().mockResolvedValue(true),
      execute: vi.fn(),
      executeBatch: vi.fn<NonNullable<WriteBoundary["executeBatch"]>>(
        async (calls, observer) => {
          expect(calls).toHaveLength(3);
          await observer?.onSigned(result.hash);
          const stored = loadCreationWorkflow(config, id(1), id(2))!;
          expect(stored.steps.createPool.transactionHash).toBe(result.hash);
          expect(stored.steps.enqueue.transactionHash).toBe(result.hash);
          state.created = true;
          return {
            kind: "indeterminate",
            hash: result.hash,
            reason: "timeout",
          };
        },
      ),
      observe: vi.fn().mockResolvedValue(result),
    };
    const options = {
      ...deps,
      writeBoundary: writer,
      automaticProcessing: false,
    };
    const pending = await runCreationWorkflow(config, workflow, options);
    expect(pending.steps.createPool.status).toBe("indeterminate");
    vi.mocked(writer.supportsBatch!).mockRejectedValue(
      new Error("Saved batches must not renegotiate"),
    );
    const recovered = await runCreationWorkflow(config, pending, options);
    expect(recovered.status).toBe("queued");
    expect(recovered.requestId).toBe(hex(60));
    for (const name of recovered.batchSteps!) {
      expect(recovered.steps[name]).toMatchObject({
        status: "committed",
        transactionHash: result.hash,
      });
    }
    expect(recovered.steps.approveToken0.status).toBe("skipped");
    expect(writer.execute).not.toHaveBeenCalled();
    expect(writer.executeBatch).toHaveBeenCalledOnce();
    expect(writer.observe).toHaveBeenCalledExactlyOnceWith(result.hash);
  });

  it("keeps a rejected creation batch retryable without individual calls", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const writer = {
      supportsBatch: vi.fn().mockResolvedValue(true),
      execute: vi.fn(),
      executeBatch: vi
        .fn()
        .mockResolvedValue({
          kind: "preSubmissionFailure",
          hash: null,
          message: "Rejected",
        }),
    };
    const options = {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    };
    const rejected = await runCreationWorkflow(config, workflow, options);
    expect(rejected.executionMode).toBe("batch");
    expect(rejected.steps.createPool.status).toBe("pending");
    expect(rejected.steps.enqueue.status).toBe("pending");
    await runCreationWorkflow(config, rejected, options);
    expect(writer.executeBatch).toHaveBeenCalledTimes(2);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("approves factory funding, creates one atomic pool, and durably enqueues liquidity", async () => {
    const state = { created: false, fundingAllowance: 0n };
    const requestId = new Uint8Array(32).fill(60);
    const execute = vi.fn(async () => {
      const call = execute.mock.calls.length;
      if (call === 1) {
        state.fundingAllowance = 300n;
        return committed(11n);
      }
      if (call === 2) {
        state.created = true;
        return committed(12n, [poolCreatedEvent()]);
      }
      return committed(13n, [acceptedEvent(requestId)]);
    });
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );

    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies(state),
      writeBoundary: { execute },
      automaticProcessing: false,
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("queued");
    expect(result.pool).toEqual({
      liquidityToken: id(21),
      handler: id(22),
      driver: id(23),
    });
    expect(result.requestId).toBe(hex(60));
    expect(result.steps.approveFunding.status).toBe("committed");
    expect(result.steps.createPool.status).toBe("committed");
    expect(result.steps.approveToken0.status).toBe("skipped");
    expect(result.steps.approveToken1.status).toBe("skipped");
    expect(result.steps.crank.status).toBe("pending");
  });

  it("preserves an indeterminate funding approval hash for observation", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        observer?.onSigned(id(40));
        return {
          kind: "indeterminate",
          hash: id(40),
          reason: "timeout",
        } satisfies WriteResult;
      }),
      observe: vi.fn(
        async () =>
          ({
            kind: "invalid",
            hash: id(40),
            reason: "expired",
          }) satisfies WriteResult,
      ),
    };

    const blocked = await runCreationWorkflow(config, workflow, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    });
    expect(blocked.steps.approveFunding).toMatchObject({
      status: "indeterminate",
      transactionHash: id(40),
    });
    expect(hasBlockingCreationTransaction(blocked)).toBe(true);

    const recovered = await runCreationWorkflow(config, blocked, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    });
    expect(writer.observe).toHaveBeenCalledWith(id(40));
    expect(recovered.steps.approveFunding.status).toBe("failed");
  });

  it("requires explicit confirmation before retrying a pre-hash step", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.approveFunding.status = "signing";
    saveCreationWorkflow(config, workflow);

    const reset = confirmCreationStepWasNotSigned(
      config,
      workflow,
      "approveFunding",
    );
    expect(reset.steps.approveFunding.status).toBe("pending");
    expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(reset);
  });

  it.each(["amount", "funding"])(
    "rejects a changed persisted %s intent before signing",
    async (intent) => {
      const workflow = createCreationWorkflow(config, review());
      const saved = structuredClone(workflow);
      if (intent === "amount") saved.token0.amount = "9000";
      else {
        saved.fundingPerContract = "200";
        saved.totalFunding = "600";
      }
      saveCreationWorkflow(config, saved);
      const execute = vi.fn();
      await expect(
        runCreationWorkflow(config, workflow, {
          ...dependencies({ created: false, fundingAllowance: 0n }),
          writeBoundary: { execute },
        }),
      ).rejects.toThrow("saved creation intent changed");
      expect(execute).not.toHaveBeenCalled();
      expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(saved);
    },
  );

  it.each(["observation", "crank", "crankAfterScan", "funded"])(
    "preserves %s recovery on a network mismatch",
    async (phase) => {
      const workflow = createCreationWorkflow(config, review());
      if (phase === "observation") {
        workflow.steps.approveFunding.status = "indeterminate";
        workflow.steps.approveFunding.transactionHash = id(40);
      } else if (phase === "funded") {
        workflow.steps.approveFunding = {
          ...workflow.steps.approveFunding,
          status: "committed",
          transactionHash: id(40),
          receiptBlock: "7",
        };
      } else {
        workflow.pool = {
          liquidityToken: id(21),
          handler: id(22),
          driver: id(23),
        };
        workflow.status = "queued";
        workflow.requestId = hex(60);
        workflow.enqueueReceiptBlock = "7";
        for (const name of [
          "approveFunding",
          "createPool",
          "approveToken0",
          "approveToken1",
          "enqueue",
        ] as const) {
          workflow.steps[name] = {
            ...workflow.steps[name],
            status: "committed",
            transactionHash: id(40),
            receiptBlock: "7",
          };
        }
      }
      saveCreationWorkflow(config, workflow);
      const deps = dependencies({
        created: phase === "crank",
        fundingAllowance: 300n,
      });
      vi.mocked(deps.client.getNetworkInfo).mockResolvedValue({
        networkHash: new Uint8Array(32).fill(1),
      } as never);
      if (phase === "crankAfterScan") {
        vi.mocked(deps.client.getNetworkInfo)
          .mockResolvedValueOnce({ networkHash: new Uint8Array(32) } as never)
          .mockResolvedValueOnce({ networkHash: new Uint8Array(32) } as never);
      }
      const execute = vi.fn();
      const observe = vi.fn();
      const observeQueued = vi.fn(async () => workflow);
      await expect(
        runCreationWorkflow(config, workflow, {
          ...deps,
          writeBoundary: { execute, observe },
          observeQueued,
        }),
      ).rejects.toThrow("different Thruput network");
      expect(execute).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(observeQueued).toHaveBeenCalledTimes(
        phase === "crankAfterScan" ? 1 : 0,
      );
      expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(workflow);
    },
  );

  it("blocks creation while any account crank is unresolved", async () => {
    saveCrankAttempt(poolConfig, {
      ...createCrankAttempt(poolConfig),
      status: "indeterminate",
      transactionHash: id(40),
    });
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const execute = vi.fn();

    await expect(
      runCreationWorkflow(config, workflow, {
        ...dependencies({ created: false, fundingAllowance: 0n }),
        writeBoundary: { execute },
      }),
    ).rejects.toThrow("queue-processing transaction");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "fetch", "timeout", "abort", "malformed"])(
    "preserves funded recovery after %s network verification failure and retries successfully",
    async (failure) => {
      const workflow = createCreationWorkflow(config, review(), 10);
      workflow.steps.approveFunding = {
        ...workflow.steps.approveFunding,
        status: "committed",
        transactionHash: id(40),
        receiptBlock: "7",
      };
      saveCreationWorkflow(config, workflow);
      const state = { created: false, fundingAllowance: 300n };
      const deps = dependencies(state);
      vi.mocked(deps.client.getNetworkInfo).mockImplementationOnce(async () => {
        if (failure === "fetch") throw new TypeError("fetch failed");
        if (failure === "timeout")
          throw new DOMException("Network request timed out", "TimeoutError");
        if (failure === "abort")
          throw new DOMException("The operation was aborted", "AbortError");
        if (failure === "malformed") return {} as never;
        return { networkHash: new Uint8Array(32).fill(1) } as never;
      });
      const execute = vi.fn(async () => {
        if (!state.created) {
          state.created = true;
          return committed(12n, [poolCreatedEvent()]);
        }
        return committed(13n, [acceptedEvent(new Uint8Array(32).fill(60))]);
      });
      const onUpdate = vi.fn();
      const options = {
        ...deps,
        writeBoundary: { execute },
        onUpdate,
        automaticProcessing: false,
      };

      await expect(
        runCreationWorkflow(config, workflow, options),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(deps.factory.poolFunding).not.toHaveBeenCalled();
      expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(workflow);

      const recovered = await runCreationWorkflow(config, workflow, options);
      expect(recovered.status).toBe("queued");
      expect(recovered.steps.approveFunding).toEqual(
        workflow.steps.approveFunding,
      );
      expect(recovered.steps.createPool.status).toBe("committed");
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    new TypeError("fetch failed"),
    new DOMException("Network request timed out", "TimeoutError"),
    new DOMException("The operation was aborted", "AbortError"),
  ])(
    "preserves funded recovery when network verification rejects with %s",
    async (failure) => {
      const workflow = createCreationWorkflow(config, review(), 10);
      workflow.steps.approveFunding = {
        ...workflow.steps.approveFunding,
        status: "committed",
        transactionHash: id(40),
        receiptBlock: "7",
      };
      saveCreationWorkflow(config, workflow);
      const deps = dependencies({ created: false, fundingAllowance: 300n });
      const connect = vi
        .spyOn(deps.client, "getNetworkInfo")
        .mockRejectedValueOnce(failure);
      const execute = vi.fn();
      try {
        await expect(
          runCreationWorkflow(config, workflow, {
            ...deps,
            writeBoundary: { execute },
          }),
        ).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
        expect(loadCreationWorkflow(config, id(1), id(2))).toEqual(workflow);
      } finally {
        connect.mockRestore();
      }
    },
  );

  it("records a race without submitting when the pool already exists", async () => {
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );
    const execute = vi.fn();
    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies({ created: true, fundingAllowance: 0n }),
      writeBoundary: { execute },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("race");
    expect(result.pool?.handler).toBe(id(22));
  });

  it("skips an unsubmitted funding approval when continuing an early race", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.status = "race";
    workflow.pool = {
      liquidityToken: id(21),
      handler: id(22),
      driver: id(23),
    };
    workflow.steps.approveFunding.status = "failed";
    workflow.steps.approveFunding.message = "Pool already exists";
    saveCreationWorkflow(config, workflow);

    const continued = continueSupersededCreation(config, workflow);
    expect(continued.steps.approveFunding.status).toBe("skipped");
    expect(continued.steps.createPool.status).toBe("skipped");
  });

  it("resolves factory state when a committed creation receipt has no event", async () => {
    const state = { created: false, fundingAllowance: 300n };
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        state.created = true;
        return committed(11n);
      }
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "stop after creation",
      } satisfies WriteResult;
    });
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );

    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies(state),
      writeBoundary: { execute },
      automaticProcessing: false,
    });

    expect(result.pool?.handler).toBe(id(22));
    expect(result.steps.createPool.status).toBe("committed");
    expect(result.steps.enqueue.status).toBe("failed");
  });

  it("makes a committed funding approval cleanable when revalidation fails", async () => {
    const state = { created: false, fundingAllowance: 0n };
    const deps = dependencies(state);
    vi.mocked(deps.factory.poolFunding)
      .mockResolvedValueOnce(view({ min: 50n, recommended: 100n }))
      .mockResolvedValueOnce(view({ min: 101n, recommended: 100n }));
    const execute = vi.fn(async () => {
      state.fundingAllowance = 300n;
      return committed(11n);
    });
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review(), 10),
    );

    const result = await runCreationWorkflow(config, workflow, {
      ...deps,
      writeBoundary: { execute },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.steps.approveFunding.status).toBe("committed");
    expect(result.steps.createPool.status).toBe("failed");
  });

  it("does not reclassify contract-read errors as network verification failures", async () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.approveFunding = {
      ...workflow.steps.approveFunding,
      status: "committed",
      transactionHash: id(40),
      receiptBlock: "7",
    };
    saveCreationWorkflow(config, workflow);
    const deps = dependencies({ created: false, fundingAllowance: 300n });
    vi.mocked(deps.factory.poolFunding).mockRejectedValue(
      new TypeError("Invalid factory response"),
    );
    const execute = vi.fn();

    const result = await runCreationWorkflow(config, workflow, {
      ...deps,
      writeBoundary: { execute },
    });
    expect(result.status).toBe("failed");
    expect(result.steps.createPool).toMatchObject({
      status: "failed",
      message: "Invalid factory response",
    });
    expect(result.steps.approveFunding).toEqual(workflow.steps.approveFunding);
    expect(execute).not.toHaveBeenCalled();
  });
});

function dependencies(state: { created: boolean; fundingAllowance: bigint }): {
  client: CreationExecutorDependencies["client"];
  factory: SwapFactoryReadAdapter;
  token: (token: ReturnType<typeof address>) => Erc20ReadAdapter;
} {
  return {
    client: {
      simulateInvocation: vi.fn(),
      getEvents: vi.fn(),
      getNetworkInfo: vi
        .fn()
        .mockResolvedValue({ networkHash: new Uint8Array(32) }),
    },
    factory: {
      allPairsLength: async () => view(0n),
      pairAt: async () => view(null),
      getPair: async () => view(state.created ? pool.handler : null),
      poolAddresses: async () => view(pool),
      poolFunding: vi.fn(async () => view({ min: 50n, recommended: 100n })),
      feeTo: async () => view(null),
    },
    token: (token) => ({
      balanceOf: async () => view(token[0] === 6 ? 10_000n : 20_000n),
      allowance: async () =>
        view(token[0] === 6 ? state.fundingAllowance : 20_000n),
      metadata: async () => ({
        name: view(`Token ${token[0]}`),
        symbol: view(`T${token[0]}`),
        decimals: view(token[0] === 6 ? null : 3),
      }),
    }),
  };
}

function review(): PoolCreationReview {
  const token = (byte: number, amount: bigint) => ({
    address: address(byte),
    addressBase58: id(byte),
    name: `Token ${byte}`,
    symbol: `T${byte}`,
    decimals: 3,
    balance: 20_000n,
    allowance: 0n,
    amount,
    approvalDifference: amount,
  });
  return {
    token0: token(1, 2_000n),
    token1: token(2, 3_000n),
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

function committed(
  height: bigint,
  events: Array<{
    address: ReturnType<typeof address>;
    topics: Uint8Array[];
    data: Uint8Array;
  }> = [],
): Extract<WriteResult, { kind: "committedSuccess" }> {
  return {
    kind: "committedSuccess",
    hash: id(41),
    receipt: {
      transactionHash: sha256Hash(new Uint8Array(32).fill(41)),
      blockHeight: height,
      execution: { result: "return" as const, returnData: new Uint8Array() },
      gasUsed: 0n,
      events,
    },
  };
}

function poolCreatedEvent() {
  const writer = new CxsWriter();
  writer.writeFixedOpaque(pool.liquidityToken, 32);
  writer.writeFixedOpaque(pool.handler, 32);
  writer.writeFixedOpaque(pool.driver, 32);
  writer.writeUint32(1n);
  return {
    address: config.factoryAddress,
    topics: [PoolCreated.signature, address(1), address(2)],
    data: writer.finish(),
  };
}

function acceptedEvent(requestId: Uint8Array) {
  return {
    address: pool.driver,
    topics: [RequestAccepted.signature, requestId],
    data: new Uint8Array(),
  };
}
