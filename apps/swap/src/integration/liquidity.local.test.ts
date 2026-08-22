/// <reference types="node" />

import { describe, expect, it } from "vitest";

import { loadAppConfig } from "@/config";
import { orderTokens } from "@/domain/tokens";
import {
  deriveAddLiquidityQuote,
  deriveRemoveLiquidityQuote,
} from "@/pools/liquidity-model";
import { resolvePoolConfig } from "@/pools/pool-context";
import { createSnapshotReader } from "@/swap/snapshot";
import { runLiquidityOperation } from "@/transactions/liquidity-executor";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
  saveLiquidityOperations,
} from "@/transactions/liquidity-operation";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { withOutstandingRequestLock } from "@/transactions/outstanding-request";

const runLocalIntegration = import.meta.env.MODE === "local-integration"
  && process.env.RUN_LIQUIDITY_INTEGRATION === "1";

describe.skipIf(!runLocalIntegration)("local liquidity integration", () => {
  it("adds and removes liquidity through request execution", async () => {
    window.localStorage.clear();
    const configured = loadLocalConfig();
    const ordered = orderTokens(configured.tokenAAddress, configured.tokenBAddress);
    const config = await resolvePoolConfig(configured, ordered.token0, ordered.token1);
    const readSnapshot = createSnapshotReader(config);
    const writer = createBrowserLocalWriteBoundary(config);
    const before = await readSnapshot();
    const addQuote = deriveAddLiquidityQuote(before, 0, "0.0001", 100n);
    expect(addQuote.ok).toBe(true);
    if (!addQuote.ok) return;
    const add = createAddLiquidityOperation(config, {
      amountsDesired: addQuote.amountsDesired,
      amountsMin: addQuote.amountsMin,
      estimatedLiquidity: addQuote.estimatedLiquidity,
      liquidityBalanceBefore: before.liquidityBalance,
      reservesBefore: [before.reserve0, before.reserve1],
    });
    saveLiquidityOperations(config, [add]);

    const added = await withOutstandingRequestLock(config, () =>
      runLiquidityOperation(config, add, {
        writeBoundary: writer,
        readSnapshot,
      })
    );
    expect(added).toMatchObject({
      status: "executed",
      result: { recipientVerified: true },
    });
    if (added.kind !== "add" || added.result === null) return;

    const afterAdd = await readSnapshot();
    const removeQuote = deriveRemoveLiquidityQuote(
      afterAdd,
      added.result.liquidityMinted,
      100n,
    );
    expect(removeQuote.ok).toBe(true);
    if (!removeQuote.ok) return;
    const remove = createRemoveLiquidityOperation(config, {
      liquidity: removeQuote.liquidity,
      amountsMin: removeQuote.amountsMin,
    });
    saveLiquidityOperations(config, [added, remove]);

    const removed = await withOutstandingRequestLock(config, () =>
      runLiquidityOperation(config, remove, {
        writeBoundary: writer,
        readSnapshot,
      })
    );
    expect(removed).toMatchObject({ status: "executed" });
    if (removed.kind !== "remove" || removed.result === null) return;
    expect(BigInt(removed.result.amountsRedeemed[0])).toBeGreaterThan(0n);
    expect(BigInt(removed.result.amountsRedeemed[1])).toBeGreaterThan(0n);
  }, 120_000);
});

function loadLocalConfig() {
  return loadAppConfig({
    VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
    VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
    VITE_GROUNDHOG_WALLET_ADDRESS: import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
    VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
    VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
    VITE_POOL_CONTRACT_FUNDING: import.meta.env.VITE_POOL_CONTRACT_FUNDING,
    VITE_SWAP_PAIR_ADDRESS: import.meta.env.VITE_SWAP_PAIR_ADDRESS,
    VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS:
      import.meta.env.VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS,
    VITE_SWAP_HANDLER_ADDRESS: import.meta.env.VITE_SWAP_HANDLER_ADDRESS,
    VITE_SWAP_DRIVER_ADDRESS: import.meta.env.VITE_SWAP_DRIVER_ADDRESS,
    VITE_TOKEN_A_ADDRESS: import.meta.env.VITE_TOKEN_A_ADDRESS,
    VITE_TOKEN_B_ADDRESS: import.meta.env.VITE_TOKEN_B_ADDRESS,
    VITE_TOKEN_A_SYMBOL: import.meta.env.VITE_TOKEN_A_SYMBOL,
    VITE_TOKEN_B_SYMBOL: import.meta.env.VITE_TOKEN_B_SYMBOL,
    VITE_TOKEN_DECIMALS: import.meta.env.VITE_TOKEN_DECIMALS,
  });
}
