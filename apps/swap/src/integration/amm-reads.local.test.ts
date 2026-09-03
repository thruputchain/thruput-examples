import { describe, expect, it } from "vitest";

import { loadGlobalConfig } from "@/config";
import { readPoolDirectory } from "@/pools/pool-directory";

const runLocalIntegration = import.meta.env.MODE === "local-integration";

describe.skipIf(!runLocalIntegration)("local AMM reads", () => {
  it("enumerates the configured factory and loads coherent pool details", async () => {
    const config = loadGlobalConfig({
      VITE_GROUNDHOG_RPC_URL: import.meta.env.VITE_GROUNDHOG_RPC_URL,
      VITE_GROUNDHOG_NETWORK_ID: import.meta.env.VITE_GROUNDHOG_NETWORK_ID,
      VITE_GROUNDHOG_WALLET_ADDRESS:
        import.meta.env.VITE_GROUNDHOG_WALLET_ADDRESS,
      VITE_NATIVE_HOG_ADDRESS: import.meta.env.VITE_NATIVE_HOG_ADDRESS,
      VITE_SWAP_FACTORY_ADDRESS: import.meta.env.VITE_SWAP_FACTORY_ADDRESS,
      VITE_SWAP_ROUTER_ADDRESS: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
    });

    const result = await readPoolDirectory(config);
    expect(result.invalidEntryCount).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.snapshot.reserve0).toBeGreaterThan(0n);
    expect(result.entries[0]?.snapshot.reserve1).toBeGreaterThan(0n);
    expect(result.entries[0]?.snapshot.liquidityTotalSupply).toBeGreaterThan(0n);
  });
});
