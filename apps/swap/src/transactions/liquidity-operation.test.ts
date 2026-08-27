import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
  hasBlockingLiquidityTransaction,
  hasLiquidityExecutionExposure,
  LiquidityOperationError,
  liquidityOperationKey,
  loadAccountLiquidityOperations,
  loadLiquidityOperations,
  reservedLiquidityTokenAmount,
  saveLiquidityOperations,
} from "./liquidity-operation";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
  pairAddress: address(10),
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

describe("liquidity operation storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round trips add and remove intents", () => {
    const add = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    }, 1);
    const remove = createRemoveLiquidityOperation(config, {
      liquidity: 4n,
      amountsMin: [3n, 6n],
    }, 2);

    saveLiquidityOperations(config, [add, remove]);

    expect(loadLiquidityOperations(config)).toEqual([add, remove]);
    expect(loadAccountLiquidityOperations(config)).toEqual([add, remove]);
  });

  it("aggregates token and LP reservations", () => {
    const add = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    const remove = createRemoveLiquidityOperation(config, {
      liquidity: 4n,
      amountsMin: [3n, 6n],
    });

    expect(reservedLiquidityTokenAmount([add, remove], hex(1))).toBe(10n);
    expect(reservedLiquidityTokenAmount([add, remove], hex(2))).toBe(20n);
    expect(reservedLiquidityTokenAmount([add, remove], hex(11))).toBe(4n);
  });

  it("identifies blocking signing and execution exposure", () => {
    const add = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    add.steps.approveToken0.status = "signing";
    expect(hasBlockingLiquidityTransaction(add)).toBe(true);
    expect(hasLiquidityExecutionExposure(add)).toBe(false);

    add.steps.approveToken0.status = "committed";
    add.steps.approveToken0.transactionHash = hex(40);
    add.steps.enqueue.status = "indeterminate";
    expect(hasLiquidityExecutionExposure(add)).toBe(true);
  });

  it("fails closed on mismatched storage scope", () => {
    const add = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    saveLiquidityOperations(config, [add]);
    const stored = JSON.parse(window.localStorage.getItem(liquidityOperationKey(config))!);
    stored.operations[0].pairAddress = hex(99);
    window.localStorage.setItem(liquidityOperationKey(config), JSON.stringify(stored));

    expect(() => loadLiquidityOperations(config)).toThrow(LiquidityOperationError);
    expect(() => loadAccountLiquidityOperations(config)).toThrow(LiquidityOperationError);
  });

  it("rejects incoherent queued and terminal lifecycle state", () => {
    const add = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    });
    saveLiquidityOperations(config, [add]);
    const key = liquidityOperationKey(config);
    const stored = JSON.parse(window.localStorage.getItem(key)!);
    stored.operations[0].status = "queued";
    window.localStorage.setItem(key, JSON.stringify(stored));
    expect(() => loadLiquidityOperations(config)).toThrow(LiquidityOperationError);

    stored.operations[0].status = "executed";
    stored.operations[0].requestId = hex(30);
    stored.operations[0].receiptBlock = "8";
    stored.operations[0].steps.enqueue.status = "committed";
    stored.operations[0].steps.enqueue.transactionHash = hex(31);
    window.localStorage.setItem(key, JSON.stringify(stored));
    expect(() => loadLiquidityOperations(config)).toThrow(LiquidityOperationError);
  });

  it("keeps all unresolved operations and only the newest 50 terminal records", () => {
    const unresolved = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 5n,
      reservesBefore: [100n, 200n],
    }, 1);
    const terminal = Array.from({ length: 52 }, (_, index) => {
      const operation = createRemoveLiquidityOperation(config, {
        liquidity: 4n,
        amountsMin: [3n, 6n],
      }, index + 2);
      operation.status = "failed";
      operation.requestId = hex(index + 1);
      operation.receiptBlock = "8";
      operation.steps.enqueue = {
        status: "committed",
        transactionHash: hex(index + 101),
        message: null,
        updatedAt: index + 2,
      };
      return operation;
    });

    const stored = saveLiquidityOperations(config, [unresolved, ...terminal]);

    expect(stored).toHaveLength(51);
    expect(stored).toContainEqual(unresolved);
    expect(stored.some(({ id }) => id === terminal[0]!.id)).toBe(false);
    expect(stored.some(({ id }) => id === terminal[51]!.id)).toBe(true);
  });
});
