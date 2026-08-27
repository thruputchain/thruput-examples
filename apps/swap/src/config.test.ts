import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  isLoopbackHostname,
  isLoopbackUrl,
  loadAppConfig,
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
    VITE_POOL_CONTRACT_FUNDING: "10000000",
    VITE_SWAP_PAIR_ADDRESS: ADDRESS,
    VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS: ADDRESS,
    VITE_SWAP_HANDLER_ADDRESS: ADDRESS,
    VITE_SWAP_DRIVER_ADDRESS: ADDRESS,
    VITE_TOKEN_A_ADDRESS: ADDRESS,
    VITE_TOKEN_B_ADDRESS: OTHER_ADDRESS,
    ...overrides,
  };
}

describe("loadAppConfig", () => {
  it("parses generated read-only configuration", () => {
    const config = loadAppConfig(environment());

    expect(config.rpcUrl.href).toBe("http://127.0.0.1:9545/");
    expect(config.networkIdHex).toBe("00".repeat(32));
    expect(config.knownTokenAddresses).toHaveLength(2);
    expect(config.tokenADecimals).toBe(6);
    expect(config.tokenBDecimals).toBe(6);
  });

  it("reports the exact missing variable", () => {
    expect(() =>
      loadAppConfig(environment({ VITE_SWAP_PAIR_ADDRESS: undefined })),
    ).toThrow(new ConfigurationError("VITE_SWAP_PAIR_ADDRESS is required"));
  });

  it("rejects malformed addresses and network identities", () => {
    expect(() =>
      loadAppConfig(environment({ VITE_TOKEN_A_ADDRESS: "0x01" })),
    ).toThrow("32-byte");
    expect(() =>
      loadAppConfig(environment({ VITE_GROUNDHOG_NETWORK_ID: "local" })),
    ).toThrow("32-byte");
  });

  it("rejects identical token addresses", () => {
    expect(() =>
      loadAppConfig(environment({ VITE_TOKEN_B_ADDRESS: ADDRESS })),
    ).toThrow("must differ");
  });

  it("rejects RPC credentials that would be exposed or logged", () => {
    expect(() =>
      loadAppConfig(
        environment({
          VITE_GROUNDHOG_RPC_URL: "http://operator:secret@127.0.0.1:9545",
        }),
      ),
    ).toThrow("must not contain credentials");
  });
});

describe("loadGlobalConfig", () => {
  it("requires only factory-oriented runtime values", () => {
    const config = loadGlobalConfig(environment({
      VITE_SWAP_PAIR_ADDRESS: undefined,
      VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS: undefined,
      VITE_SWAP_HANDLER_ADDRESS: undefined,
      VITE_SWAP_DRIVER_ADDRESS: undefined,
      VITE_TOKEN_A_ADDRESS: undefined,
      VITE_TOKEN_B_ADDRESS: undefined,
    }));

    expect(config.factoryAddress).toBeDefined();
    expect(config.poolContractFunding).toBe(10_000_000n);
  });

  it("rejects invalid fixed funding", () => {
    expect(() => loadGlobalConfig(environment({
      VITE_POOL_CONTRACT_FUNDING: "0",
    }))).toThrow("between 1 and 2^128 - 1");
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
