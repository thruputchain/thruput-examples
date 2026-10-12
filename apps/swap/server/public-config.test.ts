// @vitest-environment node
import { expect, it } from "vitest";
import { publicConfig } from "./public-config";
import { loadGlobalConfig } from "../src/config";

it("projects validated public settings without exposing server environment", () => {
  const address = `0x${"11".repeat(32)}`;
  const published = publicConfig({
    VITE_THRUPUT_RPC_URL: "https://private-upstream.test/rpc",
    VITE_THRUPUT_NETWORK_ID: "00".repeat(32),
    VITE_POOL_TOKEN_HASH: address,
    VITE_NATIVE_HOG_ADDRESS: address,
    VITE_SWAP_FACTORY_ADDRESS: address,
    VITE_SWAP_ROUTER_ADDRESS: address,
    POOL_REGISTRY_DB_PATH: "/private/database",
    VITE_UNRELATED_SECRET: "secret",
  });
  expect(JSON.stringify(published)).not.toMatch(/private|secret/i);
  expect(published).not.toHaveProperty("VITE_THRUPUT_RPC_URL");
  const parsed = loadGlobalConfig({
    ...published,
    VITE_THRUPUT_RPC_URL: "https://app.test/thruput-rpc",
  });
  expect(parsed.poolTokenHash).toBe(address);
  expect(parsed.rpcUrl.href).toBe("https://app.test/thruput-rpc");
});
