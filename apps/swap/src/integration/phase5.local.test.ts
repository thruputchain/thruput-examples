// @vitest-environment-options { "url": "http://127.0.0.1:9545" }

import { describe, expect, it } from "vitest";

import { loadAppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildExactInputSwapTarget } from "@/contracts/router-target";
import { deriveSwapQuote } from "@/swap/model";
import { createSnapshotReader } from "@/swap/snapshot";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";

const runLocalIntegration = import.meta.env.MODE === "local-integration";

describe.skipIf(!runLocalIntegration)("Phase 5 local integration", () => {
  it("approves an exact amount and leaves one swap request queued", async () => {
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

    const queued = await readSnapshot();
    expect(queued.tokenA.allowance).toBe(approvedQuote.amountIn);
  }, 60_000);
});
