import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it } from "vitest";

import type { PoolSnapshot } from "@/swap/snapshot";
import type { OutstandingRequest } from "@/transactions/request-collection";
import { createRequestRecord } from "@/transactions/request-collection";
import {
  inferExecutionFromSnapshot,
  inferSingleExecutionFromSnapshot,
} from "./execution-fallback";

const tokenA = contractAddress(new Uint8Array(32).fill(1));
const tokenB = contractAddress(new Uint8Array(32).fill(2));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const request: OutstandingRequest = {
  status: "queued",
  phase: "swap",
  intent: { amountIn: 10n, amountOutMin: 18n },
  transactionHash: id(0xaa),
  receiptBlock: 8n,
  requestId: hex(0xcc),
  visibleObservationMs: 0,
  observationBaseline: {
    chainHeight: 7n,
    inputBalance: 100n,
    outputBalance: 10n,
    inputAllowance: 10n,
    reserveIn: 1_000n,
    reserveOut: 2_000n,
  },
  criteria: {
    sender: id(9),
    handlerAddress: id(6),
    driverAddress: id(5),
    recipient: id(9),
    tokenIn: id(1),
    tokenOut: id(2),
  },
};
const executed: PoolSnapshot = {
  tokenA: {
    address: tokenA,
    name: "Token A",
    symbol: "A",
    decimals: 6,
    balance: 90n,
    allowance: 0n,
  },
  tokenB: {
    address: tokenB,
    name: "Token B",
    symbol: "B",
    decimals: 6,
    balance: 29n,
    allowance: 0n,
  },
  reserve0: 1_010n,
  reserve1: 1_981n,
  reserveTimestamp: 1n,
  liquidityTotalSupply: 1_000n,
  liquidityBalance: 100n,
  liquidityAllowance: 0n,
  liquidityTokenSymbol: "LP",
  liquidityTokenDecimals: 6,
  feeTo: null,
  chainHeight: 10n,
  readAt: 0,
};

describe("execution snapshot fallback", () => {
  it("infers execution only when all deltas agree in one snapshot", () => {
    expect(inferExecutionFromSnapshot(request, executed)).toEqual({
      kind: "executionInferred",
      requestId: request.requestId,
      transactionHash: request.transactionHash,
      blockHeight: 10n,
      amountIn: 10n,
      amountOut: 19n,
    });
  });

  it.each([
    ["input balance", { tokenA: { ...executed.tokenA, balance: 91n } }],
    ["output balance", { tokenB: { ...executed.tokenB, balance: 28n } }],
    ["allowance", { tokenA: { ...executed.tokenA, allowance: 1n } }],
    ["input reserve", { reserve0: 1_009n }],
    ["output reserve", { reserve1: 1_982n }],
    ["snapshot height", { chainHeight: 8n }],
  ])("does not infer from a partial %s change", (_name, change) => {
    expect(
      inferExecutionFromSnapshot(request, { ...executed, ...change }),
    ).toBeNull();
  });

  it("does not infer without a persisted pre-execution baseline", () => {
    expect(
      inferExecutionFromSnapshot(
        { ...request, observationBaseline: null },
        executed,
      ),
    ).toBeNull();
  });

  it("does not attribute a snapshot while multiple requests are unresolved", () => {
    const first = createRequestRecord(request, { localId: "first", now: 1 });
    const second = createRequestRecord(
      { ...request, requestId: hex(0xdd) },
      { localId: "second", now: 2 },
    );

    expect(inferSingleExecutionFromSnapshot([first, second], executed)).toBeNull();
    expect(
      inferSingleExecutionFromSnapshot(
        [{ ...first, observationBaseline: null }],
        executed,
      ),
    ).toBeNull();
    expect(inferSingleExecutionFromSnapshot([first], executed)).not.toBeNull();
  });

  it("does not re-enable inference after overlapping requests become one", () => {
    const remaining = {
      ...createRequestRecord(request, { localId: "remaining", now: 1 }),
      snapshotInferenceEligible: false,
    };

    expect(inferSingleExecutionFromSnapshot([remaining], executed)).toBeNull();
  });
});
