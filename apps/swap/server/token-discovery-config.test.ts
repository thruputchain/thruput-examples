// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadDiscoveryConfig } from "../src/token-discovery/config.ts";
import { loadTokenDiscoveryServerConfig } from "./token-discovery-config.ts";

const env = {
  VITE_TOKEN_DISCOVERY_ENABLED: "true",
  VITE_GROUNDHOG_NETWORK_ID: `0x${"AB".repeat(32)}`,
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"CD".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: "EF".repeat(32),
  TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "https://REGISTRY.example.test:443/",
};

describe("token discovery configuration", () => {
  it("defaults off and does not implicitly enable valid unused settings", () => {
    expect(loadDiscoveryConfig({})).toEqual({
      enabled: false,
      factoryAddress: "",
      tokenCodeHash: "",
      scope: null,
    });
    expect(loadTokenDiscoveryServerConfig({})).toBeNull();
    expect(
      loadTokenDiscoveryServerConfig({
        ...env,
        VITE_TOKEN_DISCOVERY_ENABLED: "false",
      }),
    ).toBeNull();
  });
  it("normalizes the public scope independently of the AMM factory", () => {
    expect(
      loadTokenDiscoveryServerConfig({
        ...env,
        VITE_SWAP_FACTORY_ADDRESS: `0x${"12".repeat(32)}`,
      }),
    ).toEqual({
      origin: "https://registry.example.test",
      scope: {
        networkId: "ab".repeat(32),
        factoryAddress: `0x${"cd".repeat(32)}`,
        tokenCodeHash: `0x${"ef".repeat(32)}`,
      },
    });
  });
  it.each([
    "VITE_GROUNDHOG_NETWORK_ID",
    "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
    "VITE_STANDARD_TOKEN_HASH",
    "TOKEN_DISCOVERY_UPSTREAM_ORIGIN",
  ])("requires enabled %s", (key) => {
    expect(() =>
      loadTokenDiscoveryServerConfig({ ...env, [key]: undefined }),
    ).toThrow();
  });
  it.each(["", "TRUE", "1"])("rejects boolean %s", (value) => {
    expect(() =>
      loadDiscoveryConfig({ VITE_TOKEN_DISCOVERY_ENABLED: value }),
    ).toThrow(/VITE_TOKEN_DISCOVERY_ENABLED/);
  });
  it.each(["VITE_STANDARD_TOKEN_FACTORY_ADDRESS", "VITE_STANDARD_TOKEN_HASH"])(
    "validates unused %s",
    (key) => {
      expect(() => loadDiscoveryConfig({ [key]: "invalid" })).toThrow(key);
    },
  );
  it("rejects zero factories", () => {
    expect(() =>
      loadDiscoveryConfig({
        ...env,
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"00".repeat(32)}`,
      }),
    ).toThrow(/nonzero/);
  });

  it.each([
    "VITE_GROUNDHOG_NETWORK_ID",
    "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
    "VITE_STANDARD_TOKEN_HASH",
  ] as const)("rejects trailing whitespace in %s", (key) => {
    expect(() =>
      loadTokenDiscoveryServerConfig({ ...env, [key]: `${env[key]}\n` }),
    ).toThrow();
  });
  it.each([
    "https://registry.test",
    "http://localhost:5173/",
    "http://127.0.0.1:5173",
    "http://[::1]:5173/",
  ])("accepts %s", (value) => {
    expect(
      loadTokenDiscoveryServerConfig({
        ...env,
        TOKEN_DISCOVERY_UPSTREAM_ORIGIN: value,
      })?.origin,
    ).toBe(new URL(value).origin);
  });
  it.each([
    "http://registry.test",
    "http://127.1",
    "http://2130706433",
    "http://localhost.",
    "//registry.test",
    "ftp://registry.test",
    "https://registry.test/api",
    "https://registry.test/a/..",
    "https://registry.test/%2e/",
    "https://registry.test/?",
    "https://registry.test/#",
    "https://user:secret@registry.test",
    "https://@registry.test",
    "https://registry.test\\",
    "https://reg\tistry.test",
    "https://registry.test/\n",
  ])("rejects even unused %s without reflecting it", (value) => {
    const operation = () =>
      loadTokenDiscoveryServerConfig({
        TOKEN_DISCOVERY_UPSTREAM_ORIGIN: value,
      });
    expect(operation).toThrow(/TOKEN_DISCOVERY_UPSTREAM_ORIGIN/);
    expect(operation).not.toThrow(value);
  });
});
