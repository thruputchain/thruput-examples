// @vitest-environment node
import { toBase58 } from "@thruputchain/client";
import { expect, it } from "vitest";
import { publicConfig } from "./public-config";
import { loadGlobalConfig } from "../src/config";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

it("projects validated public settings without exposing server environment", () => {
  const address = b58(0x11);
  const published = publicConfig({
    VITE_THRUPUT_RPC_URL: "https://private-upstream.test/rpc",
    VITE_THRUPUT_NETWORK_ID: b58(0x00),
    VITE_POOL_TOKEN_HASH: address,
    VITE_NATIVE_TOKEN_ADDRESS: address,
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

it("publishes a native-token address set under the pre-rename key", () => {
  const address = b58(0x11);
  const published = publicConfig({
    VITE_THRUPUT_RPC_URL: "https://app.test/thruput-rpc",
    VITE_THRUPUT_NETWORK_ID: b58(0x00),
    VITE_NATIVE_HOG_ADDRESS: address,
    VITE_SWAP_FACTORY_ADDRESS: address,
    VITE_SWAP_ROUTER_ADDRESS: address,
  });
  expect(published.VITE_NATIVE_TOKEN_ADDRESS).toBe(address);
  expect(published).not.toHaveProperty("VITE_NATIVE_HOG_ADDRESS");
});
