/// <reference types="node" />
// @vitest-environment-options { "url": "http://127.0.0.1:9545" }

import { toHex0x } from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadAppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { allowanceDifference } from "@/domain/allowance";
import { orientReserves, orderTokens } from "@/domain/tokens";
import { deriveSwapQuote } from "@/swap/model";
import { createSnapshotReader } from "@/swap/snapshot";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { createRequestRecord } from "@/transactions/request-collection";
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";

const runLocalIntegration = import.meta.env.MODE === "local-integration";
describe.skipIf(!runLocalIntegration)("local swap integration", () => {
  it("enqueues two requests before one crank and observes both executions", async () => {
    const config = loadAppConfig({
      VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
      VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
      VITE_GROUNDHOG_WALLET_ADDRESS: import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
      VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
      VITE_SWAP_PAIR_ADDRESS: import.meta.env.VITE_SWAP_PAIR_ADDRESS,
      VITE_SWAP_HANDLER_ADDRESS: import.meta.env.VITE_SWAP_HANDLER_ADDRESS,
      VITE_SWAP_DRIVER_ADDRESS: import.meta.env.VITE_SWAP_DRIVER_ADDRESS,
      VITE_TOKEN_A_ADDRESS: import.meta.env.VITE_TOKEN_A_ADDRESS,
      VITE_TOKEN_B_ADDRESS: import.meta.env.VITE_TOKEN_B_ADDRESS,
      VITE_TOKEN_A_SYMBOL: import.meta.env.VITE_TOKEN_A_SYMBOL,
      VITE_TOKEN_B_SYMBOL: import.meta.env.VITE_TOKEN_B_SYMBOL,
      VITE_TOKEN_DECIMALS: import.meta.env.VITE_TOKEN_DECIMALS,
    });
    const readSnapshot = createSnapshotReader(config);
    const writer = createBrowserLocalWriteBoundary(config);
    const amount = "0.001";

    const initial = await readSnapshot();
    const firstPreview = deriveSwapQuote(initial, "aToB", amount, 500n);
    expect(firstPreview.ok).toBe(true);
    if (!firstPreview.ok) return;

    if (firstPreview.allowanceDifference !== 0n) {
      const approval = await writer.execute(
        buildApprovalTarget(
          config.tokenAAddress,
          config.handlerAddress,
          firstPreview.allowanceDifference,
        ),
      );
      expect(approval.kind).toBe("committedSuccess");
    }

    const firstApproved = await readSnapshot();
    const firstQuote = deriveSwapQuote(firstApproved, "aToB", amount, 500n);
    expect(firstQuote.ok).toBe(true);
    if (!firstQuote.ok) return;
    expect(firstApproved.tokenA.allowance).toBe(firstQuote.amountIn);

    const firstEnqueue = await writer.execute(
      buildExactInputSwapTarget(config.routerAddress, {
        amountIn: firstQuote.amountIn,
        amountOutMin: firstQuote.amountOutMin,
        tokenIn: config.tokenAAddress,
        tokenOut: config.tokenBAddress,
        recipient: config.accountAddress,
      }),
    );
    expect(firstEnqueue.kind).toBe("committedSuccess");
    if (firstEnqueue.kind !== "committedSuccess") return;

    const firstQueued = await readSnapshot();
    const secondPreview = deriveSwapQuote(
      firstQueued,
      "aToB",
      amount,
      500n,
      firstQuote.amountIn,
    );
    expect(secondPreview.ok).toBe(true);
    if (!secondPreview.ok) return;
    const aggregateTarget = firstQuote.amountIn + secondPreview.amountIn;
    const aggregateDifference = allowanceDifference(
      aggregateTarget,
      firstQueued.tokenA.allowance,
    );
    expect(aggregateDifference.ok).toBe(true);
    if (!aggregateDifference.ok) return;
    if (aggregateDifference.difference !== 0n) {
      const approval = await writer.execute(
        buildApprovalTarget(
          config.tokenAAddress,
          config.handlerAddress,
          aggregateDifference.difference,
        ),
      );
      expect(approval.kind).toBe("committedSuccess");
    }

    const aggregateApproved = await readSnapshot();
    expect(aggregateApproved.tokenA.allowance).toBe(aggregateTarget);
    const secondQuote = deriveSwapQuote(
      aggregateApproved,
      "aToB",
      amount,
      500n,
      firstQuote.amountIn,
    );
    expect(secondQuote.ok).toBe(true);
    if (!secondQuote.ok) return;
    expect(secondQuote.allowanceDifference).toBe(0n);

    const secondEnqueue = await writer.execute(
      buildExactInputSwapTarget(config.routerAddress, {
        amountIn: secondQuote.amountIn,
        amountOutMin: secondQuote.amountOutMin,
        tokenIn: config.tokenAAddress,
        tokenOut: config.tokenBAddress,
        recipient: config.accountAddress,
      }),
    );
    expect(secondEnqueue.kind).toBe("committedSuccess");
    if (secondEnqueue.kind !== "committedSuccess") return;

    const queued = await readSnapshot();
    expect(queued.tokenA.allowance).toBe(aggregateTarget);
    const firstRequestId = toHex0x(
      RequestAccepted.singleFromReceipt(firstEnqueue.receipt, {
        contractAddress: config.driverAddress,
      }).topics.request_id,
    );
    const secondRequestId = toHex0x(
      RequestAccepted.singleFromReceipt(secondEnqueue.receipt, {
        contractAddress: config.driverAddress,
      }).topics.request_id,
    );
    expect(secondRequestId).not.toBe(firstRequestId);
    const inputIndex = orderTokens(
      config.tokenAAddress,
      config.tokenBAddress,
    ).inputIndex;
    const queuedReserves = orientReserves(
      [queued.reserve0, queued.reserve1],
      inputIndex,
    );

    const criteria = {
      pairAddress: toHex0x(config.pairAddress),
      handlerAddress: toHex0x(config.handlerAddress),
      driverAddress: toHex0x(config.driverAddress),
      recipient: toHex0x(config.accountAddress),
      tokenIn: toHex0x(config.tokenAAddress),
      tokenOut: toHex0x(config.tokenBAddress),
    };
    const requests = [
      createRequestRecord({
        status: "queued",
        phase: "swap",
        intent: {
          amountIn: firstQuote.amountIn,
          amountOutMin: firstQuote.amountOutMin,
        },
        transactionHash: firstEnqueue.hash,
        receiptBlock: firstEnqueue.receipt.height,
        requestId: firstRequestId,
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      }),
      createRequestRecord({
        status: "queued",
        phase: "swap",
        intent: {
          amountIn: secondQuote.amountIn,
          amountOutMin: secondQuote.amountOutMin,
        },
        transactionHash: secondEnqueue.hash,
        receiptBlock: secondEnqueue.receipt.height,
        requestId: secondRequestId,
        visibleObservationMs: 0,
        observationBaseline: null,
        criteria,
      }),
    ];
    const crank = await writer.execute(
      buildProcessRequestsTarget(config.driverAddress),
    );
    expect(crank.kind).toBe("committedSuccess");
    if (crank.kind !== "committedSuccess") return;
    const batch = observationsFromReceipt(config, requests, crank.receipt);
    expect(batch.observations).toHaveLength(2);
    expect(new Set(batch.observations.map(({ requestId }) => requestId))).toEqual(
      new Set([firstRequestId, secondRequestId]),
    );
    expect(batch.observations.every(({ kind }) =>
      kind === "executionObserved"
    )).toBe(true);
    expect(
      applyObservationBatch(requests, requests, batch).map(({ status }) => status),
    ).toEqual(["executed", "executed"]);
    const observations = batch.observations.filter(
      (observation) => observation.kind === "executionObserved",
    );
    if (observations.length !== 2) return;
    const totalAmountIn = observations.reduce(
      (total, observation) => total + observation.amountIn,
      0n,
    );
    const totalAmountOut = observations.reduce(
      (total, observation) => total + observation.amountOut,
      0n,
    );

    const executed = await readSnapshot();
    expect(executed.tokenA.balance).toBe(
      queued.tokenA.balance - totalAmountIn,
    );
    expect(executed.tokenB.balance).toBe(
      queued.tokenB.balance + totalAmountOut,
    );
    expect(executed.tokenA.allowance).toBe(0n);
    const executedReserves = orientReserves(
      [executed.reserve0, executed.reserve1],
      inputIndex,
    );
    expect(executedReserves.reserveIn).toBe(
      queuedReserves.reserveIn + totalAmountIn,
    );
    expect(executedReserves.reserveOut).toBe(
      queuedReserves.reserveOut - totalAmountOut,
    );
  }, 90_000);
});
