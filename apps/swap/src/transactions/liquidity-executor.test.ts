import {
  contractAddress,
  ExecResult,
  sha256Hash,
} from "@groundhogchain/protocol";
import { CxsWriter, FixedArrayCodec, Uint128Codec } from "@groundhogchain/xdr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { swap_if } from "@/contracts/generated/swap-handler";
import type { PoolSnapshot } from "@/swap/snapshot";
import { createCrankAttempt, saveCrankAttempt } from "./crank-attempt";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
  loadLiquidityOperations,
  saveLiquidityOperations,
} from "./liquidity-operation";
import {
  applyLiquidityReceipt,
  runLiquidityOperation,
} from "./liquidity-executor";
import type { WriteBoundary, WriteResult } from "./write-boundary";

const RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
type RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
const BurnEvent = swap_if.v0_1.events.LiquidityBurnEvent;
type BurnEvent = swap_if.v0_1.events.LiquidityBurnEvent;
const MintEvent = swap_if.v0_1.events.LiquidityMintEvent;
type MintEvent = swap_if.v0_1.events.LiquidityMintEvent;

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  liquidityTokenAddress: address(11),
  handlerAddress: address(12),
  driverAddress: address(13),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("liquidity executor", () => {
  beforeEach(() => window.localStorage.clear());

  it.each([
    ["add", 1], ["add", 2], ["add", 3], ["remove", 1], ["remove", 2],
  ] as const)("negotiates the actual %s liquidity batch of %s calls", async (kind, count) => {
    const operation = kind === "add" ? createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n], amountsMin: [9n, 18n], estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n, reservesBefore: [100n, 200n],
    }) : createRemoveLiquidityOperation(config, { liquidity: 1n, amountsMin: [1n, 1n] });
    saveLiquidityOperations(config, [operation]);
    const read = snapshot();
    if (count >= 2) { read.tokenA.allowance = 0n; read.liquidityAllowance = 0n; }
    if (count === 3) read.tokenB.allowance = 0n;
    const writer = {
      supportsBatch: vi.fn(async (actual: number) => actual <= count), execute: vi.fn(),
      executeBatch: vi.fn().mockResolvedValue({ kind: "preSubmissionFailure", hash: null, message: "Rejected" }),
    };
    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: writer, readSnapshot: async () => read, automaticProcessing: false,
    });
    expect(writer.supportsBatch.mock.calls).toEqual([[1], [count]]);
    expect(writer.executeBatch).toHaveBeenCalledOnce();
    expect(writer.executeBatch.mock.calls[0]![0]).toHaveLength(count);
    expect(result.executionMode).toBe("batch");
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("falls back before signing when the actual liquidity batch is too large", async () => {
    const operation = createRemoveLiquidityOperation(config, { liquidity: 1n, amountsMin: [1n, 1n] });
    saveLiquidityOperations(config, [operation]);
    const writer = {
      supportsBatch: vi.fn(async (count: number) => count <= 1),
      execute: vi.fn().mockResolvedValue({ kind: "preSubmissionFailure", hash: null, message: "Rejected" }),
      executeBatch: vi.fn(),
    };
    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: writer, readSnapshot: async () => snapshot({ liquidityAllowance: 0n }),
    });
    expect(writer.supportsBatch.mock.calls).toEqual([[1], [2]]);
    expect(writer.executeBatch).not.toHaveBeenCalled();
    expect(writer.execute).toHaveBeenCalledOnce();
    expect(result.executionMode).toBe("single");
    expect(result.batchSteps).toBeUndefined();
  });

  it("keeps the saved liquidity steps unchanged when capability detection fails", async () => {
    const operation = createRemoveLiquidityOperation(config, { liquidity: 1n, amountsMin: [1n, 1n] });
    saveLiquidityOperations(config, [operation]);
    const writer = {
      supportsBatch: vi.fn().mockRejectedValue(new Error("Capabilities unavailable")),
      execute: vi.fn(), executeBatch: vi.fn(),
    };
    await expect(runLiquidityOperation(config, operation, {
      writeBoundary: writer, readSnapshot: async () => snapshot(),
    })).rejects.toThrow("Capabilities unavailable");
    expect(writer.execute).not.toHaveBeenCalled();
    expect(writer.executeBatch).not.toHaveBeenCalled();
    expect(loadLiquidityOperations(config)).toEqual([operation]);
  });

  it.each(["add", "remove"] as const)("recovers the original %s batch without re-approving", async (kind) => {
    const operation = kind === "add" ? createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n], amountsMin: [9n, 18n], estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n, reservesBefore: [100n, 200n],
    }) : createRemoveLiquidityOperation(config, { liquidity: 1n, amountsMin: [1n, 1n] });
    saveLiquidityOperations(config, [operation]);
    const read = snapshot();
    read.tokenA.allowance = 0n;
    read.tokenB.allowance = 0n;
    read.liquidityAllowance = 0n;
    const result = committed(10n, [acceptedEvent(new Uint8Array(32).fill(31))]);
    const returns = new CxsWriter();
    const count = kind === "add" ? 3 : 2;
    returns.writeUint32(BigInt(count));
    for (let i = 0; i < count; i++) returns.writeVarOpaque(new Uint8Array(), 0xffff_ffff);
    result.receipt.returnData = returns.finish();
    const writer: WriteBoundary = {
      supportsBatch: vi.fn().mockResolvedValue(true), execute: vi.fn(),
      executeBatch: vi.fn<NonNullable<WriteBoundary["executeBatch"]>>(async (calls, observer) => {
        expect(calls).toHaveLength(count);
        await observer?.onSigned(result.hash);
        return { kind: "indeterminate", hash: result.hash, reason: "timeout" };
      }),
      observe: vi.fn().mockResolvedValue(result),
    };
    const options = { writeBoundary: writer, readSnapshot: async () => read, automaticProcessing: false };
    const pending = await runLiquidityOperation(config, operation, options);
    expect(pending.steps.enqueue.status).toBe("indeterminate");
    const recovered = await runLiquidityOperation(config, pending, options);
    expect(recovered.status).toBe("queued");
    expect(recovered.requestId).toBe(hex(31));
    for (const name of recovered.batchSteps!)
      expect(recovered.steps[name]).toMatchObject({ status: "committed", transactionHash: result.hash });
    expect(writer.executeBatch).toHaveBeenCalledOnce();
    expect(writer.observe).toHaveBeenCalledExactlyOnceWith(result.hash);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("enqueues, cranks once, and verifies an unambiguous mint", async () => {
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    }, 1);
    saveLiquidityOperations(config, [operation]);
    const requestId = new Uint8Array(32).fill(30);
    const execute = vi.fn()
      .mockResolvedValueOnce(committed(10n, [acceptedEvent(requestId)]))
      .mockResolvedValueOnce(committed(11n, [mintEvent(requestId, 10n)]));
    const readSnapshot = vi.fn()
      .mockResolvedValue(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({
        reserve0: 110n,
        reserve1: 220n,
        liquidityBalance: 15n,
      }));

    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: { execute },
      readSnapshot,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "executed",
      requestId: hex(30),
      result: {
        liquidityMinted: "10",
        amountsDeposited: null,
        recipientVerified: true,
      },
    });
  });

  it("persists the accepted request without cranking in manual mode", async () => {
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    saveLiquidityOperations(config, [operation]);
    const requestId = new Uint8Array(32).fill(31);
    const execute = vi.fn().mockResolvedValue(
      committed(10n, [acceptedEvent(requestId)]),
    );

    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: { execute },
      readSnapshot: async () => snapshot(),
      automaticProcessing: false,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "queued",
      requestId: hex(31),
      steps: { enqueue: { status: "committed" } },
    });
  });

  it("stops safely on a pre-submission enqueue failure", async () => {
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    saveLiquidityOperations(config, [operation]);
    const execute = vi.fn().mockResolvedValue({
      kind: "preSubmissionFailure",
      hash: null,
      message: "wallet unavailable",
    } satisfies WriteResult);

    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: { execute },
      readSnapshot: async () => snapshot(),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.steps.approveToken0.status).toBe("skipped");
    expect(result.steps.approveToken1.status).toBe("skipped");
    expect(result.steps.enqueue).toMatchObject({
      status: "failed",
      message: "wallet unavailable",
    });
  });

  it("observes a stored crank instead of submitting a duplicate", async () => {
    const requestId = new Uint8Array(32).fill(30);
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    operation.status = "queued";
    operation.requestId = hex(30);
    operation.receiptBlock = "10";
    for (const name of ["approveToken0", "approveToken1", "enqueue"] as const) {
      operation.steps[name].status = "committed";
      operation.steps[name].transactionHash = hex(40);
    }
    saveLiquidityOperations(config, [operation]);
    saveCrankAttempt(config, {
      ...createCrankAttempt(config),
      status: "indeterminate",
      transactionHash: hex(41),
    });
    const execute = vi.fn();
    const observe = vi.fn().mockResolvedValue(
      committed(11n, [mintEvent(requestId, 10n)]),
    );

    const result = await runLiquidityOperation(config, operation, {
      writeBoundary: { execute, observe },
      readSnapshot: async () => snapshot({ liquidityBalance: 15n }),
    });

    expect(observe).toHaveBeenCalledWith(hex(41));
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("executed");
  });

  it("revalidates aggregate allowances immediately before add enqueue", async () => {
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    operation.steps.approveToken0 = committedStep();
    operation.steps.approveToken1 = committedStep();
    const other = createAddLiquidityOperation(config, {
      amountsDesired: [5n, 10n],
      amountsMin: [4n, 9n],
      estimatedLiquidity: 5n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    saveLiquidityOperations(config, [operation, other]);
    const execute = vi.fn();

    await expect(runLiquidityOperation(config, operation, {
      writeBoundary: { execute },
      readSnapshot: async () => snapshot({
        tokenA: { ...snapshot().tokenA, allowance: 10n },
        tokenB: { ...snapshot().tokenB, allowance: 20n },
      }),
    })).rejects.toThrow("allowances have not been observed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revalidates aggregate LP balance immediately before remove enqueue", async () => {
    const operation = createRemoveLiquidityOperation(config, {
      liquidity: 4n,
      amountsMin: [3n, 6n],
    });
    operation.steps.approveLiquidity = committedStep();
    const other = createRemoveLiquidityOperation(config, {
      liquidity: 3n,
      amountsMin: [2n, 5n],
    });
    saveLiquidityOperations(config, [operation, other]);
    const execute = vi.fn();

    await expect(runLiquidityOperation(config, operation, {
      writeBoundary: { execute },
      readSnapshot: async () => snapshot({ liquidityBalance: 5n }),
    })).rejects.toThrow("unreserved LP balance");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("applyLiquidityReceipt", () => {
  it("validates a request-correlated burn", () => {
    const requestId = new Uint8Array(32).fill(31);
    const operation = createRemoveLiquidityOperation(config, {
      liquidity: 10n,
      amountsMin: [4n, 8n],
    });
    operation.status = "queued";
    operation.requestId = hex(31);

    const [result] = applyLiquidityReceipt(
      config,
      [operation],
      committed(12n, [burnEvent(requestId, [5n, 10n])]).receipt,
    );

    expect(result).toMatchObject({
      status: "executed",
      result: { amountsRedeemed: ["5", "10"] },
    });
  });
});

function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    tokenA: {
      address: config.tokenAAddress,
      name: "Token A",
      symbol: "A",
      decimals: 0,
      balance: 1_000n,
      allowance: 1_000n,
    },
    tokenB: {
      address: config.tokenBAddress,
      name: "Token B",
      symbol: "B",
      decimals: 0,
      balance: 2_000n,
      allowance: 2_000n,
    },
    reserve0: 100n,
    reserve1: 200n,
    reserveTimestamp: 1n,
    liquidityTotalSupply: 100n,
    liquidityBalance: 5n,
    liquidityAllowance: 100n,
    liquidityTokenSymbol: "LP",
    liquidityTokenDecimals: 6,
    feeTo: null,
    chainHeight: 100n,
    readAt: 1,
    ...overrides,
  };
}

function committedStep() {
  return {
    status: "committed" as const,
    transactionHash: hex(40),
    message: null,
    updatedAt: 1,
  };
}

function committed(
  height: bigint,
  events: Array<{ contractAddress: ReturnType<typeof address>; topics: Uint8Array[]; data: Uint8Array }>,
): Extract<WriteResult, { kind: "committedSuccess" }> {
  return {
    kind: "committedSuccess",
    hash: hex(40),
    receipt: {
      txHash: sha256Hash(new Uint8Array(32).fill(40)),
      height,
      execResult: ExecResult.ExecResultOK,
      gasUsed: 0n,
      events,
      returnData: new Uint8Array(),
      abortData: null,
    },
  };
}

function acceptedEvent(requestId: Uint8Array) {
  return {
    contractAddress: config.driverAddress,
    topics: [RequestAccepted.signature, requestId],
    data: new Uint8Array(),
  };
}

function mintEvent(requestId: Uint8Array, amount: bigint) {
  const writer = new CxsWriter();
  Uint128Codec.encode(writer, amount);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    contractAddress: config.handlerAddress,
    topics: [MintEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}

function burnEvent(
  requestId: Uint8Array,
  amounts: readonly [bigint, bigint],
) {
  const writer = new CxsWriter();
  FixedArrayCodec(Uint128Codec, 2).encode(writer, [...amounts]);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    contractAddress: config.handlerAddress,
    topics: [BurnEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}
