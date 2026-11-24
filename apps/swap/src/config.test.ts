import { toBase58 } from "@thruputchain/client";
import { expect, it } from "vitest";
import { loadConfig } from "./config";

const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const environment = {
  VITE_THRUPUT_RPC_URL: "http://127.0.0.1:9545/",
  VITE_THRUPUT_NETWORK_ID: id(0),
  VITE_POOL_TOKEN_HASH: id(9),
  VITE_SWAP_ROUTER_ADDRESS: id(4),
  VITE_SWAP_FACTORY_ADDRESS: id(3),
  VITE_NATIVE_TOKEN_ADDRESS: id(5),
};

it("reads the public settings", () => {
  const config = loadConfig(environment);
  expect(toBase58(config.factoryAddress)).toBe(id(3));
  expect(config.poolTokenHash).toBe(id(9));
  expect(config.explorerUrl).toBeUndefined();
});

it("names the setting that is missing or malformed", () => {
  expect(() =>
    loadConfig({ ...environment, VITE_SWAP_ROUTER_ADDRESS: undefined }),
  ).toThrow("VITE_SWAP_ROUTER_ADDRESS is required");
  expect(() =>
    loadConfig({ ...environment, VITE_SWAP_FACTORY_ADDRESS: "0x1234" }),
  ).toThrow("VITE_SWAP_FACTORY_ADDRESS must be a base58 contract address");
});
