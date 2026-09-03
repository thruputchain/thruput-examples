import { describe, expect, it } from "vitest";

import {
  allowanceTargetForSwap,
  availableBalance,
  hasExecutionExposure,
  invalidateSnapshotInferenceForOverlap,
  reservedInputForToken,
} from "./reservations";
import type { RequestRecord } from "@/transactions/request-collection";

const tokenA = `0x${"01".repeat(32)}`;
const tokenB = `0x${"02".repeat(32)}`;

describe("request reservations", () => {
  it.each([
    ["submitting", "swap", true],
    ["indeterminate", "swap", true],
    ["indeterminate", "approval", false],
    ["queued", "swap", true],
    ["queuedNotObserved", "swap", true],
    ["queuedUntracked", "swap", true],
    ["approving", "approval", false],
    ["committedFailure", "swap", false],
    ["executed", "swap", false],
    ["failed", "swap", false],
  ] as const)("classifies %s/%s exposure", (status, phase, expected) => {
    expect(hasExecutionExposure(request(status, phase, tokenA, 10n))).toBe(expected);
  });

  it("reserves inputs independently by token without crediting outputs", () => {
    const requests = [
      request("queued", "swap", tokenA, 10n),
      request("indeterminate", "swap", tokenA, 4n),
      request("queued", "swap", tokenB, 7n),
      request("failed", "swap", tokenA, 100n),
    ];

    expect(reservedInputForToken(requests, tokenA)).toBe(14n);
    expect(reservedInputForToken(requests, tokenB)).toBe(7n);
    expect(allowanceTargetForSwap(requests, tokenA, 3n)).toBe(17n);
  });

  it("subtracts reservations without returning a negative balance", () => {
    expect(availableBalance(20n, 8n)).toBe(12n);
    expect(availableBalance(8n, 8n)).toBe(0n);
    expect(availableBalance(5n, 8n)).toBe(0n);
  });

  it("permanently invalidates snapshot inference when exposures overlap", () => {
    const first = {
      ...request("queued", "swap", tokenA, 10n),
      snapshotInferenceEligible: true,
    };
    const second = {
      ...request("submitting", "swap", tokenA, 5n),
      localId: "second",
      snapshotInferenceEligible: true,
    };

    const overlapped = invalidateSnapshotInferenceForOverlap([first], second);

    expect(overlapped.every((item) => !item.snapshotInferenceEligible)).toBe(true);
    expect(overlapped[0]).toMatchObject({ localId: first.localId });
    expect(overlapped[1]).toMatchObject({ localId: second.localId });
  });
});

function request(
  status: RequestRecord["status"],
  phase: RequestRecord["phase"],
  tokenIn: string,
  amountIn: bigint,
): RequestRecord {
  const account = `0x${"09".repeat(32)}`;
  return {
    localId: `${status}-${phase}-${tokenIn}-${amountIn}`,
    status,
    phase,
    intent: { amountIn, amountOutMin: 1n },
    transactionHash: null,
    receiptBlock: null,
    requestId: null,
    visibleObservationMs: 0,
    observationBaseline: null,
    criteria: {
      sender: account,
      handlerAddress: tokenA,
      driverAddress: tokenA,
      recipient: tokenA,
      tokenIn,
      tokenOut: tokenIn === tokenA ? tokenB : tokenA,
    },
    createdAt: 1,
    updatedAt: 1,
    observedThroughBlock: null,
    snapshotInferenceEligible: false,
    execution: null,
  };
}
