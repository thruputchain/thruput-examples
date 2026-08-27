import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import type { PoolCreationReview } from "@/pools/pool-creation";
import { createCreationWorkflow } from "@/transactions/creation-workflow";
import { createAddLiquidityOperation } from "@/transactions/liquidity-operation";
import type { RequestRecord } from "@/transactions/request-collection";
import {
  cleanupAllowanceRequirementFor,
  requiredAllowanceFor,
} from "./allowance-exposure";

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

describe("requiredAllowanceFor", () => {
  it("aggregates execution exposure by exact token and handler", () => {
    const request = swapRequest(hex(1), hex(12), 3n);
    const otherHandlerRequest = swapRequest(hex(1), hex(20), 100n);
    const liquidity = createAddLiquidityOperation(config, {
      amountsDesired: [5n, 7n],
      amountsMin: [4n, 6n],
      estimatedLiquidity: 5n,
      liquidityBalanceBefore: 0n,
      reservesBefore: [10n, 10n],
    });
    liquidity.status = "queued";
    const creation = createCreationWorkflow(config, creationReview());
    creation.status = "queued";
    creation.requestId = hex(30);

    expect(requiredAllowanceFor({
      requests: [request, otherHandlerRequest],
      liquidityOperations: [liquidity],
      creationWorkflows: [creation],
    }, hex(1), hex(12))).toBe(19n);
    expect(requiredAllowanceFor({
      requests: [request, otherHandlerRequest],
      liquidityOperations: [liquidity],
      creationWorkflows: [creation],
    }, hex(1), hex(20))).toBe(100n);
  });

  it("excludes terminal operations", () => {
    const request = swapRequest(hex(1), hex(12), 3n);
    request.status = "failed";

    expect(requiredAllowanceFor({
      requests: [request],
      liquidityOperations: [],
      creationWorkflows: [],
    }, hex(1), hex(12))).toBe(0n);
  });

  it("requires allowance reads after terminal evidence", () => {
    const request = swapRequest(hex(1), hex(12), 3n);
    request.status = "executed";
    request.execution = {
      kind: "executed",
      transactionHash: hex(50),
      blockHeight: 12n,
      amountIn: 3n,
      amountOut: 2n,
    };

    expect(cleanupAllowanceRequirementFor({
      requests: [request],
      liquidityOperations: [],
      creationWorkflows: [],
    }, hex(1), hex(12))).toEqual({
      requiredAllowance: 0n,
      minimumReadHeight: 12n,
    });
  });

  it("preserves terminal exposure from legacy records without block evidence", () => {
    const liquidity = createAddLiquidityOperation(config, {
      amountsDesired: [5n, 7n],
      amountsMin: [4n, 6n],
      estimatedLiquidity: 5n,
      liquidityBalanceBefore: 0n,
      reservesBefore: [10n, 10n],
    });
    liquidity.status = "failed";
    liquidity.requestId = hex(30);
    liquidity.receiptBlock = "8";
    liquidity.steps.enqueue.status = "committed";
    liquidity.steps.enqueue.transactionHash = hex(31);
    delete liquidity.terminalBlock;

    expect(cleanupAllowanceRequirementFor({
      requests: [],
      liquidityOperations: [liquidity],
      creationWorkflows: [],
    }, hex(1), hex(12))).toEqual({
      requiredAllowance: 5n,
      minimumReadHeight: 0n,
    });
  });
});

function swapRequest(
  tokenAddress: string,
  handlerAddress: string,
  amountIn: bigint,
): RequestRecord {
  return {
    localId: crypto.randomUUID(),
    status: "queued",
    phase: "swap",
    intent: { amountIn, amountOutMin: 1n },
    transactionHash: hex(40),
    receiptBlock: 1n,
    requestId: hex(41),
    visibleObservationMs: 0,
    observationBaseline: null,
    criteria: {
      pairAddress: hex(10),
      handlerAddress,
      driverAddress: hex(13),
      recipient: hex(9),
      tokenIn: tokenAddress,
      tokenOut: hex(2),
    },
    createdAt: 1,
    updatedAt: 1,
    observedThroughBlock: null,
    snapshotInferenceEligible: false,
    execution: null,
  };
}

function creationReview(): PoolCreationReview {
  const token = (byte: number, amount: bigint) => ({
    address: address(byte),
    addressHex: hex(byte),
    name: `Token ${byte}`,
    symbol: `T${byte}`,
    decimals: 6,
    balance: 1_000n,
    allowance: 0n,
    amount,
    approvalDifference: amount,
  });
  return {
    token0: token(1, 11n),
    token1: token(2, 13n),
    pool: {
      liquidityToken: config.liquidityTokenAddress,
      pair: config.pairAddress,
      handler: config.handlerAddress,
      driver: config.driverAddress,
    },
    nativeHogBalance: 1_000n,
    fixedFundingPerContract: 100n,
    totalFixedFunding: 400n,
    initialLiquidity: 1n,
    readHeight: 1n,
  };
}
