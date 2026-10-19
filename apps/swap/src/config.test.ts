import { toBase58 } from "@thruputchain/client";
import { describe, expect, it } from "vitest";

import {
  isLoopbackHostname,
  isLoopbackUrl,
  loadGlobalConfig,
  READ_ONLY_CALLER,
  type Environment,
} from "./config";
import { ConfigurationError } from "./lib/errors";

const ADDRESS = toBase58(new Uint8Array(32).fill(0x11));
const OTHER_ADDRESS = toBase58(new Uint8Array(32).fill(0x22));

function environment(overrides: Environment = {}): Environment {
  return {
    VITE_THRUPUT_RPC_URL: "http://127.0.0.1:9545",
    VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
    VITE_POOL_TOKEN_HASH: ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: ADDRESS,
    VITE_SWAP_FACTORY_ADDRESS: ADDRESS,
    VITE_SWAP_ROUTER_ADDRESS: ADDRESS,
    ...overrides,
  };
}

describe("loadGlobalConfig", () => {
  it.each([undefined, "", "   ", "\t\r\n"])("disables explorer links for %s", (value) => {
    expect(loadGlobalConfig(environment({ VITE_EXPLORER_URL: value })).explorerUrl).toBeUndefined();
  });

  it.each([
    ["https://Explorer.example:443/", "https://explorer.example"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
  ])("normalizes explorer root %s", (value, expected) => {
    expect(loadGlobalConfig(environment({ VITE_EXPLORER_URL: value })).explorerUrl).toBe(expected);
  });

  it.each([
    true, "not a url", "//explorer.test", "javascript:alert(1)",
    "http://explorer.test", "http://localhost.evil.test", "http://127.1",
    "http://2130706433", "http://127.0.0.2", "http://localhost.",
    "https://user:secret@explorer.test", "https://@explorer.test",
    "https://explorer.test/path", "https://explorer.test/..",
    "https://explorer.test?", "https://explorer.test#",
    "https://explorer.test/?secret=x", "https://explorer.test/#fragment",
    "https://explorer.test\\path", "https://explorer.test/ ",
  ])("rejects unsafe explorer root %s", (value) => {
    expect(() => loadGlobalConfig(environment({ VITE_EXPLORER_URL: value }))).toThrow(ConfigurationError);
    expect(() => loadGlobalConfig(environment({ VITE_EXPLORER_URL: value }))).toThrow(/VITE_EXPLORER_URL/);
  });
  it("requires only factory-oriented runtime values", () => {
    const config = loadGlobalConfig(environment());

    expect(config.factoryAddress).toBeDefined();
    expect(config.accountAddress).toEqual(READ_ONLY_CALLER);
    expect(config.poolTokenHash).toBe(ADDRESS);
    expect(loadGlobalConfig(environment({ VITE_THRUPUT_WALLET_ADDRESS: OTHER_ADDRESS })).accountAddress).toEqual(READ_ONLY_CALLER);
  });

  it("rejects malformed network identities and RPC credentials", () => {
    expect(() => loadGlobalConfig(environment({
      VITE_THRUPUT_NETWORK_ID: "local",
    }))).toThrow("32-byte");
    expect(() => loadGlobalConfig(environment({
      VITE_THRUPUT_RPC_URL: "http://operator:secret@127.0.0.1:9545",
    }))).toThrow("must not contain credentials");
  });

});

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:9545",
    "http://127.0.0.1:9545",
    "http://[::1]:9545",
  ])("accepts %s", (value) => {
    expect(isLoopbackUrl(new URL(value))).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLoopbackUrl(new URL("https://rpc.example.com"))).toBe(false);
    expect(isLoopbackHostname("app.example.com")).toBe(false);
  });
});
