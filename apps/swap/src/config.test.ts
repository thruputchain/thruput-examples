import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  isLoopbackHostname,
  isLoopbackUrl,
  loadGlobalConfig,
  type Environment,
} from "./config";

const ADDRESS = `0x${"11".repeat(32)}`;
const OTHER_ADDRESS = `0x${"22".repeat(32)}`;

function environment(overrides: Environment = {}): Environment {
  return {
    VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
    VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
    VITE_GROUNDHOG_WALLET_ADDRESS: ADDRESS,
    VITE_NATIVE_HOG_ADDRESS: ADDRESS,
    VITE_KNOWN_TOKEN_ADDRESSES: `${ADDRESS},${OTHER_ADDRESS},${ADDRESS}`,
    VITE_SWAP_FACTORY_ADDRESS: ADDRESS,
    VITE_SWAP_ROUTER_ADDRESS: ADDRESS,
    ...overrides,
  };
}

describe("loadGlobalConfig", () => {
  it("requires only factory-oriented runtime values", () => {
    const config = loadGlobalConfig(environment());

    expect(config.factoryAddress).toBeDefined();
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
