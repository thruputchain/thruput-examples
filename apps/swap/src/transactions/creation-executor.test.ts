import { contractAddress, ExecResult, sha256Hash } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, GlobalConfig } from "@/config";
import type { Erc20ReadAdapter } from "@/contracts/erc20-adapter";
import type { PoolAddresses, SwapFactoryReadAdapter } from "@/contracts/factory-adapter";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import { PoolCreated } from "@/contracts/generated/swap-factory";
import type { PoolCreationReview } from "@/pools/pool-creation";
import {
  confirmCreationStepWasNotSigned,
  continueSupersededCreation,
  runCreationWorkflow,
} from "./creation-executor";
import {
  createCreationWorkflow,
  hasBlockingCreationTransaction,
  loadCreationWorkflow,
  saveCreationWorkflow,
} from "./creation-workflow";
import { createCrankAttempt, saveCrankAttempt } from "./crank-attempt";
import type { WriteBoundary, WriteResult } from "./write-boundary";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const view = <T>(value: T) => ({ value, height: 7n, events: [] });
const pool: PoolAddresses = {
  liquidityToken: address(21),
  handler: address(22),
  driver: address(23),
};
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  knownTokenAddresses: [],
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
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));

    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies(state),
      writeBoundary: { execute },
      automaticProcessing: false,
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("queued");
    expect(result.pool).toEqual({
      liquidityToken: hex(21),
      handler: hex(22),
      driver: hex(23),
    });
    expect(result.requestId).toBe(hex(60));
    expect(result.steps.approveFunding.status).toBe("committed");
    expect(result.steps.createPool.status).toBe("committed");
    expect(result.steps.approveToken0.status).toBe("skipped");
    expect(result.steps.approveToken1.status).toBe("skipped");
    expect(result.steps.crank.status).toBe("pending");
  });

  it("preserves an indeterminate funding approval hash for observation", async () => {
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    const writer: WriteBoundary = {
      execute: vi.fn(async (_target, observer) => {
        observer?.onSigned(hex(40));
        return {
          kind: "indeterminate",
          hash: hex(40),
          reason: "timeout",
        } satisfies WriteResult;
      }),
      observe: vi.fn(async () => ({
        kind: "invalid",
        hash: hex(40),
        reason: "expired",
      } satisfies WriteResult)),
    };

    const blocked = await runCreationWorkflow(config, workflow, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    });
    expect(blocked.steps.approveFunding).toMatchObject({
      status: "indeterminate",
      transactionHash: hex(40),
    });
    expect(hasBlockingCreationTransaction(blocked)).toBe(true);

    const recovered = await runCreationWorkflow(config, blocked, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: writer,
    });
    expect(writer.observe).toHaveBeenCalledWith(hex(40));
    expect(recovered.steps.approveFunding.status).toBe("failed");
  });

  it("requires explicit confirmation before retrying a pre-hash step", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.steps.approveFunding.status = "signing";
    saveCreationWorkflow(config, workflow);

    const reset = confirmCreationStepWasNotSigned(config, workflow, "approveFunding");
    expect(reset.steps.approveFunding.status).toBe("pending");
    expect(loadCreationWorkflow(config, hex(1), hex(2))).toEqual(reset);
  });

  it("blocks creation while any account crank is unresolved", async () => {
    saveCrankAttempt(poolConfig, {
      ...createCrankAttempt(poolConfig),
      status: "indeterminate",
      transactionHash: hex(40),
    });
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    const execute = vi.fn();

    await expect(runCreationWorkflow(config, workflow, {
      ...dependencies({ created: false, fundingAllowance: 0n }),
      writeBoundary: { execute },
    })).rejects.toThrow("queue-processing transaction");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records a race without submitting when the pool already exists", async () => {
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));
    const execute = vi.fn();
    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies({ created: true, fundingAllowance: 0n }),
      writeBoundary: { execute },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("race");
    expect(result.pool?.handler).toBe(hex(22));
  });

  it("skips an unsubmitted funding approval when continuing an early race", () => {
    const workflow = createCreationWorkflow(config, review(), 10);
    workflow.status = "race";
    workflow.pool = {
      liquidityToken: hex(21),
      handler: hex(22),
      driver: hex(23),
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
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));

    const result = await runCreationWorkflow(config, workflow, {
      ...dependencies(state),
      writeBoundary: { execute },
      automaticProcessing: false,
    });

    expect(result.pool?.handler).toBe(hex(22));
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
    const workflow = saveCreationWorkflow(config, createCreationWorkflow(config, review(), 10));

    const result = await runCreationWorkflow(config, workflow, {
      ...deps,
      writeBoundary: { execute },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.steps.approveFunding.status).toBe("committed");
    expect(result.steps.createPool.status).toBe("failed");
  });
});

function dependencies(state: { created: boolean; fundingAllowance: bigint }): {
  factory: SwapFactoryReadAdapter;
  token: (token: ReturnType<typeof address>) => Erc20ReadAdapter;
} {
  return {
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
      allowance: async () => view(token[0] === 6 ? state.fundingAllowance : 20_000n),
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
    addressHex: hex(byte),
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
  events: Array<{ contractAddress: ReturnType<typeof address>; topics: Uint8Array[]; data: Uint8Array }> = [],
): Extract<WriteResult, { kind: "committedSuccess" }> {
  return {
    kind: "committedSuccess",
    hash: hex(41),
    receipt: {
      txHash: sha256Hash(new Uint8Array(32).fill(41)),
      height,
      execResult: ExecResult.ExecResultOK,
      events,
      returnData: new Uint8Array(),
      abortData: null,
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
    contractAddress: config.factoryAddress,
    topics: [PoolCreated.signature, address(1), address(2)],
    data: writer.finish(),
  };
}

function acceptedEvent(requestId: Uint8Array) {
  return {
    contractAddress: pool.driver,
    topics: [RequestAccepted.signature, requestId],
    data: new Uint8Array(),
  };
}
