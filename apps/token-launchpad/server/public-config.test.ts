// @vitest-environment node

import { toBase58 } from "@thruputchain/client";
import { expect, it } from "vitest";
import { publicConfig } from "./public-config";
import { loadConfig } from "../src/config";

it("projects validated public settings without exposing server environment", () => {
  const address = toBase58(new Uint8Array(32).fill(0x11));
  const published = publicConfig({
    VITE_THRUPUT_RPC_URL: "https://private-upstream.test/rpc",
    VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0x00)),
    VITE_STANDARD_TOKEN_HASH: address,
    VITE_NATIVE_TOKEN_ADDRESS: address,
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: address,
    VITE_NATIVE_BALANCE_ITEM_COST: "1234",
    TOKEN_REGISTRY_DB_PATH: "/private/database",
    VITE_UNRELATED_SECRET: "secret",
  });
  expect(JSON.stringify(published)).not.toMatch(/private|secret/i);
  expect(published).not.toHaveProperty("VITE_THRUPUT_RPC_URL");
  const parsed = loadConfig({
    ...published,
    VITE_THRUPUT_RPC_URL: "https://app.test/thruput-rpc",
  });
  expect(parsed.nativeBalanceItemCost).toBe(1234n);
  expect(parsed.rpcUrl.href).toBe("https://app.test/thruput-rpc");
});
