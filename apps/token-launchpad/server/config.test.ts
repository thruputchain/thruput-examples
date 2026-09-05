// @vitest-environment node

import { describe, expect, it } from "vitest";

import { loadServerConfig, ServerConfigurationError } from "./config.ts";

const environment = {
  PORT: "3000",
  TOKEN_REGISTRY_DB_PATH: "/data/registry.sqlite",
  VITE_GROUNDHOG_RPC_URL: "https://rpc.example.test/path",
  VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"BB".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: "cc".repeat(32),
};

describe("loadServerConfig", () => {
  it("parses and canonicalizes the complete server configuration", () => {
    const config = loadServerConfig(environment);

    expect(config).toMatchObject({
      port: 3000,
      databasePath: "/data/registry.sqlite",
      syncIntervalMs: 5_000,
      pageSize: 200,
      scope: {
        networkId: "aa".repeat(32),
        factoryAddress: `0x${"bb".repeat(32)}`,
        tokenCodeHash: `0x${"cc".repeat(32)}`,
      },
    });
    expect(config.rpcUrl.href).toBe("https://rpc.example.test/path");
  });

  it("accepts bounded optional values", () => {
    const config = loadServerConfig({
      ...environment,
      TOKEN_REGISTRY_SYNC_INTERVAL_MS: "1000",
      TOKEN_REGISTRY_PAGE_SIZE: "500",
      PORT: "65535",
    });
    expect(config.syncIntervalMs).toBe(1_000);
    expect(config.pageSize).toBe(500);
    expect(config.port).toBe(65_535);
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "1.5"],
    ["TOKEN_REGISTRY_SYNC_INTERVAL_MS", "999"],
    ["TOKEN_REGISTRY_PAGE_SIZE", "501"],
    ["VITE_GROUNDHOG_NETWORK_ID", "abc"],
    ["VITE_STANDARD_TOKEN_FACTORY_ADDRESS", "11".repeat(32)],
    ["VITE_STANDARD_TOKEN_HASH", "zz".repeat(32)],
    ["VITE_GROUNDHOG_RPC_URL", "ftp://rpc.example.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://user:secret@rpc.example.test"],
  ])("rejects invalid %s", (key, value) => {
    expect(() => loadServerConfig({ ...environment, [key]: value })).toThrow(
      ServerConfigurationError,
    );
  });

  it("rejects missing required values", () => {
    expect(() => loadServerConfig({ ...environment, PORT: undefined })).toThrow(
      /PORT is required/,
    );
  });
});
