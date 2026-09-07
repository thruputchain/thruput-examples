import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "@/config";

const address = `0x${"11".repeat(32)}`;
const environment = {
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
  VITE_GROUNDHOG_NETWORK_ID: "22".repeat(32),
  VITE_GROUNDHOG_WALLET_ADDRESS: address,
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: address,
  VITE_NATIVE_HOG_ADDRESS: address,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_STANDARD_TOKEN_HASH: `0x${"33".repeat(32)}`,
};

describe("loadConfig", () => {
  it("parses trusted launchpad settings", () => {
    const config = loadConfig(environment);
    expect(config.registryEnabled).toBe(false);
    expect(config.swapAppUrl).toBeNull();
    expect(config.nativeBalanceItemCost).toBe(1234n);
    expect(config.networkIdHex).toBe("22".repeat(32));
  });

  it("loads an optional Swap origin independently of the token registry", () => {
    const config = loadConfig({
      ...environment,
      VITE_SWAP_APP_URL: "https://SWAP.example.test/",
    });
    expect(config.swapAppUrl).toBe("https://swap.example.test");
    expect(config.registryEnabled).toBe(false);
    expect(() =>
      loadConfig({
        ...environment,
        VITE_SWAP_APP_URL: "https://swap.example.test/pools",
      }),
    ).toThrow(/VITE_SWAP_APP_URL/);
  });

  it("enables the persistent registry only for an explicit true value", () => {
    expect(
      loadConfig({ ...environment, VITE_TOKEN_REGISTRY_ENABLED: "true" })
        .registryEnabled,
    ).toBe(true);
    expect(
      loadConfig({ ...environment, VITE_TOKEN_REGISTRY_ENABLED: "false" })
        .registryEnabled,
    ).toBe(false);
  });

  it("rejects invalid registry flags", () => {
    expect(() =>
      loadConfig({ ...environment, VITE_TOKEN_REGISTRY_ENABLED: "TRUE" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...environment, VITE_TOKEN_REGISTRY_ENABLED: "1" }),
    ).toThrow(/VITE_TOKEN_REGISTRY_ENABLED/);
  });

  it("rejects credentials in the RPC URL", () => {
    expect(() =>
      loadConfig({
        ...environment,
        VITE_GROUNDHOG_RPC_URL: "http://user:secret@127.0.0.1:9545",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects a balance-item cost from another runtime", () => {
    expect(() =>
      loadConfig({ ...environment, VITE_NATIVE_BALANCE_ITEM_COST: "1235" }),
    ).toThrow(/pinned runtime/);
  });
});
