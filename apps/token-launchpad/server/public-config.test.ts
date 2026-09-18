// @vitest-environment node
import { expect, it } from "vitest";
import { publicConfig } from "./public-config";
import { loadConfig } from "../src/config";

it("projects validated public settings without exposing server environment", () => {
  const address = `0x${"11".repeat(32)}`;
  const published = publicConfig({
    VITE_GROUNDHOG_RPC_URL: "https://private-upstream.test/rpc",
    VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
    VITE_STANDARD_TOKEN_HASH: address,
    VITE_NATIVE_HOG_ADDRESS: address,
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: address,
    VITE_NATIVE_BALANCE_ITEM_COST: "1234",
    TOKEN_REGISTRY_DB_PATH: "/private/database",
    VITE_UNRELATED_SECRET: "secret",
  });
  expect(JSON.stringify(published)).not.toMatch(/private|secret/i);
  expect(published).not.toHaveProperty("VITE_GROUNDHOG_RPC_URL");
  const parsed = loadConfig({
    ...published,
    VITE_GROUNDHOG_RPC_URL: "https://app.test/groundhog-rpc",
  });
  expect(parsed.nativeBalanceItemCost).toBe(1234n);
  expect(parsed.rpcUrl.href).toBe("https://app.test/groundhog-rpc");
});
