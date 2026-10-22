import { toBase58 } from "@thruputchain/client";
import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "@/config";

const address = toBase58(new Uint8Array(32).fill(0x11));
const environment = {
  VITE_THRUPUT_RPC_URL: "http://127.0.0.1:9545",
  VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0x22)),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: address,
  VITE_NATIVE_TOKEN_ADDRESS: address,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_STANDARD_TOKEN_HASH: toBase58(new Uint8Array(32).fill(0x33)),
};

describe("loadConfig", () => {
  it("loads and validates the optional explorer origin", () => {
    expect(
      loadConfig({
        ...environment,
        VITE_EXPLORER_URL: "https://EXPLORER.example.test:443/",
      }).explorerUrl,
    ).toBe("https://explorer.example.test");
    expect(
      loadConfig({ ...environment, VITE_EXPLORER_URL: " " }).explorerUrl,
    ).toBeNull();
    expect(loadConfig(environment).explorerUrl).toBeNull();
    expect(() =>
      loadConfig({
        ...environment,
        VITE_EXPLORER_URL: "https://example.test/path",
      }),
    ).toThrow(/VITE_EXPLORER_URL/);
  });
  it("parses trusted launchpad settings", () => {
    const config = loadConfig(environment);
    expect(config.swapAppUrl).toBeNull();
    expect(config.nativeBalanceItemCost).toBe(1234n);
    expect(config.networkId).toBe(toBase58(new Uint8Array(32).fill(0x22)));
    expect(config.accountAddress).toEqual(new Uint8Array(32));
    expect(
      loadConfig({
        ...environment,
        VITE_THRUPUT_WALLET_ADDRESS: "not-a-wallet",
      }).accountAddress,
    ).toEqual(new Uint8Array(32));
  });

  it("loads an optional Swap origin independently of the token registry", () => {
    const config = loadConfig({
      ...environment,
      VITE_SWAP_APP_URL: "https://SWAP.example.test/",
    });
    expect(config.swapAppUrl).toBe("https://swap.example.test");
    expect(() =>
      loadConfig({
        ...environment,
        VITE_SWAP_APP_URL: "https://swap.example.test/pools",
      }),
    ).toThrow(/VITE_SWAP_APP_URL/);
  });

  it("rejects credentials in the RPC URL", () => {
    expect(() =>
      loadConfig({
        ...environment,
        VITE_THRUPUT_RPC_URL: "http://user:secret@127.0.0.1:9545",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects a balance-item cost from another runtime", () => {
    expect(() =>
      loadConfig({ ...environment, VITE_NATIVE_BALANCE_ITEM_COST: "1235" }),
    ).toThrow(/pinned runtime/);
  });
});
