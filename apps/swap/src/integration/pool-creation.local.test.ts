/// <reference types="node" />

import { addressFromHex } from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import { loadGlobalConfig } from "@/config";
import { preparePoolCreation } from "@/pools/pool-creation";
import { resolvePoolConfig } from "@/pools/pool-context";
import { createSnapshotReader } from "@/swap/snapshot";
import { runCreationWorkflow } from "@/transactions/creation-executor";
import {
  createCreationWorkflow,
  saveCreationWorkflow,
} from "@/transactions/creation-workflow";
import { createBrowserLocalWriteBoundary } from "@/transactions/local-development-wallet";
import { withOutstandingRequestLock } from "@/transactions/outstanding-request";

const runLocalIntegration = import.meta.env.MODE === "local-integration"
  && process.env.AMM_CREATE_TOKEN_A !== undefined
  && process.env.AMM_CREATE_TOKEN_B !== undefined;

describe.skipIf(!runLocalIntegration)("local pool creation", () => {
  it("funds, creates, seeds, and verifies a new pool", async () => {
    window.localStorage.clear();
    const config = loadGlobalConfig({
      VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
      VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
      VITE_GROUNDHOG_WALLET_ADDRESS:
        import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
      VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
      VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
      VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
      VITE_POOL_CONTRACT_FUNDING: import.meta.env.VITE_POOL_CONTRACT_FUNDING,
    });
    const tokenA = process.env.AMM_CREATE_TOKEN_A!;
    const tokenB = process.env.AMM_CREATE_TOKEN_B!;
    const review = await preparePoolCreation(config, {
      tokenA,
      tokenB,
      amountA: "0.002",
      amountB: "0.002",
    });
    const workflow = saveCreationWorkflow(
      config,
      createCreationWorkflow(config, review),
    );
    const writer = createBrowserLocalWriteBoundary(config);

    const result = await withOutstandingRequestLock(config, () =>
      runCreationWorkflow(config, workflow, { writeBoundary: writer })
    );

    expect(result.status).toBe("executed");
    expect(result.requestId).not.toBeNull();
    const poolConfig = await resolvePoolConfig(
      config,
      addressFromHex(result.token0.address),
      addressFromHex(result.token1.address),
    );
    const snapshot = await createSnapshotReader(poolConfig)();
    expect(snapshot.reserve0).toBe(2_000n);
    expect(snapshot.reserve1).toBe(2_000n);
    expect(snapshot.liquidityBalance).toBeGreaterThan(0n);
  }, 120_000);
});
