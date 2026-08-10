/// <reference types="node" />
// @vitest-environment-options { "url": "http://127.0.0.1:9545" }

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { toHex0x } from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadAppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { extractAcceptedRequestId } from "@/contracts/swap-event";
import { orientReserves, orderTokens } from "@/domain/tokens";
import { deriveSwapQuote } from "@/swap/model";
import { createSnapshotReader } from "@/swap/snapshot";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { createRequestObserver } from "@/transactions/request-observer";

const runLocalIntegration = import.meta.env.MODE === "local-integration";
const execFileAsync = promisify(execFile);
const appDirectory = process.cwd();
const crankScript = path.join(appDirectory, "scripts", "crank-local.sh");

describe.skipIf(!runLocalIntegration)("local swap integration", () => {
  it("approves, enqueues, cranks, observes execution, and refreshes state", async () => {
    if (process.env.GROUNDHOG_CLI === undefined) {
      throw new Error(
        "GROUNDHOG_CLI must point to the validated Groundhog 0.6.1 executable",
      );
    }
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
    const initialQuote = deriveSwapQuote(initial, "aToB", amount, 50n);
    expect(initialQuote.ok).toBe(true);
    if (!initialQuote.ok) return;

    if (initialQuote.allowanceDifference !== 0n) {
      const approval = await writer.execute(
        buildApprovalTarget(
          config.tokenAAddress,
          config.handlerAddress,
          initialQuote.allowanceDifference,
        ),
      );
      expect(approval.kind).toBe("committedSuccess");
    }

    const approved = await readSnapshot();
    const approvedQuote = deriveSwapQuote(approved, "aToB", amount, 50n);
    expect(approvedQuote.ok).toBe(true);
    if (!approvedQuote.ok) return;
    expect(approved.tokenA.allowance).toBe(approvedQuote.amountIn);

    const enqueue = await writer.execute(
      buildExactInputSwapTarget(config.routerAddress, {
        amountIn: approvedQuote.amountIn,
        amountOutMin: approvedQuote.amountOutMin,
        tokenIn: config.tokenAAddress,
        tokenOut: config.tokenBAddress,
        recipient: config.accountAddress,
      }),
    );
    expect(enqueue.kind).toBe("committedSuccess");
    if (enqueue.kind !== "committedSuccess") return;

    const queued = await readSnapshot();
    expect(queued.tokenA.allowance).toBe(approvedQuote.amountIn);
    const requestId = toHex0x(
      extractAcceptedRequestId(enqueue.receipt, config.driverAddress),
    );
    const inputIndex = orderTokens(
      config.tokenAAddress,
      config.tokenBAddress,
    ).inputIndex;
    const approvedReserves = orientReserves(
      [approved.reserve0, approved.reserve1],
      inputIndex,
    );

    await execFileAsync("bash", [crankScript], {
      cwd: appDirectory,
      env: process.env,
    });

    const observation = await createRequestObserver(config).scan({
      status: "queued",
      phase: "swap",
      intent: {
        amountIn: approvedQuote.amountIn,
        amountOutMin: approvedQuote.amountOutMin,
      },
      transactionHash: enqueue.hash,
      receiptBlock: enqueue.receipt.height,
      requestId,
      visibleObservationMs: 0,
      observationBaseline: {
        chainHeight: approved.chainHeight,
        inputBalance: approved.tokenA.balance,
        outputBalance: approved.tokenB.balance,
        inputAllowance: approved.tokenA.allowance,
        reserveIn: approvedReserves.reserveIn,
        reserveOut: approvedReserves.reserveOut,
      },
      criteria: {
        pairAddress: toHex0x(config.pairAddress),
        handlerAddress: toHex0x(config.handlerAddress),
        driverAddress: toHex0x(config.driverAddress),
        recipient: toHex0x(config.accountAddress),
        tokenIn: toHex0x(config.tokenAAddress),
        tokenOut: toHex0x(config.tokenBAddress),
      },
    });
    expect(observation.result?.kind).toBe("executionObserved");
    if (observation.result?.kind !== "executionObserved") return;

    const executed = await readSnapshot();
    expect(executed.tokenA.balance).toBe(
      approved.tokenA.balance - observation.result.amountIn,
    );
    expect(executed.tokenB.balance).toBe(
      approved.tokenB.balance + observation.result.amountOut,
    );
    expect(executed.tokenA.allowance).toBe(0n);
    const executedReserves = orientReserves(
      [executed.reserve0, executed.reserve1],
      inputIndex,
    );
    expect(executedReserves.reserveIn).toBe(
      approvedReserves.reserveIn + observation.result.amountIn,
    );
    expect(executedReserves.reserveOut).toBe(
      approvedReserves.reserveOut - observation.result.amountOut,
    );
  }, 90_000);
});
