import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  isLoopbackHostname,
  isLoopbackUrl,
  loadGlobalConfig,
  parseExplorerUrl,
  READ_ONLY_CALLER,
  type Environment,
} from "./config";

const ADDRESS = `0x${"11".repeat(32)}`;
const OTHER_ADDRESS = `0x${"22".repeat(32)}`;

function environment(overrides: Environment = {}): Environment {
  return {
    VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
    VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
    VITE_POOL_TOKEN_HASH: ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: ADDRESS,
    VITE_KNOWN_TOKEN_ADDRESSES: `${ADDRESS},${OTHER_ADDRESS},${ADDRESS}`,
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
    expect(() => parseExplorerUrl(value)).toThrow(ConfigurationError);
    expect(() => parseExplorerUrl(value)).toThrow(/VITE_EXPLORER_URL/);
  });
  it("requires only factory-oriented runtime values", () => {
    const config = loadGlobalConfig(environment());

    expect(config.factoryAddress).toBeDefined();
    expect(config.registryEnabled).toBe(false);
    expect(config.accountAddress).toEqual(READ_ONLY_CALLER);
    expect(config.poolTokenHash).toBe(ADDRESS);
    expect(loadGlobalConfig(environment({ VITE_KNOWN_TOKEN_ADDRESSES: "" })).knownTokenAddresses).toEqual([]);
    expect(loadGlobalConfig(environment({ VITE_GROUNDHOG_WALLET_ADDRESS: OTHER_ADDRESS })).accountAddress).toEqual(READ_ONLY_CALLER);
  });

  it("parses the pool registry feature flag strictly", () => {
    expect(loadGlobalConfig(environment({
      VITE_POOL_REGISTRY_ENABLED: "true",
    })).registryEnabled).toBe(true);
    expect(loadGlobalConfig(environment({
      VITE_POOL_REGISTRY_ENABLED: true,
    })).registryEnabled).toBe(true);
    expect(loadGlobalConfig(environment({
      VITE_POOL_REGISTRY_ENABLED: "false",
    })).registryEnabled).toBe(false);
    expect(() => loadGlobalConfig(environment({
      VITE_POOL_REGISTRY_ENABLED: "TRUE",
    }))).toThrow("VITE_POOL_REGISTRY_ENABLED must be true or false");
  });

  it("rejects malformed network identities and RPC credentials", () => {
    expect(() => loadGlobalConfig(environment({
      VITE_GROUNDHOG_NETWORK_ID: "local",
    }))).toThrow("32-byte");
    expect(() => loadGlobalConfig(environment({
      VITE_GROUNDHOG_RPC_URL: "http://operator:secret@127.0.0.1:9545",
    }))).toThrow("must not contain credentials");
  });

  it("rejects malformed known-token addresses", () => {
    expect(() => loadGlobalConfig(environment({
      VITE_KNOWN_TOKEN_ADDRESSES: `${ADDRESS},not-an-address`,
    }))).toThrow("VITE_KNOWN_TOKEN_ADDRESSES must contain only 32-byte");
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
